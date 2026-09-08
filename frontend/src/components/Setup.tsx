import { useEffect, useRef, useState } from 'react'
import { bootstrap, createSavedSearch, deleteSavedSearch, listOllamaModels, listSavedSearches } from '../api'
import type { SavedSearch } from '../api'
import { deleteSavedChat, loadSavedChats } from '../chatStorage'
import type { AgentConfig, AgentTemplateId, BootstrapStreamEvent, LlmProvider, ModelAttempt, SavedChat } from '../types'
import styles from '../styles/Setup.module.css'

// Each template controls both the purpose text sent to bootstrap (which
// determines what tools/behaviour Claude designs) and what the keyword
// chips mean in that context. `search_jobs` (live Adzuna listings) and
// `fetch_page` (general web fetch) are the two built-in primitives every
// agent gets — see backend/src/agent_stream.py — so "Job search" leans on
// the former, "Research" the latter, and "General" leaves it up to bootstrap.
interface AgentTemplate {
  id: AgentTemplateId
  label: string
  keywordPlaceholder: string
  buildPurpose: (keywords: string[], location: string) => string
}

const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'research',
    label: 'Research agent',
    keywordPlaceholder: 'Type a keyword, press Enter…',
    buildPurpose: (keywords, loc) =>
      `Research agent for the following keywords: ${keywords.join(', ')}` +
      `${loc ? ` in ${loc}` : ''}. ` +
      `Search for relevant information, analyse patterns and trends, ` +
      `and present clear findings for each keyword.`,
  },
  {
    id: 'job_search',
    label: 'Job search agent',
    keywordPlaceholder: 'Type a job title or skill, press Enter…',
    buildPurpose: (keywords, loc) =>
      `Job search agent for the following roles or skills: ${keywords.join(', ')}` +
      `${loc ? ` in ${loc}` : ''}. ` +
      `Search live job listings, compare requirements and salary across postings, ` +
      `and present clear, ranked findings for each role or skill.`,
  },
  {
    id: 'general',
    label: 'General assistant',
    keywordPlaceholder: 'Type a topic, press Enter…',
    buildPurpose: (keywords, loc) =>
      `General-purpose assistant covering the following topics: ${keywords.join(', ')}` +
      `${loc ? ` (relevant to ${loc})` : ''}. ` +
      `Decide what information or tools each topic needs and present clear, ` +
      `well-organised findings.`,
  },
]

function getTemplate(id: AgentTemplateId | undefined): AgentTemplate {
  return AGENT_TEMPLATES.find(t => t.id === id) ?? AGENT_TEMPLATES[0]
}

function formatSavedAt(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

function formatModelLabel(config: AgentConfig): string {
  if (config.provider === 'ollama') {
    return `Local (Ollama${config.ollama_model ? `: ${config.ollama_model}` : ''})`
  }
  if (config.provider === 'gemini') return 'Cloud (Gemini)'
  return 'Auto (cloud → local)'
}

interface ModelInfo {
  used: ModelAttempt | null
  failed: ModelAttempt[]
}

function formatModelInfo({ used, failed }: ModelInfo): string {
  const failedNames = failed.map(f => `${f.provider}:${f.model}`)
  if (used) {
    const usedName = `${used.provider}:${used.model}`
    return failedNames.length > 0
      ? `Model: ${usedName} (fell back from ${failedNames.join(', ')})`
      : `Model: ${usedName}`
  }
  return failedNames.length > 0
    ? `Model attempt failed: ${failedNames.join(', ')}`
    : 'Model: unknown'
}

interface Props {
  agentName: string
  onAgentNameChange: (name: string) => void
  onNewAgent: () => void
  bootstrapping: boolean
  error: string | null
  onStart: () => void
  onDone: (config: AgentConfig) => void
  onError: (msg: string) => void
  onResumeChat: (chat: SavedChat) => void
}

export default function Setup({ agentName, onAgentNameChange, onNewAgent, bootstrapping, error, onStart, onDone, onError, onResumeChat }: Props) {
  const [agentType, setAgentType] = useState<AgentTemplateId>('research')
  const [keywords, setKeywords] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [location, setLocation] = useState('Melbourne, Australia')
  const [provider, setProvider] = useState<LlmProvider>(null)
  const [ollamaModel, setOllamaModel] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [saved, setSaved] = useState<SavedSearch[]>([])
  // Saved searches live server-side now (see backend/src/saved_searches.py) —
  // fetch once on mount rather than reading localStorage synchronously.
  useEffect(() => {
    listSavedSearches().then(setSaved)
  }, [])
  // Only show saved searches that match the currently selected agent type —
  // a "Job search agent" list of keywords isn't a useful preset when you're
  // building a "Research agent". Pre-existing saves have no agentType and
  // are treated as 'research'.
  const visibleSaved = saved.filter(s => (s.agentType ?? 'research') === agentType)
  const [savedChats, setSavedChats] = useState<SavedChat[]>(loadSavedChats)
  const visibleSavedChats = savedChats.filter(c => (c.agentConfig.template ?? 'research') === agentType)
  const [progress, setProgress] = useState<string | null>(null)
  const [toolsSoFar, setToolsSoFar] = useState<string[]>([])
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([])
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const locationDebounceRef = useRef<number | undefined>(undefined)
  const locationAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (provider !== 'ollama' || modelsLoaded) return
    listOllamaModels().then(models => {
      setAvailableModels(models)
      setModelsLoaded(true)
      if (models.length > 0) setOllamaModel(prev => prev ?? models[0])
    })
  }, [provider, modelsLoaded])

  useEffect(() => {
    return () => {
      window.clearTimeout(locationDebounceRef.current)
      locationAbortRef.current?.abort()
    }
  }, [])

  // Free, keyless geocoding via OpenStreetMap Nominatim — matches this
  // workspace's "no API key for this" pattern (e.g. ChattyPrayers.Api's
  // Open-Meteo weather context). Debounced to respect Nominatim's ~1 req/sec
  // usage policy; only fires past 3 characters.
  async function fetchLocationSuggestions(query: string) {
    locationAbortRef.current?.abort()
    const controller = new AbortController()
    locationAbortRef.current = controller
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=5&q=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      )
      if (!res.ok) return
      const data = await res.json()
      const names: string[] = Array.isArray(data)
        ? data.map((d: { display_name?: string }) => d.display_name).filter((n): n is string => Boolean(n))
        : []
      setLocationSuggestions(names)
      setShowLocationSuggestions(true)
    } catch {
      // Aborted (superseded by a newer keystroke) or offline — free-text
      // location still works fine without a suggestion.
    }
  }

  function handleLocationChange(value: string) {
    setLocation(value)
    window.clearTimeout(locationDebounceRef.current)
    const query = value.trim()
    if (query.length < 3) {
      setLocationSuggestions([])
      setShowLocationSuggestions(false)
      return
    }
    locationDebounceRef.current = window.setTimeout(() => fetchLocationSuggestions(query), 400)
  }

  function selectLocation(name: string) {
    setLocation(name)
    setLocationSuggestions([])
    setShowLocationSuggestions(false)
  }

  function addKeyword() {
    const kw = draft.trim()
    if (!kw || keywords.map(k => k.toLowerCase()).includes(kw.toLowerCase())) return
    const next = [...keywords, kw]
    setKeywords(next)
    setDraft('')
    inputRef.current?.focus()
  }

  function removeKeyword(kw: string) {
    setKeywords(prev => prev.filter(k => k !== kw))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); addKeyword() }
    if (e.key === 'Backspace' && !draft && keywords.length > 0) {
      setKeywords(prev => prev.slice(0, -1))
    }
  }

  async function saveSearch() {
    if (keywords.length === 0) return
    const name = keywords.join(', ')
    try {
      const entry = await createSavedSearch(name, [...keywords], agentType)
      // Same keywords saved under a different agent type is a distinct entry;
      // only collapse an exact (keywords, type) repeat — the backend does the
      // same collapse, this just keeps local state in sync with it.
      setSaved(prev => [entry, ...prev.filter(s => !(s.name === entry.name && s.agentType === entry.agentType))])
    } catch {
      // Backend unreachable — the search just isn't saved; nothing else to do here.
    }
  }

  function loadSearch(entry: SavedSearch) {
    setAgentType(entry.agentType ?? 'research')
    setKeywords([...entry.keywords])
    setDraft('')
    inputRef.current?.focus()
  }

  function deleteSearch(id: string) {
    setSaved(prev => prev.filter(s => s.id !== id))
    deleteSavedSearch(id).catch(() => {})
  }

  // Tapping the row repopulates the query form with the settings that
  // produced this chat — same idea as "Saved searches" — for starting a
  // fresh run with the same setup. The → button next to it instead jumps
  // straight back into that old conversation (App.tsx's onResumeChat).
  function loadSavedChatQuery(chat: SavedChat) {
    const { keywords: kws, location: loc, provider: prov, ollama_model: model, template } = chat.agentConfig
    setAgentType(template ?? 'research')
    setKeywords(kws ? [...kws] : [])
    setDraft('')
    if (loc) setLocation(loc)
    setProvider(prov ?? null)
    setOllamaModel(model ?? null)
    onAgentNameChange(chat.agentName)
    inputRef.current?.focus()
  }

  function removeSavedChat(id: string) {
    setSavedChats(deleteSavedChat(id))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (keywords.length === 0 || bootstrapping) return
    const loc = location.trim()
    const purpose = getTemplate(agentType).buildPurpose(keywords, loc)
    onStart()
    setProgress(null)
    setToolsSoFar([])
    setModelInfo(null)
    function handleProgress(event: BootstrapStreamEvent) {
      if (event.type === 'status') setProgress(event.message)
      else if (event.type === 'tool') setToolsSoFar(prev => [...prev, event.name])
      else if (event.type === 'model') setModelInfo({ used: event.used, failed: event.failed })
    }
    try {
      const config = await bootstrap(
        purpose,
        provider,
        provider === 'ollama' ? ollamaModel : null,
        handleProgress,
      )
      onDone({ ...config, keywords, location: loc, provider, ollama_model: provider === 'ollama' ? ollamaModel : null, template: agentType })
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Agent {agentName}</h1>
        <p className={styles.subtitle}>Add keywords, then deploy Agent {agentName}.</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.agentTypeRow}>
            <span className={styles.locationLabel}>Agent type</span>
            <div className={styles.agentTypePills} role="radiogroup" aria-label="Agent type">
              {AGENT_TEMPLATES.map(t => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={agentType === t.id}
                  className={`${styles.agentTypePill} ${agentType === t.id ? styles.agentTypePillActive : ''}`}
                  onClick={() => setAgentType(t.id)}
                  disabled={bootstrapping}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.chipArea} onClick={() => inputRef.current?.focus()}>
            {keywords.map(kw => (
              <span key={kw} className={styles.chip}>
                {kw}
                <button
                  type="button"
                  className={styles.chipX}
                  onClick={ev => { ev.stopPropagation(); removeKeyword(kw) }}
                  aria-label={`Remove ${kw}`}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              ref={inputRef}
              className={styles.chipInput}
              value={draft}
              onChange={e => setDraft(e.target.value.slice(0, 50))}
              onKeyDown={handleKeyDown}
              onBlur={() => { if (draft.trim()) addKeyword() }}
              placeholder={keywords.length === 0 ? getTemplate(agentType).keywordPlaceholder : 'Add another…'}
              disabled={bootstrapping}
              maxLength={50}
            />
          </div>

          {keywords.length > 0 && (
            <button
              type="button"
              className={styles.clearSmallBtn}
              onClick={() => {
                setKeywords([])
                setDraft('')
                inputRef.current?.focus()
              }}
              disabled={bootstrapping}
            >
              Clear keywords
            </button>
          )}

          <div className={styles.locationRow}>
            <span className={styles.locationLabel}>Location</span>
            <div className={styles.locationInputWrap}>
              <input
                className={styles.locationInput}
                value={location}
                onChange={e => handleLocationChange(e.target.value)}
                onFocus={() => { if (locationSuggestions.length > 0) setShowLocationSuggestions(true) }}
                onBlur={() => window.setTimeout(() => setShowLocationSuggestions(false), 150)}
                placeholder="e.g. Melbourne, Australia"
                disabled={bootstrapping}
                autoComplete="off"
              />
              {showLocationSuggestions && locationSuggestions.length > 0 && (
                <ul className={styles.locationSuggestions}>
                  {locationSuggestions.map(name => (
                    <li key={name} onMouseDown={() => selectLocation(name)}>
                      {name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className={styles.locationRow}>
            <span className={styles.locationLabel}>Model</span>
            <select
              className={styles.providerSelect}
              value={provider ?? ''}
              onChange={e => setProvider((e.target.value || null) as LlmProvider)}
              disabled={bootstrapping}
            >
              <option value="">Auto (cloud, falls back to local)</option>
              <option value="gemini">Cloud only (Gemini)</option>
              <option value="ollama">Local only (Ollama) — free, needs `ollama serve` running</option>
            </select>
          </div>
          {provider === 'ollama' && (
            <>
              <div className={styles.locationRow}>
                <span className={styles.locationLabel}>Local model</span>
                {availableModels.length > 0 ? (
                  <select
                    className={styles.providerSelect}
                    value={ollamaModel ?? ''}
                    onChange={e => setOllamaModel(e.target.value || null)}
                    disabled={bootstrapping}
                  >
                    {availableModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <select className={styles.providerSelect} disabled>
                    <option>{modelsLoaded ? 'No local models found' : 'Loading…'}</option>
                  </select>
                )}
              </div>
              <p className={styles.providerHint}>
                {availableModels.length > 0
                  ? 'Different local models vary a lot in tool-calling/JSON reliability — worth trying a few.'
                  : 'No pulled models detected — is `ollama serve` running? Try `ollama pull qwen2.5:7b`.'}
                {' '}Only works with `sam local` / the local dev server, not a deployed agent.
              </p>
            </>
          )}

          <div className={styles.hintRow}>
            <p className={styles.charHint}>
              {draft.length > 0
                ? `${50 - draft.length} chars remaining`
                : `${keywords.length} keyword${keywords.length !== 1 ? 's' : ''} added`}
            </p>
            {keywords.length > 0 && (
              <div className={styles.hintActions}>
                <button
                  type="button"
                  className={styles.saveSmallBtn}
                  onClick={saveSearch}
                  disabled={bootstrapping}
                >
                  Save Search
                </button>
                <button
                  type="button"
                  className={styles.clearSmallBtn}
                  onClick={() => {
                    setKeywords([])
                    setDraft('')
                    onNewAgent()
                    inputRef.current?.focus()
                  }}
                  disabled={bootstrapping}
                >
                  New Agent
                </button>
              </div>
            )}
          </div>

          {visibleSaved.length > 0 && (
            <div className={styles.savedSection}>
              <p className={styles.savedHeading}>Saved searches - {getTemplate(agentType).label}</p>
              <div className={styles.savedList}>
                {visibleSaved.map(s => (
                  <div key={s.id} className={styles.savedRow} onClick={() => loadSearch(s)}>
                    <div className={styles.savedChips}>
                      {s.keywords.map(kw => (
                        <span key={kw} className={styles.savedChip}>{kw}</span>
                      ))}
                    </div>
                    <button
                      type="button"
                      className={styles.savedDelete}
                      onClick={ev => { ev.stopPropagation(); deleteSearch(s.id) }}
                      aria-label="Delete saved search"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {visibleSavedChats.length > 0 && (
            <div className={styles.savedSection}>
              <p className={styles.savedHeading}>Saved chats - {getTemplate(agentType).label}</p>
              <div className={`${styles.savedList} ${styles.savedListScroll}`}>
                {visibleSavedChats.map(c => (
                  <div
                    key={c.id}
                    className={styles.savedRow}
                    onClick={() => loadSavedChatQuery(c)}
                    title={c.agentConfig.purpose}
                  >
                    <div className={styles.savedChatInfo}>
                      <span className={styles.savedChatName}>Agent {c.agentName}</span>
                      {c.agentConfig.keywords?.length ? (
                        <div className={styles.savedChips}>
                          {c.agentConfig.keywords.map(kw => (
                            <span key={kw} className={styles.savedChip}>{kw}</span>
                          ))}
                        </div>
                      ) : (
                        <span className={styles.savedChatMeta}>No keywords saved</span>
                      )}
                      <span className={styles.savedChatMeta}>
                        {c.agentConfig.location || 'No location'} · {formatModelLabel(c.agentConfig)} ·{' '}
                        {c.messages.length} message{c.messages.length !== 1 ? 's' : ''} · {formatSavedAt(c.savedAt)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.savedResume}
                      onClick={ev => { ev.stopPropagation(); onResumeChat(c) }}
                      aria-label={`Continue chat with Agent ${c.agentName}`}
                      title="Continue this chat"
                    >
                      →
                    </button>
                    <button
                      type="button"
                      className={styles.savedDelete}
                      onClick={ev => { ev.stopPropagation(); removeSavedChat(c.id) }}
                      aria-label="Delete saved chat"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.createBtn}
              disabled={bootstrapping || keywords.length === 0}
            >
              {bootstrapping ? 'Configuring agent…' : 'Commission Agent'}
            </button>
          </div>
        </form>

        {(bootstrapping || modelInfo || error) && (
          <div className={styles.loadingHint}>
            {modelInfo && (
              <p className={styles.modelInfoLine}>{formatModelInfo(modelInfo)}</p>
            )}
            {bootstrapping ? (
              <>
                <p>
                  {progress ??
                    (provider === 'ollama'
                      ? `${ollamaModel ?? 'Your local model'} is designing your agent's tools and behaviour. This may take longer than the cloud default.`
                      : 'Designing your agent\'s tools and behaviour…')}
                </p>
                {toolsSoFar.length > 0 && (
                  <ul className={styles.loadingTools}>
                    {toolsSoFar.map(name => (
                      <li key={name}>✓ {name}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : error ? (
              <p className={styles.error}>{error}</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

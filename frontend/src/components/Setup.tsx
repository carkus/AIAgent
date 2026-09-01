import { useEffect, useRef, useState } from 'react'
import { bootstrap, listOllamaModels } from '../api'
import { deleteSavedChat, loadSavedChats } from '../chatStorage'
import type { AgentConfig, BootstrapStreamEvent, LlmProvider, ModelAttempt, SavedChat } from '../types'
import styles from '../styles/Setup.module.css'

function formatSavedAt(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
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
  bootstrapping: boolean
  error: string | null
  onStart: () => void
  onDone: (config: AgentConfig) => void
  onError: (msg: string) => void
  onLoadChat: (chat: SavedChat) => void
}

const STORAGE_KEY = 'aiagent_saved_searches'

interface SavedSearch {
  id: string
  name: string
  keywords: string[]
}

function loadSaved(): SavedSearch[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveToDisk(searches: SavedSearch[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(searches))
}

export default function Setup({ agentName, bootstrapping, error, onStart, onDone, onError, onLoadChat }: Props) {
  const [keywords, setKeywords] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [location, setLocation] = useState('Melbourne, Australia')
  const [provider, setProvider] = useState<LlmProvider>(null)
  const [ollamaModel, setOllamaModel] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [saved, setSaved] = useState<SavedSearch[]>(loadSaved)
  const [savedChats, setSavedChats] = useState<SavedChat[]>(loadSavedChats)
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

  function saveSearch() {
    if (keywords.length === 0) return
    const entry: SavedSearch = {
      id: Date.now().toString(),
      name: keywords.join(', '),
      keywords: [...keywords],
    }
    const updated = [entry, ...saved.filter(s => s.name !== entry.name)]
    setSaved(updated)
    saveToDisk(updated)
  }

  function loadSearch(entry: SavedSearch) {
    setKeywords([...entry.keywords])
    setDraft('')
    inputRef.current?.focus()
  }

  function deleteSearch(id: string) {
    const updated = saved.filter(s => s.id !== id)
    setSaved(updated)
    saveToDisk(updated)
  }

  function removeSavedChat(id: string) {
    setSavedChats(deleteSavedChat(id))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (keywords.length === 0 || bootstrapping) return
    const loc = location.trim()
    const purpose =
      `Research agent for the following keywords: ${keywords.join(', ')}` +
      `${loc ? ` in ${loc}` : ''}. ` +
      `Search for relevant information, analyse patterns and trends, ` +
      `and present clear findings for each keyword.`
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
      onDone({ ...config, keywords, location: loc, provider, ollama_model: provider === 'ollama' ? ollamaModel : null })
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
              placeholder={keywords.length === 0 ? 'Type a keyword, press Enter…' : 'Add another…'}
              disabled={bootstrapping}
              maxLength={50}
            />
          </div>

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
                  Save
                </button>
                <button
                  type="button"
                  className={styles.clearSmallBtn}
                  onClick={() => { setKeywords([]); setDraft(''); inputRef.current?.focus() }}
                  disabled={bootstrapping}
                >
                  Clear all
                </button>
              </div>
            )}
          </div>

          {saved.length > 0 && (
            <div className={styles.savedSection}>
              <p className={styles.savedHeading}>Saved searches</p>
              <div className={styles.savedList}>
                {saved.map(s => (
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

          {savedChats.length > 0 && (
            <div className={styles.savedSection}>
              <p className={styles.savedHeading}>Saved chats</p>
              <div className={styles.savedList}>
                {savedChats.map(c => (
                  <div
                    key={c.id}
                    className={styles.savedRow}
                    onClick={() => onLoadChat(c)}
                    title={c.agentConfig.purpose}
                  >
                    <div className={styles.savedChatInfo}>
                      <span className={styles.savedChatName}>Agent {c.agentName}</span>
                      <span className={styles.savedChatMeta}>
                        {c.messages.length} message{c.messages.length !== 1 ? 's' : ''} · {formatSavedAt(c.savedAt)}
                      </span>
                    </div>
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

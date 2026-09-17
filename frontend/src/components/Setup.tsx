import { useEffect, useRef, useState } from 'react'
import { bootstrap, createSavedSearch, deleteSavedSearch, listOllamaModels, listPublishedAgents, listSavedSearches, unpublishAgent } from '../api'
import type { PublishedAgent, SavedSearch } from '../api'
import { deleteSavedChat, loadSavedChats } from '../chatStorage'
import type { AgentConfig, AgentTemplateId, BootstrapStreamEvent, LlmProvider, ModelAttempt, SavedChat } from '../types'
import styles from '../styles/Setup.module.css'
import splashLogo from '../assets/splash_logo.png'
import SettingsModal from './SettingsModal'

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

// Mono line icons matching the app's stroke-based visual style — plain
// geometric shapes (magnifier / briefcase / compass), not emoji, so they
// pick up the pill's currentColor and stay crisp at any size.
function AgentTypeIcon({ id }: { id: AgentTemplateId }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  if (id === 'job_search') {
    return (
      <svg {...common}>
        <rect x="2.5" y="7" width="19" height="13.5" rx="2" />
        <path d="M8 7V5.5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2V7" />
        <line x1="2.5" y1="13" x2="21.5" y2="13" />
      </svg>
    )
  }
  if (id === 'general') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9.25" />
        <polygon points="15.5 8.5 13.2 13.2 8.5 15.5 10.8 10.8 15.5 8.5" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="10.5" cy="10.5" r="7" />
      <line x1="20.5" y1="20.5" x2="15.8" y2="15.8" />
    </svg>
  )
}

const AGENT_TEMPLATES: AgentTemplate[] = [
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
  {
    id: 'research',
    label: 'Researcher',
    keywordPlaceholder: 'Type a keyword, press Enter…',
    buildPurpose: (keywords, loc) =>
      `Research agent for the following keywords: ${keywords.join(', ')}` +
      `${loc ? ` in ${loc}` : ''}. ` +
      `Search for relevant information, analyse patterns and trends, ` +
      `and present clear findings for each keyword.`,
  },
  {
    id: 'job_search',
    label: 'Job search',
    keywordPlaceholder: 'Type a job title or skill, press Enter…',
    buildPurpose: (keywords, loc) =>
      `Job search agent for the following roles or skills: ${keywords.join(', ')}` +
      `${loc ? ` in ${loc}` : ''}. ` +
      `Search live job listings, compare requirements and salary across postings, ` +
      `and present clear, ranked findings for each role or skill.`,
  },
]

function getTemplate(id: AgentTemplateId | undefined): AgentTemplate {
  return AGENT_TEMPLATES.find(t => t.id === id) ?? AGENT_TEMPLATES[0]
}

function joinNatural(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function buildAgentBrief(agentType: AgentTemplateId, keywords: string[], loc: string, agentName: string): string {
  const topics = joinNatural(keywords)
  const beat = loc ? ` in ${loc}` : ''
  const name = `Agent ${agentName}`
  switch (agentType) {
    case 'research':
      return `${name} reads these specialties as a mandate to research and analyze ${topics}${beat}. If commissioned, it will search, cross-reference sources, and report back with findings and key data points.`
    case 'job_search':
      return `${name} reads these specialties as a mandate to find roles in ${topics}${beat}. If commissioned, it will search listings, screen them against your criteria, and report back the strongest matches.`
    default:
      return `${name} reads these specialties as a mandate to track ${topics}${beat}. If commissioned, it will monitor developments and report back on what's most relevant.`
  }
}

type SavedSectionId = 'searches' | 'chats' | 'mcp'

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
  // Published agents — the MCP server's tool catalog (backend/mcp_server.py
  // reads backend/src/agent_registry.py). Shown here, not scoped by agent
  // type, so the user can see/manage everything currently externally
  // callable in one place.
  const [publishedAgents, setPublishedAgents] = useState<PublishedAgent[]>([])
  useEffect(() => {
    listPublishedAgents().then(setPublishedAgents)
  }, [])
  function removePublishedAgent(id: string) {
    setPublishedAgents(prev => prev.filter(a => a.id !== id))
    unpublishAgent(id).catch(() => {})
  }
  // Only show saved searches that match the currently selected agent type —
  // a "Job search agent" list of keywords isn't a useful preset when you're
  // building a "Research agent". Pre-existing saves have no agentType and
  // are treated as 'research'.
  const visibleSaved = saved.filter(s => (s.agentType ?? 'research') === agentType)
  const [savedChats, setSavedChats] = useState<SavedChat[]>(loadSavedChats)
  const visibleSavedChats = savedChats.filter(c => (c.agentConfig.template ?? 'research') === agentType)
  const [openSavedSections, setOpenSavedSections] = useState<Record<SavedSectionId, boolean>>({
    searches: true,
    chats: false,
    mcp: false,
  })
  const [progress, setProgress] = useState<string | null>(null)
  const [toolsSoFar, setToolsSoFar] = useState<string[]>([])
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([])
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const [locationDetecting, setLocationDetecting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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

  // Browser geolocation + the same Nominatim host, just its reverse-geocode
  // endpoint (coords -> place name) instead of the forward one above. `force`
  // distinguishes the auto-run-on-mount call (only replaces the untouched
  // 'Melbourne, Australia' default) from the Settings screen's "Detect my
  // location" button (always overwrites, since the user explicitly asked).
  function detectLocation(force: boolean) {
    if (!navigator.geolocation) return
    setLocationDetecting(true)
    navigator.geolocation.getCurrentPosition(
      async pos => {
        try {
          const { latitude, longitude } = pos.coords
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10&addressdetails=0`,
          )
          if (res.ok) {
            const data = await res.json()
            const name: string | undefined = data?.display_name
            if (name) setLocation(prev => (force || prev === 'Melbourne, Australia' ? name : prev))
          }
        } catch {
          // Offline or Nominatim unreachable — keep whatever location is set.
        } finally {
          setLocationDetecting(false)
        }
      },
      () => setLocationDetecting(false),
      { timeout: 8000 },
    )
  }

  useEffect(() => {
    detectLocation(false)
    // Mount-only: auto-detect once, falling back to the 'Melbourne, Australia' default on denial/failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addKeyword() {
    if (bootstrapping) return
    const kw = draft.trim()
    if (!kw || keywords.map(k => k.toLowerCase()).includes(kw.toLowerCase())) return
    const next = [...keywords, kw]
    setKeywords(next)
    setDraft('')
    inputRef.current?.focus()
  }

  function removeKeyword(kw: string) {
    if (bootstrapping) return
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

  // Keywords are scoped to one agent type (visibleSaved/visibleSavedChats
  // already filter by it) — switching type manually clears them rather than
  // carrying over keywords that don't apply to the new type; loadSearch/
  // loadSavedChatQuery below set their own keywords right after switching
  // type, so they don't go through this.
  function handleAgentTypeChange(type: AgentTemplateId) {
    setAgentType(type)
    setKeywords([])
    setDraft('')
  }

  function toggleSavedSection(section: SavedSectionId) {
    setOpenSavedSections(prev => ({ ...prev, [section]: !prev[section] }))
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
        agentType,
      )
      onDone({ ...config, keywords, location: loc, provider, ollama_model: provider === 'ollama' ? ollamaModel : null, template: agentType })
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <button
          type="button"
          className={styles.settingsIconBtn}
          onClick={() => setSettingsOpen(true)}
          aria-haspopup="dialog"
          aria-label="Settings"
          title="Settings"
        >
          ⚙
        </button>
        <img src={splashLogo} alt="Agent One" className={styles.brandLogo} />

        <div className={styles.agentCard}>
          <div className={styles.agentCardMain}>
            <div className={styles.agentCardInfo}>
              <h1 className={styles.title}>Agent {agentName}</h1>
              <p className={styles.locationLiner}>📍 {location || 'No location set'}</p>
              <p className={styles.agentTypeLiner}>{getTemplate(agentType).label}</p>
            </div>
            <div className={styles.agentTypePills} role="radiogroup" aria-label="Agent type">
              {AGENT_TEMPLATES.map(t => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={agentType === t.id}
                  aria-label={t.label}
                  title={t.label}
                  className={`${styles.agentTypePill} ${agentType === t.id ? styles.agentTypePillActive : ''}`}
                  onClick={() => handleAgentTypeChange(t.id)}
                  disabled={bootstrapping}
                >
                  <span className={styles.agentTypePillIcon} aria-hidden="true">
                    <AgentTypeIcon id={t.id} />
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.specialtiesRow}>
            <span className={styles.fieldLabel}><span aria-hidden="true">◆</span> Specialties</span>
            <div className={styles.chipArea} onClick={() => inputRef.current?.focus()}>
              {keywords.map(kw => (
                <span key={kw} className={styles.chip}>
                  {kw}
                  <button
                    type="button"
                    className={styles.chipX}
                    onClick={ev => { ev.stopPropagation(); removeKeyword(kw) }}
                    aria-label={`Remove ${kw}`}
                    disabled={bootstrapping}
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
              {keywords.length > 0 && (
                <span
                  className={styles.keywordTally}
                  title={`${keywords.length} keyword${keywords.length !== 1 ? 's' : ''} added`}
                  aria-hidden="true"
                >
                  {keywords.length}
                </span>
              )}
            </div>
          </div>

          <div className={styles.agentSummaryRow}>
            <span className={styles.fieldLabel}><span aria-hidden="true">◆</span> Brief</span>
            <p className={styles.agentSummaryText}>
              {keywords.length > 0
                ? buildAgentBrief(agentType, keywords, location.trim(), agentName)
                : 'Add specialties above to generate this agent’s brief.'}
            </p>
          </div>

          <div className={styles.profileActionsRow}>
            <p className={styles.charHint}>
              {draft.length > 0 ? `${50 - draft.length} chars remaining` : ''}
            </p>
            <div className={styles.profileActions}>
              {keywords.length > 0 && (
                <button
                  type="button"
                  className={styles.profileSaveBtn}
                  onClick={saveSearch}
                  disabled={bootstrapping}
                >
                  Save Agent
                </button>
              )}
              <button
                type="button"
                className={styles.profileResetBtn}
                onClick={() => {
                  setKeywords([])
                  setDraft('')
                  onNewAgent()
                  inputRef.current?.focus()
                }}
                disabled={bootstrapping}
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.dossierWrap}>
          <span className={styles.dossierTab} aria-hidden="true">Agent Dossier</span>
          <span className={styles.dossierStamp} aria-hidden="true">On file</span>
          <div className={styles.savedSectionsScroll}>

          <div className={styles.savedAccordion}>
            <div className={styles.savedSection}>
              <button
                type="button"
                className={styles.savedSectionHeader}
                aria-expanded={openSavedSections.searches}
                onClick={() => toggleSavedSection('searches')}
              >
                <span className={styles.savedSectionCaret} aria-hidden="true">
                  {openSavedSections.searches ? '▾' : '▸'}
                </span>
                <span className={styles.savedSectionTitle}>Select Specialties</span>
                <span className={styles.savedSectionCount}>{visibleSaved.length}</span>
              </button>
              {openSavedSections.searches && (
                <div className={styles.savedSectionBody}>
                  {visibleSaved.length > 0 ? (
                    <div className={styles.savedList}>
                      {visibleSaved.map(s => (
                        <div key={s.id} className={styles.savedRow} onClick={() => loadSearch(s)} title="Load these specialties">
                          <div className={styles.savedChips}>
                            {s.keywords.map(kw => (
                              <span key={kw} className={styles.savedChip}>{kw}</span>
                            ))}
                          </div>
                          <button
                            type="button"
                            className={styles.savedDelete}
                            onClick={ev => { ev.stopPropagation(); deleteSearch(s.id) }}
                            aria-label="Delete specialties"
                            title="Delete specialties"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.savedEmpty}>No specialties logged for {getTemplate(agentType).label} yet.</p>
                  )}
                </div>
              )}
            </div>

            <div className={styles.savedSection}>
              <button
                type="button"
                className={styles.savedSectionHeader}
                aria-expanded={openSavedSections.chats}
                onClick={() => toggleSavedSection('chats')}
              >
                <span className={styles.savedSectionCaret} aria-hidden="true">
                  {openSavedSections.chats ? '▾' : '▸'}
                </span>
                <span className={styles.savedSectionTitle}>Saved Agents</span>
                <span className={styles.savedSectionCount}>{visibleSavedChats.length}</span>
              </button>
              {openSavedSections.chats && (
                <div className={styles.savedSectionBody}>
                  {visibleSavedChats.length > 0 ? (
                    <div className={styles.savedList}>
                      {visibleSavedChats.map(c => (
                        <div
                          key={c.id}
                          className={styles.savedRow}
                          onClick={() => loadSavedChatQuery(c)}
                          title={c.agentConfig.purpose}
                        >
                          <div className={styles.savedChatInfo}>
                            <span className={styles.savedChatName}>Agent {c.agentName}</span>
                            {c.agentConfig.persona?.traits?.length ? (
                              <span className={styles.savedChatTraits}>
                                {c.agentConfig.persona.traits.join(' · ')}
                              </span>
                            ) : null}
                            {c.agentConfig.keywords?.length ? (
                              <div className={styles.savedChips}>
                                {c.agentConfig.keywords.map(kw => (
                                  <span key={kw} className={styles.savedChip}>{kw}</span>
                                ))}
                              </div>
                            ) : (
                              <span className={styles.savedChatMeta}>No directive on file</span>
                            )}
                            <span className={styles.savedChatMeta}>
                              {c.agentConfig.location || 'No location set'} · {formatModelLabel(c.agentConfig)} ·{' '}
                              {c.messages.length} exchange{c.messages.length !== 1 ? 's' : ''} logged · {formatSavedAt(c.savedAt)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.savedResume}
                            onClick={ev => { ev.stopPropagation(); onResumeChat(c) }}
                            aria-label={`Resume Agent ${c.agentName}`}
                            title="Resume this agent"
                          >
                            →
                          </button>
                          <button
                            type="button"
                            className={styles.savedDelete}
                            onClick={ev => { ev.stopPropagation(); removeSavedChat(c.id) }}
                            aria-label="Remove saved agent"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.savedEmpty}>No saved agents for {getTemplate(agentType).label} yet.</p>
                  )}
                </div>
              )}
            </div>

            <div className={styles.savedSection}>
              <button
                type="button"
                className={styles.savedSectionHeader}
                aria-expanded={openSavedSections.mcp}
                onClick={() => toggleSavedSection('mcp')}
              >
                <span className={styles.savedSectionCaret} aria-hidden="true">
                  {openSavedSections.mcp ? '▾' : '▸'}
                </span>
                <span className={styles.savedSectionTitle}>Agent Roster</span>
                <span className={styles.savedSectionCount}>{publishedAgents.length}</span>
              </button>
              {openSavedSections.mcp && (
                <div className={styles.savedSectionBody}>
                  {publishedAgents.length > 0 ? (
                    <div className={styles.savedList}>
                      {publishedAgents.map(a => (
                        <div key={a.id} className={styles.savedRow} title={a.description}>
                          <div className={styles.savedChatInfo}>
                            <span className={styles.savedChatName}>{a.name}</span>
                            <span className={styles.savedChatMeta}>
                              Callable as: {a.tool_name}{a.description ? ` · ${a.description}` : ''}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.savedDelete}
                            onClick={ev => { ev.stopPropagation(); removePublishedAgent(a.id) }}
                            aria-label={`Deactivate ${a.name}`}
                            title="Deactivate (stop exposing as an MCP tool)"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.savedEmpty}>No agents deployed to the roster yet — launch one from a chat.</p>
                  )}
                </div>
              )}
            </div>
          </div>
          </div>
          </div>

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

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        location={location}
        onLocationChange={handleLocationChange}
        locationSuggestions={locationSuggestions}
        showLocationSuggestions={showLocationSuggestions}
        onLocationFocus={() => { if (locationSuggestions.length > 0) setShowLocationSuggestions(true) }}
        onLocationBlur={() => window.setTimeout(() => setShowLocationSuggestions(false), 150)}
        onSelectLocation={selectLocation}
        onDetectLocation={() => detectLocation(true)}
        detectingLocation={locationDetecting}
        provider={provider}
        onProviderChange={setProvider}
        ollamaModel={ollamaModel}
        onOllamaModelChange={setOllamaModel}
        availableModels={availableModels}
        modelsLoaded={modelsLoaded}
        disabled={bootstrapping}
      />
    </div>
  )
}

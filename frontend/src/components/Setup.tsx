import { useEffect, useRef, useState } from 'react'
import { bootstrap, createAgentDraft, createSavedSearch, deleteAgentDraft, deleteSavedSearch, fetchAgentBrief, listAgentDrafts, listOllamaModels, listPublishedAgents, listSavedSearches, unpublishAgent } from '../api'
import type { AgentBrief, AgentDraft, PublishedAgent, SavedSearch } from '../api'
import { hideSavedChat, loadHiddenChatIds, loadSavedChats, saveChat } from '../chatStorage'
import type { AgentConfig, AgentTemplateId, BootstrapStreamEvent, LlmProvider, ModelAttempt, SavedChat, SearchDefaults } from '../types'
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

// Default when the user hasn't overridden it on the Settings screen — mirrors
// backend/src/agent_stream.py's MAX_DELEGATIONS_PER_REQUEST. One worker is
// delegated per specialty, capped per turn, so more specialties than this are
// silently dropped/starved rather than all covered.
const DEFAULT_MAX_DELEGATIONS = 6

// Deterministic warning check, used only when the AI-drafted brief (which
// does its own, richer warning assessment — see backend/src/brief.py)
// hasn't loaded or failed and we're falling back to buildAgentBrief()'s
// template. Only checks conditions cheap/certain enough to assert without
// an LLM call — the AI brief's own judgment always takes precedence when
// available, including its explicit choice not to warn.
function buildDeterministicWarning(keywords: string[], agentType: AgentTemplateId, loc: string, maxDelegations: number | null): string | null {
  const limit = maxDelegations ?? DEFAULT_MAX_DELEGATIONS
  if (keywords.length > limit) {
    return `${keywords.length} specialties is more than the ${limit} the agent can delegate to in one turn — some will be dropped or under-covered.`
  }
  if (agentType === 'job_search' && !loc) {
    return 'No location set — job listings will be searched without a geographic filter.'
  }
  return null
}

// Flavor traits for a saved agent *profile* (pre-bootstrap — there's no real
// persona yet, that's invented at bootstrap time). Deterministically picked
// from the agent's name so the same draft always shows the same "character"
// rather than re-rolling on every save, echoing the persona.traits shown for
// saved chats (a real bootstrapped agent) without pretending these are that.
const CHARACTER_TRAITS: Record<AgentTemplateId, string[]> = {
  research: ['Inquisitive', 'Meticulous', 'Analytical', 'Methodical', 'Curious'],
  job_search: ['Persistent', 'Sharp-eyed', 'Resourceful', 'Diligent', 'Discerning'],
  general: ['Adaptable', 'Practical', 'Attentive', 'Versatile', 'Observant'],
}

function pickCharacterTraits(agentType: AgentTemplateId, seed: string): string[] {
  const pool = CHARACTER_TRAITS[agentType] ?? CHARACTER_TRAITS.research
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  const first = hash % pool.length
  const second = (Math.floor(hash / pool.length)) % pool.length
  return second === first ? [pool[first]] : [pool[first], pool[second]]
}

type SavedSectionId = 'searches' | 'drafts' | 'chats' | 'mcp'

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
  // Persisted across "New agent"/reset (which fully remounts Setup — see
  // App.tsx's phase-conditional render) and page reloads, same
  // localStorage idiom as chatStorage.ts/aiagent_saved_chats — otherwise the
  // provider choice silently reverted to Auto (Gemini-first) on every new
  // agent, with no visible indicator on the main screen that it had reset.
  const [provider, setProvider] = useState<LlmProvider>(
    () => (localStorage.getItem('aiagent_provider') as LlmProvider) || null
  )
  const [ollamaModel, setOllamaModel] = useState<string | null>(
    () => localStorage.getItem('aiagent_ollama_model') || null
  )
  function handleProviderChange(p: LlmProvider) {
    setProvider(p)
    if (p) localStorage.setItem('aiagent_provider', p)
    else localStorage.removeItem('aiagent_provider')
  }
  function handleOllamaModelChange(m: string | null) {
    setOllamaModel(m)
    if (m) localStorage.setItem('aiagent_ollama_model', m)
    else localStorage.removeItem('aiagent_ollama_model')
  }
  // Same "standing preference across agents, not per-purpose content"
  // treatment as provider/ollamaModel above — these are platform-tuning
  // knobs (Settings screen), not something the bootstrap call should invent.
  const [maxDelegations, setMaxDelegations] = useState<number | null>(() => {
    const raw = localStorage.getItem('aiagent_max_delegations')
    return raw ? Number(raw) : null
  })
  function handleMaxDelegationsChange(n: number | null) {
    setMaxDelegations(n)
    if (n) localStorage.setItem('aiagent_max_delegations', String(n))
    else localStorage.removeItem('aiagent_max_delegations')
  }
  const [searchDefaults, setSearchDefaults] = useState<SearchDefaults>(() => {
    const raw = localStorage.getItem('aiagent_search_defaults')
    if (!raw) return {}
    try { return JSON.parse(raw) as SearchDefaults } catch { return {} }
  })
  function handleSearchDefaultsChange(d: SearchDefaults) {
    setSearchDefaults(d)
    if (Object.keys(d).length > 0) localStorage.setItem('aiagent_search_defaults', JSON.stringify(d))
    else localStorage.removeItem('aiagent_search_defaults')
  }
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [saved, setSaved] = useState<SavedSearch[]>([])
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null)
  // Shown next to the Commission Agent button when it's pressed with no
  // specialties (and therefore no brief) yet — cleared as soon as the user
  // adds one, so it never lingers stale.
  const [commissionHint, setCommissionHint] = useState<string | null>(null)
  useEffect(() => {
    if (keywords.length > 0) setCommissionHint(null)
  }, [keywords.length])
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
  // Saved agent profiles — the pre-bootstrap draft (name/type/location/
  // specialties + character traits) captured by "Save Agent" below. Distinct
  // from a saved search (keywords only) and a saved chat (a fully
  // bootstrapped agent with real conversation history) — see
  // backend/src/agent_drafts.py.
  const [drafts, setDrafts] = useState<AgentDraft[]>([])
  useEffect(() => {
    listAgentDrafts().then(setDrafts)
  }, [])
  // Saved chats — full bootstrapped conversations, client-side only (see
  // chatStorage.ts). Read once on mount like the other saved-* lists above;
  // resuming one skips bootstrap entirely (App.tsx's onResumeChat).
  const [savedChats, setSavedChats] = useState<SavedChat[]>(() => loadSavedChats())
  const chatFileInputRef = useRef<HTMLInputElement>(null)
  // Tucks a chat out of the dossier list without touching its underlying
  // localStorage entry — distinct from an actual delete.
  const [hiddenChatIds, setHiddenChatIds] = useState<string[]>(() => loadHiddenChatIds())
  const visibleChats = savedChats.filter(c => !hiddenChatIds.includes(c.id))
  // Only show saved searches that match the currently selected agent type —
  // a "Job search agent" list of keywords isn't a useful preset when you're
  // building a "Research agent". Pre-existing saves have no agentType and
  // are treated as 'research'.
  const visibleDrafts = drafts.filter(d => (d.agentType ?? 'research') === agentType)
  // Flattened, deduped, alphabetical pool of every keyword across every
  // saved search, shared by all three agent types — each one is its own
  // tap-to-add button rather than grouped by the entry it was originally
  // saved under or scoped to whichever type it was saved from.
  const savedKeywordPool = Array.from(
    new Set(saved.flatMap(s => s.keywords))
  ).sort((a, b) => a.localeCompare(b))
  const hasUnsavedSpecialties = keywords.some(
    kw => !savedKeywordPool.some(pooled => pooled.toLowerCase() === kw.toLowerCase())
  )
  const [openSavedSections, setOpenSavedSections] = useState<Record<SavedSectionId, boolean>>({
    searches: true,
    drafts: false,
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
  // The setup form and the dossier are both too tall to show fully at once
  // without crowding the page, so tapping into either one expands it to
  // ~70% height and collapses the other, at every viewport width (see
  // .focusStack in Setup.module.css).
  const [focusPanel, setFocusPanel] = useState<'setup' | 'dossier'>('setup')
  const [specialtiesOpen, setSpecialtiesOpen] = useState(true)
  const [briefOpen, setBriefOpen] = useState(true)
  const [specialInstructionsOpen, setSpecialInstructionsOpen] = useState(false)
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [aiBrief, setAiBrief] = useState<AgentBrief | null>(null)
  const [briefLoading, setBriefLoading] = useState(false)
  const [briefAnswer, setBriefAnswer] = useState('')
  const [answeringBrief, setAnsweringBrief] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const locationDebounceRef = useRef<number | undefined>(undefined)
  const locationAbortRef = useRef<AbortController | null>(null)
  const briefDebounceRef = useRef<number | undefined>(undefined)
  const briefRequestIdRef = useRef(0)

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

  // AI-drafted Brief (backend/src/brief.py) — debounced so it doesn't fire on
  // every keystroke while adding specialties. Falls back to the deterministic
  // buildAgentBrief() template (aiBrief stays null) on any failure, so a
  // network hiccup never leaves the Brief section blank. A stale response
  // from a superseded request is dropped via briefRequestIdRef.
  useEffect(() => {
    if (keywords.length === 0) {
      setAiBrief(null)
      setBriefLoading(false)
      return
    }
    window.clearTimeout(briefDebounceRef.current)
    const requestId = ++briefRequestIdRef.current
    briefDebounceRef.current = window.setTimeout(() => {
      setBriefLoading(true)
      fetchAgentBrief(agentType, [...keywords], location.trim(), agentName, provider, ollamaModel, undefined, undefined, maxDelegations)
        .then(result => {
          if (requestId !== briefRequestIdRef.current) return
          setAiBrief(result)
        })
        .catch(() => {
          if (requestId !== briefRequestIdRef.current) return
          setAiBrief(null)
        })
        .finally(() => {
          if (requestId !== briefRequestIdRef.current) return
          setBriefLoading(false)
        })
    }, 700)
    return () => window.clearTimeout(briefDebounceRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentType, keywords, location, agentName, maxDelegations])

  function handleBriefAnswerSubmit() {
    const answer = briefAnswer.trim()
    if (!answer || !aiBrief || aiBrief.type !== 'question' || answeringBrief) return
    setAnsweringBrief(true)
    const requestId = ++briefRequestIdRef.current
    fetchAgentBrief(agentType, [...keywords], location.trim(), agentName, provider, ollamaModel, aiBrief.text, answer, maxDelegations)
      .then(result => {
        if (requestId !== briefRequestIdRef.current) return
        setAiBrief(result)
        setBriefAnswer('')
      })
      .catch(() => {
        // Leave the question showing — the user can retry the answer.
      })
      .finally(() => {
        if (requestId !== briefRequestIdRef.current) return
        setAnsweringBrief(false)
      })
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

  function addSavedKeyword(kw: string) {
    if (bootstrapping) return
    setKeywords(prev => prev.some(k => k.toLowerCase() === kw.toLowerCase()) ? prev : [...prev, kw])
  }

  // Saved searches persist as whole keyword groups (no partial-update API),
  // so forgetting just one keyword means stripping it from every entry that
  // has it, deleting each of those, and — for any entry with keywords left
  // over — re-saving the remainder under a fresh entry, preserving its
  // original agentType.
  async function deleteSavedKeyword(kw: string) {
    const lower = kw.toLowerCase()
    const affected = saved.filter(s => s.keywords.some(k => k.toLowerCase() === lower))
    if (affected.length === 0) return
    setSaved(prev => prev
      .map(s => s.keywords.some(k => k.toLowerCase() === lower)
        ? { ...s, keywords: s.keywords.filter(k => k.toLowerCase() !== lower) }
        : s)
      .filter(s => s.keywords.length > 0))
    for (const entry of affected) {
      deleteSavedSearch(entry.id).catch(() => {})
      const remaining = entry.keywords.filter(k => k.toLowerCase() !== lower)
      if (remaining.length > 0) {
        try {
          const fresh = await createSavedSearch(remaining.join(', '), remaining, entry.agentType ?? 'research')
          setSaved(prev => [fresh, ...prev.filter(s => s.id !== entry.id)])
        } catch {
          // Best effort — the keyword is already gone from local state either way.
        }
      }
    }
  }

  function removeKeyword(kw: string) {
    if (bootstrapping) return
    setKeywords(prev => prev.filter(k => k.toLowerCase() !== kw.toLowerCase()))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); addKeyword() }
    if (e.key === 'Backspace' && !draft && keywords.length > 0) {
      setKeywords(prev => prev.slice(0, -1))
    }
  }

  // Only the specialties not already in the saved pool get saved — re-saving
  // a mix of old + new keywords used to bundle all of them into one fresh
  // SavedSearch entry every time, cluttering the saved list with duplicates
  // of specialties that were already saved. Saving nothing but the new ones
  // keeps each entry a genuinely new addition.
  async function saveSearch() {
    const newKeywords = keywords.filter(
      kw => !savedKeywordPool.some(pooled => pooled.toLowerCase() === kw.toLowerCase())
    )
    if (newKeywords.length === 0) return
    const name = newKeywords.join(', ')
    try {
      const entry = await createSavedSearch(name, newKeywords, agentType)
      // Same keywords saved under a different agent type is a distinct entry;
      // only collapse an exact (keywords, type) repeat — the backend does the
      // same collapse, this just keeps local state in sync with it.
      setSaved(prev => [entry, ...prev.filter(s => !(s.name === entry.name && s.agentType === entry.agentType))])
      setOpenSavedSections(prev => ({ ...prev, searches: true }))
      setSaveFeedback('Saved to Select Specialties ✓')
    } catch {
      setSaveFeedback('Save failed — backend unreachable')
    }
    setTimeout(() => setSaveFeedback(null), 2500)
  }

  // Lets a brand-new specialty be added straight into the saved pool from
  // the dossier itself, without first adding it to the live keyword chips
  // above and clicking Save Specialties — e.g. stocking the pool with
  // presets before starting a profile at all.
  const [addingSavedKeyword, setAddingSavedKeyword] = useState(false)
  const [newSavedKeywordDraft, setNewSavedKeywordDraft] = useState('')
  const newSavedKeywordRef = useRef<HTMLInputElement>(null)

  async function addNewSavedKeyword() {
    const kw = newSavedKeywordDraft.trim()
    setNewSavedKeywordDraft('')
    setAddingSavedKeyword(false)
    if (!kw || savedKeywordPool.some(pooled => pooled.toLowerCase() === kw.toLowerCase())) return
    try {
      const entry = await createSavedSearch(kw, [kw], agentType)
      setSaved(prev => [entry, ...prev.filter(s => !(s.name === entry.name && s.agentType === entry.agentType))])
    } catch {
      // Best effort — a failed dossier add just means the pool doesn't
      // grow this time, nothing else in the form is affected.
    }
  }

  // Saves the whole draft — name, type, location, specialties, plus a
  // deterministic character-trait pair — as a reusable agent profile,
  // distinct from saveSearch() above (keywords only). Nothing is bootstrapped
  // here; this only becomes a real running agent once Commission is clicked.
  async function saveAgentDraft() {
    if (keywords.length === 0) return
    const traits = pickCharacterTraits(agentType, agentName)
    try {
      const entry = await createAgentDraft(agentName, agentType, [...keywords], location.trim(), traits)
      setDrafts(prev => [
        entry,
        ...prev.filter(d => !(
          d.agentName === entry.agentName &&
          d.agentType === entry.agentType &&
          d.location === entry.location &&
          JSON.stringify(d.keywords) === JSON.stringify(entry.keywords)
        )),
      ])
      setOpenSavedSections(prev => ({ ...prev, drafts: true }))
      setSaveFeedback('Saved to Saved Agent Profiles ✓')
    } catch {
      setSaveFeedback('Save failed — backend unreachable')
    }
    setTimeout(() => setSaveFeedback(null), 2500)
  }

  function loadDraft(d: AgentDraft) {
    if (bootstrapping) return
    setAgentType(d.agentType ?? 'research')
    setKeywords([...d.keywords])
    setDraft('')
    if (d.location) setLocation(d.location)
    onAgentNameChange(d.agentName)
    inputRef.current?.focus()
  }

  function deleteDraft(id: string) {
    setDrafts(prev => prev.filter(d => d.id !== id))
    deleteAgentDraft(id).catch(() => {})
  }

  function resumeChat(chat: SavedChat) {
    if (bootstrapping) return
    onResumeChat(chat)
  }

  // Tapping a Saved Chats card loads that agent's details (type, specialties,
  // location, name) back into the Setup form — same shape as loadDraft() for
  // Saved Agent Profiles — without jumping straight into the chat itself.
  // Actually resuming the conversation is the arrow button's job (resumeChat).
  function loadChatDetails(chat: SavedChat) {
    if (bootstrapping) return
    const cfg = chat.agentConfig
    if (cfg.template) setAgentType(cfg.template)
    setKeywords([...(cfg.keywords ?? [])])
    setDraft('')
    if (cfg.location) setLocation(cfg.location)
    onAgentNameChange(chat.agentName)
    inputRef.current?.focus()
  }

  function hideChat(id: string) {
    setHiddenChatIds(hideSavedChat(id))
  }

  // Counterpart to Chat.tsx's handleSaveChatFile download — reads a .json
  // file back in, upserts it into the same localStorage-backed saved-chats
  // list (so it survives a refresh and shows up in the dossier like any
  // other saved chat), then jumps straight into it via the existing
  // onResumeChat path, same as tapping a saved chat's own resume arrow.
  function handleLoadChatFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || bootstrapping) return
    file.text().then(text => {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.agentConfig || !Array.isArray(parsed.messages)) {
        throw new Error('Not a recognised chat file')
      }
      const chat = parsed as SavedChat
      setSavedChats(saveChat(chat))
      setHiddenChatIds(prev => prev.filter(id => id !== chat.id))
      resumeChat(chat)
    }).catch(() => {
      setCommissionHint('That file doesn\'t look like a saved chat export.')
    })
  }

  function handleAgentTypeChange(type: AgentTemplateId) {
    setAgentType(type)
  }

  function toggleSavedSection(section: SavedSectionId) {
    setOpenSavedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (bootstrapping) return
    if (keywords.length === 0) {
      setCommissionHint('Add at least one specialty above — the brief needs it before this agent can be commissioned.')
      return
    }
    const loc = location.trim()
    const extraInstructions = specialInstructions.trim()
    const purpose = getTemplate(agentType).buildPurpose(keywords, loc) +
      (extraInstructions ? ` Special instructions from the user, follow these exactly: ${extraInstructions}` : '')
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
      onDone({
        ...config,
        keywords,
        location: loc,
        provider,
        ollama_model: provider === 'ollama' ? ollamaModel : null,
        template: agentType,
        max_delegations: maxDelegations,
        search_defaults: searchDefaults,
      })
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const briefWarning = keywords.length === 0
    ? null
    : aiBrief
      ? aiBrief.warning ?? null
      : buildDeterministicWarning(keywords, agentType, location.trim(), maxDelegations)

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

        <div className={styles.focusStack}>
        <div
          className={`${styles.agentCard} ${focusPanel === 'setup' ? styles.panelActive : styles.panelCollapsed}`}
          onClick={() => setFocusPanel('setup')}
        >
          <div className={styles.agentCardMain}>
            <div className={styles.agentCardInfo}>
              <h1 className={styles.title}>Agent {agentName}</h1>
              <p className={styles.locationLiner}>📍 {location || 'No location set'}</p>
            </div>
          </div>

          <div className={styles.agentCardScroll}>
            <div className={styles.specialtiesRow}>
              <button
                type="button"
                className={styles.fieldLabelToggle}
                onClick={() => setSpecialtiesOpen(o => !o)}
                aria-expanded={specialtiesOpen}
              >
                <span className={styles.fieldLabel}><span aria-hidden="true">◆</span> Specialties</span>
                <span className={styles.fieldLabelRight}>
                  {!specialtiesOpen && keywords.length > 0 && (
                    <span className={styles.fieldLabelCount}>{keywords.length}</span>
                  )}
                  <span className={styles.fieldLabelCaret} aria-hidden="true">{specialtiesOpen ? '▾' : '▸'}</span>
                </span>
              </button>
              {specialtiesOpen && (
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
                    placeholder={keywords.length === 0 ? getTemplate(agentType).keywordPlaceholder : '+ New Agent Specialty'}
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
              )}
              {specialtiesOpen && (
                <div className={styles.specialtiesActionsRow}>
                  {saveFeedback ? (
                    <p className={`${styles.saveFeedbackText} ${saveFeedback.includes('failed') ? styles.saveFeedbackError : styles.saveFeedbackSuccess}`}>
                      {saveFeedback}
                    </p>
                  ) : (
                    <p className={styles.charHint}>
                      {draft.length > 0 ? `${50 - draft.length} chars remaining` : ''}
                    </p>
                  )}
                  <div className={styles.profileActions}>
                    {keywords.length > 0 && (
                      <button
                        type="button"
                        className={styles.profileSaveBtn}
                        onClick={saveSearch}
                        disabled={bootstrapping || !hasUnsavedSpecialties}
                        title={hasUnsavedSpecialties ? 'Save the specialties above that aren\'t saved yet' : 'All current specialties are already saved'}
                      >
                        Save Specialties
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.profileResetBtn}
                      onClick={() => {
                        setKeywords([])
                        setDraft('')
                        setSpecialInstructions('')
                        onNewAgent()
                        inputRef.current?.focus()
                      }}
                      disabled={bootstrapping}
                    >
                      Reset
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className={styles.agentSummaryRow}>
              <button
                type="button"
                className={styles.fieldLabelToggle}
                onClick={() => setBriefOpen(o => !o)}
                aria-expanded={briefOpen}
              >
                <span className={styles.fieldLabel}><span aria-hidden="true">◆</span> Brief</span>
                <span className={styles.fieldLabelCaret} aria-hidden="true">{briefOpen ? '▾' : '▸'}</span>
              </button>
              {briefOpen && (
                keywords.length === 0 ? (
                  <p className={styles.agentSummaryText}>Add specialties above to generate this agent’s brief.</p>
                ) : aiBrief?.type === 'question' ? (
                  <>
                    <div className={styles.briefQuestionBox}>
                      <p className={styles.briefQuestionText}><span aria-hidden="true">🤔</span> {aiBrief.text}</p>
                      <div className={styles.briefAnswerRow}>
                        <input
                          className={styles.briefAnswerInput}
                          value={briefAnswer}
                          onChange={e => setBriefAnswer(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleBriefAnswerSubmit() }}
                          placeholder="Your answer…"
                          disabled={answeringBrief}
                        />
                        <button
                          type="button"
                          className={styles.briefAnswerBtn}
                          onClick={handleBriefAnswerSubmit}
                          disabled={!briefAnswer.trim() || answeringBrief}
                        >
                          {answeringBrief ? '…' : 'Continue'}
                        </button>
                      </div>
                    </div>
                    {briefWarning && (
                      <div className={styles.briefWarningBox}>
                        <p className={styles.briefWarningText}><span aria-hidden="true">⚠</span> {briefWarning}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className={styles.agentSummaryText}>
                      {aiBrief?.text ?? buildAgentBrief(agentType, keywords, location.trim(), agentName)}
                      {briefLoading && <span className={styles.briefLoadingHint}> · redrafting…</span>}
                    </p>
                    {briefWarning && (
                      <div className={styles.briefWarningBox}>
                        <p className={styles.briefWarningText}><span aria-hidden="true">⚠</span> {briefWarning}</p>
                      </div>
                    )}
                  </>
                )
              )}
            </div>

            <div className={styles.specialInstructionsRow}>
              <button
                type="button"
                className={styles.fieldLabelToggle}
                onClick={() => setSpecialInstructionsOpen(o => !o)}
                aria-expanded={specialInstructionsOpen}
              >
                <span className={styles.fieldLabel}><span aria-hidden="true">◆</span> Special Instructions (Optional)</span>
                <span className={styles.fieldLabelRight}>
                  {!specialInstructionsOpen && specialInstructions.trim() && (
                    <span className={styles.fieldLabelCount}>Set</span>
                  )}
                  <span className={styles.fieldLabelCaret} aria-hidden="true">{specialInstructionsOpen ? '▾' : '▸'}</span>
                </span>
              </button>
              {specialInstructionsOpen && (
                <textarea
                  className={styles.specialInstructionsInput}
                  value={specialInstructions}
                  onChange={e => setSpecialInstructions(e.target.value.slice(0, 500))}
                  placeholder="Anything specific this agent should always do or avoid — appended to its instructions as-is."
                  disabled={bootstrapping}
                  maxLength={500}
                  rows={3}
                />
              )}
            </div>
          </div>

          <div className={styles.profileCommissionRow}>
            {commissionHint && (
              <p className={styles.commissionHint} role="status">{commissionHint}</p>
            )}
            <div className={styles.commissionGroup}>
              {keywords.length > 0 && (
                <button
                  type="button"
                  className={`${styles.profileSaveBtn} ${styles.profileSaveBtnCommissionRow}`}
                  onClick={saveAgentDraft}
                  disabled={bootstrapping}
                  title="Save this whole profile — name, type, location and specialties"
                >
                  Save<br />Agent
                </button>
              )}
              <div className={styles.agentTypeSelector}>
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
                <span className={styles.agentTypeLabel}>{getTemplate(agentType).label}</span>
              </div>
              <button
                type="submit"
                form="agentSetupForm"
                className={`${styles.profileCommissionBtn} ${keywords.length === 0 ? styles.profileCommissionBtnBlocked : ''}`}
                disabled={bootstrapping}
                aria-disabled={keywords.length === 0}
              >
                {bootstrapping ? 'Configuring…' : 'Commission >'}
              </button>
            </div>
          </div>
        </div>

        <form
          id="agentSetupForm"
          onSubmit={handleSubmit}
          onClick={() => setFocusPanel('dossier')}
          className={`${styles.form} ${focusPanel === 'dossier' ? styles.panelActive : styles.panelCollapsed}`}
        >
          <div className={styles.dossierWrap}>
          <div className={styles.savedSectionsScroll}>
          <span className={styles.dossierTab} aria-hidden="true">Agent Dossier</span>
          <span className={styles.dossierStamp} aria-hidden="true">On file</span>
          <div className={styles.savedSectionsScrollInner}>
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
                <span className={styles.savedSectionTitle}>Saved Specialties</span>
                <span className={styles.savedSectionCount}>{savedKeywordPool.length}</span>
              </button>
              {openSavedSections.searches && (
                <div className={styles.savedSectionBody}>
                  {savedKeywordPool.length === 0 && !addingSavedKeyword && (
                    <p className={styles.savedEmpty}>No specialties saved yet.</p>
                  )}
                  <div className={styles.savedKeywordPool}>
                    {savedKeywordPool.map(kw => {
                      const alreadyAdded = keywords.some(k => k.toLowerCase() === kw.toLowerCase())
                      const toggle = () => { if (bootstrapping || alreadyAdded) return; addSavedKeyword(kw) }
                      return (
                        <div
                          key={kw}
                          className={`${styles.savedKeywordChip} ${alreadyAdded ? styles.savedKeywordChipAdded : ''}`}
                          role="button"
                          tabIndex={bootstrapping || alreadyAdded ? -1 : 0}
                          onClick={toggle}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
                          aria-pressed={alreadyAdded}
                          aria-disabled={alreadyAdded}
                          aria-label={alreadyAdded ? `${kw} is already in current specialties` : `Add saved specialty ${kw} to current specialties`}
                          title={alreadyAdded ? 'Already in current specialties' : 'Tap to add to current specialties'}
                        >
                          <span className={styles.savedKeywordLabel}>{kw}</span>
                          <button
                            type="button"
                            className={styles.savedKeywordDelete}
                            onClick={ev => { ev.stopPropagation(); deleteSavedKeyword(kw) }}
                            disabled={bootstrapping}
                            aria-label={`Delete saved specialty ${kw}`}
                            title="Delete saved specialty"
                          >
                            ×
                          </button>
                        </div>
                      )
                    })}
                    {addingSavedKeyword ? (
                      <input
                        ref={newSavedKeywordRef}
                        className={styles.chipInput}
                        value={newSavedKeywordDraft}
                        onChange={e => setNewSavedKeywordDraft(e.target.value.slice(0, 50))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); addNewSavedKeyword() }
                          if (e.key === 'Escape') { setNewSavedKeywordDraft(''); setAddingSavedKeyword(false) }
                        }}
                        onBlur={addNewSavedKeyword}
                        placeholder="New specialty…"
                        autoFocus
                        maxLength={50}
                      />
                    ) : (
                      <button
                        type="button"
                        className={styles.savedKeywordAddNew}
                        onClick={() => setAddingSavedKeyword(true)}
                        disabled={bootstrapping}
                        title="Add a new specialty straight to the saved pool"
                      >
                        Add New
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className={styles.savedSection}>
              <button
                type="button"
                className={styles.savedSectionHeader}
                aria-expanded={openSavedSections.drafts}
                onClick={() => toggleSavedSection('drafts')}
              >
                <span className={styles.savedSectionCaret} aria-hidden="true">
                  {openSavedSections.drafts ? '▾' : '▸'}
                </span>
                <span className={styles.savedSectionTitle}>Saved Agent Profiles</span>
                <span className={styles.savedSectionCount}>{visibleDrafts.length}</span>
              </button>
              {openSavedSections.drafts && (
                <div className={styles.savedSectionBody}>
                  {visibleDrafts.length > 0 ? (
                    <div className={styles.savedList}>
                      {visibleDrafts.map(d => (
                        <div
                          key={d.id}
                          className={`${styles.savedRow} ${bootstrapping ? styles.savedRowDisabled : ''}`}
                          onClick={() => loadDraft(d)}
                          title={bootstrapping ? 'Agent is being commissioned — profiles can’t be loaded right now' : 'Load this agent profile'}
                          aria-disabled={bootstrapping}
                        >
                          <div className={styles.savedChatInfo}>
                            <span className={styles.savedChatName}>Agent {d.agentName}</span>
                            {d.traits.length > 0 && (
                              <span className={styles.savedChatTraits}>{d.traits.join(' · ')}</span>
                            )}
                            <div className={styles.savedChips}>
                              {d.keywords.map(kw => (
                                <span key={kw} className={styles.savedChip}>{kw}</span>
                              ))}
                            </div>
                            <span className={styles.savedChatMeta}>
                              {d.location || 'No location set'} · {getTemplate(d.agentType ?? 'research').label} · {formatSavedAt(d.savedAt)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.savedDelete}
                            onClick={ev => { ev.stopPropagation(); deleteDraft(d.id) }}
                            aria-label="Delete agent profile"
                            title="Delete agent profile"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.savedEmpty}>No saved profiles for {getTemplate(agentType).label} yet.</p>
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
                <span className={styles.savedSectionTitle}>Saved Chats</span>
                <span className={styles.savedSectionCount}>{visibleChats.length}</span>
              </button>
              {openSavedSections.chats && (
                <div className={styles.savedSectionBody}>
                  <input
                    ref={chatFileInputRef}
                    type="file"
                    accept="application/json"
                    onChange={handleLoadChatFile}
                    style={{ display: 'none' }}
                  />
                  <button
                    type="button"
                    className={styles.loadChatFileBtn}
                    onClick={() => chatFileInputRef.current?.click()}
                    disabled={bootstrapping}
                    title="Load a chat previously saved as a .json file and resume it"
                  >
                    Load Chat File…
                  </button>
                  {visibleChats.length > 0 ? (
                    <div className={styles.savedList}>
                      {visibleChats.map(c => (
                        <div
                          key={c.id}
                          className={`${styles.savedRow} ${bootstrapping ? styles.savedRowDisabled : ''}`}
                          onClick={() => loadChatDetails(c)}
                          title={bootstrapping ? 'Agent is being commissioned — details can’t be loaded right now' : 'Load this agent’s details into the form'}
                          aria-disabled={bootstrapping}
                        >
                          <div className={styles.savedChatInfo}>
                            <span className={styles.savedChatName}>Agent {c.agentName}</span>
                            {c.agentConfig.keywords && c.agentConfig.keywords.length > 0 && (
                              <div className={styles.savedChips}>
                                {[...c.agentConfig.keywords].sort((a, b) => a.localeCompare(b)).map(kw => (
                                  <span key={kw} className={styles.savedChip}>{kw}</span>
                                ))}
                              </div>
                            )}
                            <span className={styles.savedChatMeta}>
                              {getTemplate(c.agentConfig.template).label} · {c.messages.length} message{c.messages.length === 1 ? '' : 's'} · {formatSavedAt(c.savedAt)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.savedResume}
                            onClick={ev => { ev.stopPropagation(); resumeChat(c) }}
                            disabled={bootstrapping}
                            aria-label={`Continue chat with Agent ${c.agentName}`}
                            title="Continue this chat"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M9 18l6-6-6-6" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className={styles.savedDelete}
                            onClick={ev => { ev.stopPropagation(); hideChat(c.id) }}
                            aria-label={`Remove Agent ${c.agentName}'s chat from this list`}
                            title="Remove from this list (keeps the saved chat itself)"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.savedEmpty}>No saved chats yet — use "Save chat" in an active conversation.</p>
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
          </div>

        </form>
        </div>

        {(bootstrapping || modelInfo || error) && (
          <div className={styles.loadingHint}>
            {modelInfo && (
              <p className={styles.modelInfoLine}>{formatModelInfo(modelInfo)}</p>
            )}
            {bootstrapping ? (
              <>
                {(() => {
                  const groundingMatch = progress?.match(/^Found (\d+) similar past agent/i)
                  if (groundingMatch) {
                    return <p><span className={styles.groundingBadge}>🧠 grounded ×{groundingMatch[1]}</span></p>
                  }
                  return (
                    <p>
                      {progress ??
                        (provider === 'ollama'
                          ? `${ollamaModel ?? 'Your local model'} is designing your agent's tools and behaviour. This may take longer than the cloud default.`
                          : 'Designing your agent\'s tools and behaviour…')}
                    </p>
                  )
                })()}
                {toolsSoFar.length > 0 && (
                  <ul className={styles.loadingTools}>
                    {toolsSoFar.map(name => (
                      <li key={name}>✓ {name}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : error ? (
              <div className={styles.errorPanel}>
                <span className={styles.errorIcon} aria-hidden="true">⚠</span>
                <div>
                  <p className={styles.errorHeadline}>Couldn't design this agent</p>
                  <p className={styles.errorDetail}>{error}</p>
                </div>
              </div>
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
        onProviderChange={handleProviderChange}
        ollamaModel={ollamaModel}
        onOllamaModelChange={handleOllamaModelChange}
        availableModels={availableModels}
        modelsLoaded={modelsLoaded}
        maxDelegations={maxDelegations}
        onMaxDelegationsChange={handleMaxDelegationsChange}
        searchDefaults={searchDefaults}
        onSearchDefaultsChange={handleSearchDefaultsChange}
        disabled={bootstrapping}
      />
    </div>
  )
}

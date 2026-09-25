import { useEffect, useRef, useState } from 'react'
import { bootstrap, createAgentDraft, createSavedSearch, deleteAgentDraft, deleteSavedSearch, fetchAgentBrief, listAgentDrafts, listOllamaModels, listPublishedAgents, listSavedSearches, unpublishAgent } from '../api'
import type { AgentBrief, AgentDraft, PublishedAgent, SavedSearch } from '../api'
import { hideSavedChat, loadHiddenChatIds, loadSavedChats, saveChat } from '../chatStorage'
import type { AgentConfig, AgentTemplateId, BootstrapStreamEvent, EvalResultItem, LlmProvider, ModelAttempt, SavedChat, SavedChatMessage, SearchDefaults } from '../types'
import { AGENT_TEMPLATES, getTemplate, PERSONALITY_TRAITS, describeTraitEffect, BEHAVIOR_TOGGLES, type BehaviorToggle } from '../agentTypes'
import { DEFAULT_OLLAMA_MODEL, describeModel, describeModelFallback } from '../modelLabel'
import { buildAgentBrief, joinNatural } from '../agentBrief'
import styles from '../styles/Setup.module.css'
import splashLogo from '../assets/splash_logo.png'
import SettingsModal from './SettingsModal'
import CharacterGenerator from './CharacterGenerator'
import HelpTip from './HelpTip'
import FeedbackStatusBar from './FeedbackStatusBar'

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

// Same mono line-art style as AgentTypeIcon above (stroke=currentColor, no
// fill) — the behavior toggles previously used colorful emoji, which read
// as a different, more novelty visual language than the rest of the picker
// UI; these plain geometric glyphs match the site's own style instead.
function BehaviorIcon({ id }: { id: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (id) {
    case 'concise':
      return (
        <svg {...common}>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="15" y2="12" />
          <line x1="4" y1="17" x2="10" y2="17" />
        </svg>
      )
    case 'skeptical':
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <line x1="20.5" y1="20.5" x2="15.3" y2="15.3" />
          <path d="M8.7 8.8a1.8 1.8 0 1 1 2.9 1.4c-.9.7-1.1 1.1-1.1 2" />
          <circle cx="10.5" cy="14.6" r="0.65" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'cite-sources':
      return (
        <svg {...common}>
          <path d="M10 14a5 5 0 0 0 7.07 0l1.83-1.83a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
          <path d="M14 10a5 5 0 0 0-7.07 0L5.1 11.83a5 5 0 0 0 7.07 7.07l1.5-1.5" />
        </svg>
      )
    case 'proactive':
      return (
        <svg {...common}>
          <path d="M4 16 10 10l3 3 6-7" />
          <path d="M16 6h4v4" />
        </svg>
      )
    case 'formal':
      return (
        <svg {...common}>
          <path d="M4 8l6 4-6 4Z" />
          <path d="M20 8l-6 4 6 4Z" />
          <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'max-delegation':
      return (
        <svg {...common}>
          <circle cx="12" cy="5.3" r="1.6" />
          <circle cx="5.3" cy="18.3" r="1.6" />
          <circle cx="18.7" cy="18.3" r="1.6" />
          <path d="M12 7v3.5M12 10.5 6.4 16.8M12 10.5l5.6 6.3" />
        </svg>
      )
    default:
      return null
  }
}

// Same mono line-art style as the other icons above — a plain floppy-disk
// outline standing in for the "Save Agent" button's old text label, once the
// button itself became icon-only.
function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3h11l3 3v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M8 3v5h8V3" />
      <path d="M7 21v-8h10v8" />
    </svg>
  )
}

// Shared header for every collapsible subsection in the agent profile card
// (Behavior/Personality/Specialties/Brief) — a clickable row that expands/
// collapses the section, plus a "?" HelpTip button. The row itself can't be
// a <button> (a HelpTip button living inside it would be an invalid
// button-in-button), so it's a div with role="button" instead; the HelpTip's
// own onClick stops propagation so opening the popover doesn't also
// toggle the section.
function SectionHeader({ label, expanded, onToggle, help, right }: {
  label: string
  expanded: boolean
  onToggle: () => void
  help: string
  right?: React.ReactNode
}) {
  return (
    <div
      className={styles.fieldLabelToggle}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
    >
      <span className={styles.fieldLabel}><span aria-hidden="true">◆</span> {label}</span>
      <span className={styles.fieldLabelRight}>
        {right}
        <HelpTip text={help} label={`${label} help`} />
        <span className={styles.fieldLabelCaret} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </span>
    </div>
  )
}

// What a behavior toggle's effect is actually called for each agent type —
// "findings" for research, "listings" for job search, plain "topics"
// otherwise — so a toggle's help text can say what it does to THIS agent's
// own output instead of a type-agnostic generic sentence.
const AGENT_TYPE_NOUN: Record<AgentTemplateId, string> = {
  general: 'topic',
  research: 'finding',
  job_search: 'listing',
}

// Behavior toggle help text (button tooltip + the active-effects list) used
// to be the same fixed sentence regardless of what the agent actually is —
// e.g. "Concise" read identically for a job-search agent and a research
// agent. This folds in the current agent type and its own specialty
// keywords so the help text describes what the toggle means for THIS
// agent, not behavior toggles in the abstract.
function describeBehaviorEffect(toggle: BehaviorToggle, type: AgentTemplateId, kw: string[]): string {
  const noun = AGENT_TYPE_NOUN[type] ?? 'topic'
  const subject = kw.length > 0 ? joinNatural(kw.slice(0, 3)) : `each ${noun}`
  switch (toggle.id) {
    case 'concise':
      return `${toggle.description} For this agent, that means terse bullet points on ${subject} instead of a long write-up per ${noun}.`
    case 'skeptical':
      return `${toggle.description} It will question shaky claims about ${subject} rather than repeating them as fact.`
    case 'cite-sources':
      return `${toggle.description} Every fact it states about ${subject} gets a source link attached inline.`
    case 'proactive':
      return `${toggle.description} It will flag risks or gaps in ${subject} even when you didn't ask about them directly.`
    case 'formal':
      return `${toggle.description} Its reports on ${subject} read in a professional register, no casual asides.`
    case 'max-delegation':
      return kw.length > 1
        ? `${toggle.description} With ${kw.length} specialties (${subject}), it splits the work across a worker agent per specialty instead of researching all of them itself.`
        : `${toggle.description} Even with just ${subject} to cover, it still splits research into parallel worker agents rather than doing it all itself.`
    default:
      return toggle.description
  }
}

// Default when the user hasn't overridden it on the Settings screen — mirrors
// backend/src/agent_stream.py's MAX_DELEGATIONS_PER_REQUEST. One worker is
// delegated per specialty, capped per turn, so more specialties than this are
// silently dropped/starved rather than all covered.
const DEFAULT_MAX_DELEGATIONS = 6

// Hard UI-side cap, independent of DEFAULT_MAX_DELEGATIONS above (that one's
// a soft delegation-capacity warning; this one actually blocks adding a 6th
// specialty at all) — keeps the specialty set small enough that the Brief
// and bootstrap prompt stay focused rather than diluted across many topics.
const MAX_SPECIALTIES = 5

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

type SavedSectionId = 'searches' | 'drafts' | 'chats' | 'mcp'

// The last line of a saved chat, shown in the saved-chats list so the user
// has some actual context for which conversation this is instead of just a
// name/timestamp — the name/keywords describe the agent, not what was said.
const CHAT_PREVIEW_MAX_LEN = 90
function lastChatLine(messages: SavedChatMessage[]): string | null {
  const last = [...messages].reverse().find(m => m.content.trim().length > 0)
  if (!last) return null
  const text = last.content.trim().replace(/\s+/g, ' ')
  const truncated = text.length > CHAT_PREVIEW_MAX_LEN ? `${text.slice(0, CHAT_PREVIEW_MAX_LEN - 1)}…` : text
  return last.role === 'user' ? `You: ${truncated}` : truncated
}

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
  // The config of the agent whose chat the user just came back from (App.tsx's
  // agentConfig, passed through onBackToSetup) — undefined/null the first
  // time Setup is shown, before anything has been bootstrapped yet.
  activeAgentConfig?: AgentConfig | null
}

export default function Setup({ agentName, onAgentNameChange, onNewAgent, bootstrapping, error, onStart, onDone, onError, onResumeChat, activeAgentConfig }: Props) {
  const [agentType, setAgentType] = useState<AgentTemplateId>('general')
  const [keywords, setKeywords] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [location, setLocation] = useState('Melbourne, Australia')
  // Persisted across "New agent"/reset (which fully remounts Setup — see
  // App.tsx's phase-conditional render) and page reloads, same
  // localStorage idiom as chatStorage.ts/aiagent_saved_chats — otherwise the
  // provider choice silently reverted to Auto (Gemini-first) on every new
  // agent, with no visible indicator on the main screen that it had reset.
  // Defaults to local-only (Ollama) rather than the cloud-first Auto cascade —
  // this app's Gemini usage was costing real money, so a fresh browser with no
  // saved preference should not silently default to the paid provider. An
  // explicit choice on the Settings screen still overrides this via localStorage.
  const [provider, setProvider] = useState<LlmProvider>(
    () => (localStorage.getItem('aiagent_provider') as LlmProvider) || 'ollama'
  )
  const [ollamaModel, setOllamaModel] = useState<string | null>(
    () => localStorage.getItem('aiagent_ollama_model') || DEFAULT_OLLAMA_MODEL
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
  // Self-evaluation status bar (root CLAUDE.md eval-framework task) — same
  // component/shape as Chat.tsx's, scoped to just this bootstrap attempt
  // (reset alongside progress/toolsSoFar in runBootstrap below).
  const [evalResults, setEvalResults] = useState<EvalResultItem[]>([])
  const [evalBarCollapsed, setEvalBarCollapsed] = useState(true)
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([])
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const [locationDetecting, setLocationDetecting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [characterGenOpen, setCharacterGenOpen] = useState(false)
  // The setup form and the dossier are both too tall to show fully at once
  // without crowding the page, so tapping into either one expands it to
  // ~70% height and collapses the other, at every viewport width (see
  // .focusStack in Setup.module.css).
  const [focusPanel, setFocusPanel] = useState<'setup' | 'dossier'>('setup')
  // Neither panel scrolls internally by much (the setup card doesn't scroll
  // at all; the dossier list often doesn't need to either), so a swipe/drag
  // gesture that scrolls nothing still ends as a plain click at wherever the
  // pointer lifted — frequently over the *other*, collapsed panel below/above,
  // which flips focusPanel as an unintended side effect of just scrolling.
  // Recording the pointerdown position and only honoring the click as a real
  // tap when the pointer barely moved fixes that without needing to guess
  // whether an actual scroll happened.
  const panelTapStart = useRef<{ x: number; y: number } | null>(null)
  const TAP_MOVE_THRESHOLD_PX = 10
  function handlePanelPointerDown(e: React.PointerEvent) {
    panelTapStart.current = { x: e.clientX, y: e.clientY }
  }
  function handlePanelTap(target: 'setup' | 'dossier', e: React.MouseEvent) {
    const start = panelTapStart.current
    if (start && (Math.abs(e.clientX - start.x) > TAP_MOVE_THRESHOLD_PX || Math.abs(e.clientY - start.y) > TAP_MOVE_THRESHOLD_PX)) {
      return
    }
    setFocusPanel(target)
  }
  const [specialtiesOpen, setSpecialtiesOpen] = useState(true)
  const [briefOpen, setBriefOpen] = useState(true)
  const [specialInstructionsOpen, setSpecialInstructionsOpen] = useState(false)
  const [activeToggles, setActiveToggles] = useState<string[]>([])
  function toggleBehavior(id: string) {
    setActiveToggles(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])
  }
  const [personalityOpen, setPersonalityOpen] = useState(false)
  const [selectedTraits, setSelectedTraits] = useState<string[]>([])
  function toggleTrait(id: string) {
    setSelectedTraits(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])
  }
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
      if (models.length > 0) setOllamaModel(prev => (prev && models.includes(prev)) ? prev : models[0])
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
    const behaviorLabels = BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.label)
    const traitLabels = (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research)
      .filter(t => selectedTraits.includes(t.id)).map(t => t.label)
    briefDebounceRef.current = window.setTimeout(() => {
      setBriefLoading(true)
      fetchAgentBrief(agentType, [...keywords], location.trim(), agentName, provider, ollamaModel, undefined, undefined, maxDelegations, behaviorLabels, traitLabels)
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
  }, [agentType, keywords, location, agentName, maxDelegations, activeToggles, selectedTraits])

  function handleBriefAnswerSubmit() {
    const answer = briefAnswer.trim()
    if (!answer || !aiBrief || aiBrief.type !== 'question' || answeringBrief) return
    setAnsweringBrief(true)
    const requestId = ++briefRequestIdRef.current
    const behaviorLabels = BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.label)
    const traitLabels = (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research)
      .filter(t => selectedTraits.includes(t.id)).map(t => t.label)
    fetchAgentBrief(agentType, [...keywords], location.trim(), agentName, provider, ollamaModel, aiBrief.text, answer, maxDelegations, behaviorLabels, traitLabels)
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
    if (bootstrapping || keywords.length >= MAX_SPECIALTIES) return
    const kw = draft.trim()
    if (!kw || keywords.map(k => k.toLowerCase()).includes(kw.toLowerCase())) return
    const next = [...keywords, kw]
    setKeywords(next)
    setDraft('')
    inputRef.current?.focus()
  }

  // Tapping the brand logo is "start a fresh search" everywhere in the app —
  // from Chat it fully remounts Setup (App.tsx's onReset), which already
  // wipes this in-progress state for free; from Setup itself the component
  // stays mounted (setup/bootstrapping share one instance so a failed
  // bootstrap doesn't lose the typed-in keywords — see the phase-conditional
  // render in App.tsx), so the current unsaved search has to be cleared here
  // explicitly instead of relying on a remount that isn't going to happen.
  function resetSearch() {
    if (bootstrapping) return
    setKeywords([])
    setDraft('')
    setActiveToggles([])
    setSelectedTraits([])
    setAiBrief(null)
    setBriefAnswer('')
    setCommissionHint(null)
    setFocusPanel('setup')
    inputRef.current?.focus()
  }

  function addSavedKeyword(kw: string) {
    if (bootstrapping) return
    setKeywords(prev => {
      if (prev.length >= MAX_SPECIALTIES || prev.some(k => k.toLowerCase() === kw.toLowerCase())) return prev
      return [...prev, kw]
    })
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

  // Saves the whole draft — name, type, location, specialties, plus whichever
  // personality traits the user actually selected — as a reusable agent
  // profile, distinct from saveSearch() above (keywords only). Nothing is
  // bootstrapped here; this only becomes a real running agent once
  // Commission is clicked.
  async function saveAgentDraft() {
    if (keywords.length === 0) {
      setSaveFeedback('Add at least one specialty first')
      setTimeout(() => setSaveFeedback(null), 2500)
      return
    }
    const traitPool = PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research
    const traits = traitPool.filter(t => selectedTraits.includes(t.id)).map(t => t.label)
    try {
      const entry = await createAgentDraft(agentName, agentType, [...keywords], location.trim(), traits, [...activeToggles])
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
    const type = d.agentType ?? 'research'
    setAgentType(type)
    setKeywords([...d.keywords])
    setDraft('')
    if (d.location) setLocation(d.location)
    const toggles = [...(d.behaviorToggles ?? [])]
    setActiveToggles(toggles)
    const pool = PERSONALITY_TRAITS[type] ?? PERSONALITY_TRAITS.research
    const traitIds = pool.filter(t => (d.traits ?? []).includes(t.label)).map(t => t.id)
    setSelectedTraits(traitIds)
    // A reloaded agent with behaviors/traits already set should show them
    // open, not tucked behind a collapsed "(Optional)" section header the
    // user would need to know to expand.
    if (toggles.length > 0) setSpecialInstructionsOpen(true)
    if (traitIds.length > 0) setPersonalityOpen(true)
    onAgentNameChange(d.agentName)
    setFocusPanel('setup')
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

  // Shared by loadChatDetails (tapping a Saved Chats card) and the
  // restore-on-mount effect below (returning to Setup from an active chat) —
  // both need to repopulate every field an agent's config actually carries,
  // not just name/keywords.
  function applyAgentConfigToForm(cfg: AgentConfig, name: string) {
    if (cfg.template) setAgentType(cfg.template)
    setKeywords([...(cfg.keywords ?? [])])
    setDraft('')
    if (cfg.location) setLocation(cfg.location)
    const toggles = [...(cfg.active_toggles ?? [])]
    const traits = [...(cfg.active_traits ?? [])]
    setActiveToggles(toggles)
    setSelectedTraits(traits)
    // Same "don't hide populated sections behind a collapsed header" rule
    // as loadDraft() above.
    if (toggles.length > 0) setSpecialInstructionsOpen(true)
    if (traits.length > 0) setPersonalityOpen(true)
    onAgentNameChange(name)
  }

  // Tapping a Saved Chats card loads that agent's details (type, specialties,
  // location, name) back into the Setup form — same shape as loadDraft() for
  // Saved Agent Profiles — without jumping straight into the chat itself.
  // Actually resuming the conversation is the arrow button's job (resumeChat).
  function loadChatDetails(chat: SavedChat) {
    if (bootstrapping) return
    applyAgentConfigToForm(chat.agentConfig, chat.agentName)
    setFocusPanel('setup')
    inputRef.current?.focus()
  }

  // Returning to Setup from an active/just-finished chat (App.tsx's
  // onBackToSetup, "Back to search") should restore this form to match that
  // agent's real config — personality traits, behaviour toggles, specialties,
  // location, type — rather than resetting to blank defaults, since nothing
  // about the agent itself changed, only which screen is showing. Setup fully
  // remounts on every phase transition (App.tsx's phase-conditional render),
  // so this only ever needs to run once, on mount.
  useEffect(() => {
    if (activeAgentConfig) applyAgentConfigToForm(activeAgentConfig, agentName)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    // Previously pruned selectedTraits down to whatever overlapped the new
    // type's pool — but PERSONALITY_TRAITS pools are fully disjoint across
    // types (zero shared ids), so that always emptied the selection on any
    // type switch. Traits/toggles now persist across type changes; the
    // personality UI itself already filters selectedTraits by the current
    // type's pool wherever it's displayed, so a stale id from a previous
    // type just stays inert (not shown, not counted) until that type is
    // revisited, instead of being lost.
    setAgentType(type)
  }

  function toggleSavedSection(section: SavedSectionId) {
    setOpenSavedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  // Extracted from handleSubmit so a post-error "Retry" button can re-run the
  // exact same commission attempt (form state is untouched after a failed
  // bootstrap — Setup stays mounted across setup/bootstrapping phases) without
  // needing a form submit event.
  async function runBootstrap() {
    if (bootstrapping) return
    if (keywords.length === 0) {
      setCommissionHint('Add at least one specialty above — the brief needs it before this agent can be commissioned.')
      return
    }
    const loc = location.trim()
    const activeInstructions = BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.instruction)
    const traitPool = PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research
    const traitInstructions = traitPool.filter(t => selectedTraits.includes(t.id)).map(t => t.instruction)
    const purpose = getTemplate(agentType).buildPurpose(keywords, loc) +
      (activeInstructions.length > 0 ? ` ${activeInstructions.join(' ')}` : '') +
      (traitInstructions.length > 0 ? ` ${traitInstructions.join(' ')}` : '')
    onStart()
    setProgress(null)
    setToolsSoFar([])
    setModelInfo(null)
    setEvalResults([])
    setEvalBarCollapsed(true)
    function handleProgress(event: BootstrapStreamEvent) {
      if (event.type === 'status') setProgress(event.message)
      else if (event.type === 'tool') setToolsSoFar(prev => [...prev, event.name])
      else if (event.type === 'model') setModelInfo({ used: event.used, failed: event.failed })
      else if (event.type === 'eval_result') {
        setEvalResults(prev => [
          ...prev,
          {
            check: event.check,
            target: event.target,
            target_id: event.target_id,
            passed: event.passed,
            reason: event.reason,
            method: event.method,
            severity: event.severity,
          },
        ])
        if (!event.passed) setEvalBarCollapsed(false)
      }
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
        active_toggles: activeToggles,
        // Only the ids that actually belong to this type's pool — selectedTraits
        // itself can still hold ids left over from a type visited earlier in
        // this session (no longer pruned on type change), which must not leak
        // into a persisted/resumable AgentConfig.
        active_traits: traitPool.filter(t => selectedTraits.includes(t.id)).map(t => t.id),
      })
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await runBootstrap()
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
        <HelpTip
          className={styles.panelHelpTip}
          size="lg"
          label="What is this screen?"
          text="This card designs your agent before it exists. Pick an agent type, add specialties for it to focus on, and optionally tune its behavior and personality — the Brief below updates live to show what it's agreed to do. Hit Commission to bootstrap it and start chatting."
        />
        <button
          type="button"
          className={styles.brandLogoBtn}
          onClick={resetSearch}
          aria-label="Return to search"
          title="Return to search"
        >
          <img src={splashLogo} alt="Agent One" className={styles.brandLogo} />
        </button>

        <div className={styles.focusStack}>
        <div
          className={`${styles.agentCard} ${focusPanel === 'setup' ? styles.panelActive : styles.panelCollapsed}`}
          onPointerDown={handlePanelPointerDown}
          onClick={e => handlePanelTap('setup', e)}
        >
          <div className={styles.agentCardMain}>
            <div className={styles.agentCardInfo}>
              <h1 className={styles.title}>Agent {agentName}</h1>
              <p className={styles.locationLiner}>📍 {location || 'No location set'}</p>
              <button
                type="button"
                className={styles.modelLiner}
                onClick={ev => { ev.stopPropagation(); setSettingsOpen(true) }}
                title={describeModelFallback(provider)}
              >
                <span className={styles.modelLinerIcon} aria-hidden="true">🧠</span>
                <span>{describeModel(provider, ollamaModel)}</span>
              </button>
            </div>
          </div>

          <div className={styles.agentCardBody}>
          <div className={styles.agentCardScroll}>
            <div className={styles.personalityRow}>
              {(() => {
                // selectedTraits can carry ids from a previously-selected
                // agent type (no longer pruned on type change, see
                // handleAgentTypeChange) — every display below counts/shows
                // only the ids that actually belong to the CURRENT type's
                // pool, so a stale cross-type id never inflates the badge or
                // shows a phantom active trait/effect.
                const activeTraits = (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research)
                  .filter(t => selectedTraits.includes(t.id))
                return (
                  <>
                    <SectionHeader
                      label="Personality (Optional)"
                      expanded={personalityOpen}
                      onToggle={() => setPersonalityOpen(o => !o)}
                      help="Personality traits give the agent a consistent character quirk beyond its raw behavior — e.g. Inquisitive or Meticulous for a researcher. Purely optional flavor that still shapes its generated system prompt, and the pool of traits on offer changes with the agent type below. Active traits are summarized in the Brief below."
                    />
                    {personalityOpen && (
                      <div className={styles.behaviorTogglesRow}>
                        {(PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research).map(t => {
                          const active = selectedTraits.includes(t.id)
                          return (
                            <button
                              key={t.id}
                              type="button"
                              className={active ? styles.behaviorToggleActive : styles.behaviorToggle}
                              onClick={() => toggleTrait(t.id)}
                              disabled={bootstrapping}
                              title={t.instruction}
                              aria-pressed={active}
                            >
                              {t.label}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {personalityOpen && activeTraits.length > 0 && (
                      <ul className={styles.behaviorEffectsList}>
                        {activeTraits.map(t => (
                          <li key={t.id}>
                            <span className={styles.behaviorEffectLabel}>{t.label}:</span> {describeTraitEffect(t)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )
              })()}
            </div>

            <div className={styles.specialInstructionsRow}>
              <SectionHeader
                label="Behavior (Optional)"
                expanded={specialInstructionsOpen}
                onToggle={() => setSpecialInstructionsOpen(o => !o)}
                help="Behavior toggles shape how the agent communicates — concise vs. detailed, skeptical vs. trusting, whether it cites sources, acts proactively, stays formal, or delegates aggressively. Turn on as many as you like; their effects combine. Active toggles are summarized in the Brief below."
              />
              {specialInstructionsOpen && (
                <div className={styles.behaviorIconRow}>
                  {BEHAVIOR_TOGGLES.map(t => {
                    const active = activeToggles.includes(t.id)
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={active ? styles.behaviorIconBtnActive : styles.behaviorIconBtn}
                        onClick={() => toggleBehavior(t.id)}
                        disabled={bootstrapping}
                        title={describeBehaviorEffect(t, agentType, keywords)}
                        aria-label={t.label}
                        aria-pressed={active}
                      >
                        <span className={styles.behaviorIconGlyph} aria-hidden="true"><BehaviorIcon id={t.id} /></span>
                        <span className={styles.behaviorIconLabel}>{t.label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {specialInstructionsOpen && activeToggles.length > 0 && (
                <ul className={styles.behaviorEffectsList}>
                  {BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => (
                    <li key={t.id}>
                      <span className={styles.behaviorEffectLabel}>{t.label}:</span> {describeBehaviorEffect(t, agentType, keywords)}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={styles.specialtiesRow}>
              <SectionHeader
                label="Specialties"
                expanded={specialtiesOpen}
                onToggle={() => setSpecialtiesOpen(o => !o)}
                help="Specialties are the topics, roles, or keywords this agent will actually work on. Add at least one — they drive the Brief below and what the agent searches or reports on once commissioned."
                right={!specialtiesOpen && keywords.length > 0 && (
                  <span className={styles.fieldLabelCount}>{keywords.length}/{savedKeywordPool.length}</span>
                )}
              />
              {specialtiesOpen && (
                <p className={styles.specialtiesHint}>
                  {keywords.length >= MAX_SPECIALTIES
                    ? `Limit of ${MAX_SPECIALTIES} specialties reached — remove one to add another.`
                    : 'Type a keyword and press Enter, or select a Saved Specialty from the Agent Dossier below'}
                </p>
              )}
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
                    placeholder={keywords.length >= MAX_SPECIALTIES ? `Limit of ${MAX_SPECIALTIES} reached` : (keywords.length === 0 ? getTemplate(agentType).keywordPlaceholder : '+ Add Speciality')}
                    disabled={bootstrapping || keywords.length >= MAX_SPECIALTIES}
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
                  </div>
                </div>
              )}
            </div>

            <div className={styles.resetToolbar}>
              <HelpTip
                text="Clears every change made in this form — specialties, behavior, personality — and starts a fresh, blank agent."
                label="Clear agent help"
              />
              <button
                type="button"
                className={styles.profileResetBtn}
                onClick={() => {
                  setKeywords([])
                  setDraft('')
                  setActiveToggles([])
                  setSelectedTraits([])
                  onNewAgent()
                  inputRef.current?.focus()
                }}
                disabled={bootstrapping}
              >
                Clear Agent
              </button>
              <button
                type="button"
                className={styles.characterGenBtn}
                onClick={ev => { ev.stopPropagation(); setCharacterGenOpen(true) }}
              >
                Open Agent Files
              </button>
            </div>

          </div>

          {/* Brief lives in its own subsection, outside the editable-fields
              scroll list above — it's generated from Specialties/Behavior,
              never typed into directly, so it reads as assembled output
              rather than another field to fill in. */}
          <div className={styles.briefSection}>
            <SectionHeader
              label="Brief"
              expanded={briefOpen}
              onToggle={() => setBriefOpen(o => !o)}
              help="The Brief is a live preview of what this agent has agreed to do, generated from its type, specialties, behavior and personality. It's read-only — edit the fields above to change it."
            />
            {briefOpen && (
              keywords.length === 0 ? (
                <p className={styles.briefPlaceholderText}>
                  <span className={styles.briefPlaceholderIcon} aria-hidden="true">✎</span>
                  Add Specialties and behaviors to build this agent’s brief.
                </p>
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
                    {aiBrief?.text ?? buildAgentBrief(
                      agentType,
                      keywords,
                      location.trim(),
                      agentName,
                      BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.label),
                      (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research).filter(t => selectedTraits.includes(t.id)).map(t => t.label),
                    )}
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
          </div>

          <div className={styles.profileCommissionRow}>
              {commissionHint && (
                <p className={styles.commissionHint} role="status">{commissionHint}</p>
              )}
              <div className={styles.commissionGroup}>
                <HelpTip
                  text="Agent type decides which primitive tools and default behavior this agent gets — e.g. only a Job search agent can call the live job-listings tool. Switching types also swaps the personality traits on offer above. The save icon stores this whole profile for later; Deploy bootstraps it and starts the chat."
                  label="Commission bar help"
                  direction="up"
                />
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
                  type="button"
                  className={`${styles.profileSaveBtn} ${styles.profileSaveBtnCommission}`}
                  onClick={saveAgentDraft}
                  disabled={bootstrapping}
                  title="Save Agent profile — name, type, location and specialties"
                  aria-label="Save agent"
                >
                  <span aria-hidden="true"><SaveIcon /></span>
                </button>
                <button
                  type="submit"
                  form="agentSetupForm"
                  className={`${styles.profileCommissionBtn} ${keywords.length === 0 ? styles.profileCommissionBtnBlocked : ''}`}
                  disabled={bootstrapping}
                  aria-disabled={keywords.length === 0}
                >
                  {bootstrapping ? 'Configuring…' : 'Deploy >'}
                </button>
              </div>
            </div>
        </div>

        <form
          id="agentSetupForm"
          onSubmit={handleSubmit}
          onPointerDown={handlePanelPointerDown}
          onClick={e => handlePanelTap('dossier', e)}
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
                      const atCap = !alreadyAdded && keywords.length >= MAX_SPECIALTIES
                      const toggle = () => { if (bootstrapping || atCap) return; if (alreadyAdded) { removeKeyword(kw) } else { addSavedKeyword(kw) } }
                      return (
                        <div
                          key={kw}
                          className={`${styles.savedKeywordChip} ${alreadyAdded ? styles.savedKeywordChipAdded : ''} ${atCap ? styles.savedKeywordChipDisabled : ''}`}
                          role="button"
                          tabIndex={bootstrapping || atCap ? -1 : 0}
                          onClick={toggle}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
                          aria-pressed={alreadyAdded}
                          aria-disabled={atCap}
                          aria-label={alreadyAdded ? `${kw} is in current specialties — tap to remove` : atCap ? `Cannot add ${kw} — limit of ${MAX_SPECIALTIES} specialties reached` : `Add saved specialty ${kw} to current specialties`}
                          title={alreadyAdded ? 'Tap to remove from current specialties' : atCap ? `Limit of ${MAX_SPECIALTIES} specialties reached` : 'Tap to add to current specialties'}
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
                          onClick={ev => { ev.stopPropagation(); loadDraft(d) }}
                          title={bootstrapping ? 'Agent is being commissioned — profiles can’t be loaded right now' : 'Load this agent profile'}
                          aria-disabled={bootstrapping}
                        >
                          <div className={styles.savedChatInfo}>
                            <span className={styles.savedChatName}>Agent {d.agentName}</span>
                            <div className={styles.savedPillRow}>
                              {(d.behaviorToggles ?? []).map(id => (
                                <span key={id} className={styles.savedBehaviorBadge}>
                                  {BEHAVIOR_TOGGLES.find(t => t.id === id)?.label ?? id}
                                </span>
                              ))}
                              {d.traits.map(label => (
                                <span key={label} className={styles.savedTraitBadge}>{label}</span>
                              ))}
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
                          onClick={ev => { ev.stopPropagation(); loadChatDetails(c) }}
                          title={bootstrapping ? 'Agent is being commissioned — details can’t be loaded right now' : 'Load this agent’s details into the form'}
                          aria-disabled={bootstrapping}
                        >
                          <div className={styles.savedChatInfo}>
                            <span className={styles.savedChatName}>Agent {c.agentName}</span>
                            {c.agentConfig.persona?.traits && c.agentConfig.persona.traits.length > 0 && (
                              <span className={styles.savedChatTraits}>{c.agentConfig.persona.traits.join(' · ')}</span>
                            )}
                            {c.agentConfig.keywords && c.agentConfig.keywords.length > 0 && (
                              <div className={styles.savedChips}>
                                {[...c.agentConfig.keywords].sort((a, b) => a.localeCompare(b)).map(kw => (
                                  <span key={kw} className={styles.savedChip}>{kw}</span>
                                ))}
                              </div>
                            )}
                            {c.agentConfig.active_toggles && c.agentConfig.active_toggles.length > 0 && (
                              <div className={styles.savedBehaviorBadges}>
                                {c.agentConfig.active_toggles.map(id => (
                                  <span key={id} className={styles.savedBehaviorBadge}>
                                    {BEHAVIOR_TOGGLES.find(t => t.id === id)?.label ?? id}
                                  </span>
                                ))}
                              </div>
                            )}
                            {lastChatLine(c.messages) && (
                              <span className={styles.savedChatPreview}>{lastChatLine(c.messages)}</span>
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
                <FeedbackStatusBar
                  results={evalResults}
                  collapsed={evalBarCollapsed}
                  onToggleCollapse={() => setEvalBarCollapsed(c => !c)}
                  onClear={() => setEvalResults([])}
                />
              </>
            ) : error ? (
              <div className={styles.errorPanel}>
                <span className={styles.errorIcon} aria-hidden="true">⚠</span>
                <div className={styles.errorMessageRow}>
                  <div className={styles.errorBody}>
                    <p className={styles.errorHeadline}>Couldn't design this agent</p>
                    <p className={styles.errorDetail}>{error}</p>
                  </div>
                  <button type="button" className={styles.errorRetry} onClick={runBootstrap}>
                    ↻ Retry
                  </button>
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

      <CharacterGenerator
        isOpen={characterGenOpen}
        agentType={agentType}
        onClose={() => setCharacterGenOpen(false)}
        onEmploy={character => {
          onAgentNameChange(character.surname)
          setAgentType(character.agentType)
          setSelectedTraits(character.traitIds)
          setActiveToggles(character.behaviorIds)
          setKeywords(character.specialties)
        }}
      />
    </div>
  )
}

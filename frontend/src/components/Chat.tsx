import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { buildRelic, publishAgent, runAgent } from '../api'
import { saveChat, setLastOpenedPointer } from '../chatStorage'
import { buildChatPdf, type PdfAgentContext, type PdfMessage } from '../chatPdf'
import { BEHAVIOR_TOGGLES, PERSONALITY_TRAITS } from '../agentTypes'
import ToolActivity from './ToolActivity'
import GraphView from './GraphView'
import { appendTimelineNode, nextSeq, type TimelineNode } from '../graphTimeline'
import MermaidDiagram from './MermaidDiagram'
import JsonTree from './JsonTree'
import CodeBlock from './CodeBlock'
import PdfPreviewModal from './PdfPreviewModal'
import RelicPreviewModal from './RelicPreviewModal'
import { downloadRelic, RELIC_KINDS, RELIC_LABELS, relicFilename } from '../relicFiles'
import ImageViewer from './ImageViewer'
import FeedbackStatusBar from './FeedbackStatusBar'
import type { AgentConfig, EvalResultItem, Relic, RelicKind, RelicSuggestion, ResultFeedback, SavedChat, SavedChatMessage, StreamEvent, ToolCall } from '../types'
import { describeModel, describeModelFallback, formatModelInfo, type ModelInfo } from '../modelLabel'
import { normalizeInlineOrderedLists } from '../markdownFormat'
import { formatDate, getDateFormat } from '../dateFormat'
import { extractMermaidDiagrams } from '../mermaidExtract'
import AgentBriefingModal, { briefingHidden } from './AgentBriefingModal'
import ResultRating from './ResultRating'
import styles from '../styles/Chat.module.css'
import splashLogo from '../assets/favicon.png'

type ToolbarIconName = 'save' | 'saved' | 'roster' | 'export' | 'exporting' | 'copyChat' | 'copiedChat' | 'newAgent' | 'attach' | 'imagePlaceholder' | 'send' | 'location' | 'clock'

// Safety net for agent_stream.py's rule 4b ("never paste raw tool output into
// your reply") in case a model ignores it anyway — a whole paragraph that's
// nothing but a JSON object/array (a raw search-API payload pasted verbatim,
// not prose that merely mentions JSON) is pulled out and rendered as a
// browsable JsonTree instead of an unreadable single-line blob of markdown text.
function extractJsonBlobs(content: string): { text: string; blobs: unknown[] } {
  const blobs: unknown[] = []
  const paragraphs = content.split(/\n{2,}/).filter(para => {
    const trimmed = para.trim()
    const looksLikeJson = (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    if (!looksLikeJson) return true
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null) return true
      blobs.push(parsed)
      return false
    } catch {
      return true
    }
  })
  return { text: paragraphs.join('\n\n'), blobs }
}

// Walks a rendered markdown <li>'s React children down to plain text, for
// the "Extend upon this idea" button's follow-up prompt — it needs the
// bullet's own words, not its JSX (bold/links/inline code all render as
// nested elements, not strings). Nested <ul>/<ol> are skipped so a bullet
// with its own sub-list doesn't drag the whole sub-list's text into what's
// meant to be just this one idea.
function listItemPlainText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(listItemPlainText).join('')
  if (isValidElement(node)) {
    if (node.type === 'ul' || node.type === 'ol') return ''
    return listItemPlainText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

// Thumbnail strip of every image the agent has actually produced/found this
// chat (generate_image/search_image results, embedded by the model as
// markdown in its own reply) — collected by scanning each assistant
// message's raw content for markdown image syntax rather than tracking
// tool results directly, since it's the model's own reply that decides
// what actually gets shown, same source the img() renderer below reads.
function extractImageAssets(messages: ChatMessage[]): { url: string; alt: string }[] {
  const seen = new Set<string>()
  const assets: { url: string; alt: string }[] = []
  const re = /!\[([^\]]*)\]\((\S+?)\)/g
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.content) continue
    let match: RegExpExecArray | null
    while ((match = re.exec(msg.content))) {
      const [, alt, url] = match
      if (seen.has(url)) continue
      seen.add(url)
      assets.push({ url, alt })
    }
  }
  return assets
}

// Mono line icons for the header toolbar — same stroke-based style as
// Setup.tsx's AgentTypeIcon (currentColor, no fill), styled after plain
// Office-suite toolbar glyphs (floppy-disk save, badge-check roster, document
// export, spinner) instead of full-colour emoji, so the toolbar reads as one
// coherent teal-on-cream unit rather than a row of mismatched platform emoji.
function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'save':
      return (
        <svg {...common}>
          <path d="M5 3.5h11l3.5 3.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z" />
          <path d="M7.5 3.5V8h7.5V3.5" />
          <rect x="7" y="13" width="10" height="7" />
        </svg>
      )
    case 'saved':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9.25" />
          <path d="M7.5 12.5 10.3 15.3 16.5 9" />
        </svg>
      )
    case 'roster':
      return (
        <svg {...common}>
          <path d="M12 3.25l6.25 2.5v4.75c0 4.6-2.9 7.85-6.25 9.5-3.35-1.65-6.25-4.9-6.25-9.5V5.75L12 3.25Z" />
          <path d="M8.75 12.25 11 14.5l4.25-4.75" />
        </svg>
      )
    case 'export':
      return (
        <svg {...common}>
          <path d="M6.5 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 6.5 3.5Z" />
          <path d="M13 3.5V8h4.5" />
          <line x1="12" y1="11.5" x2="12" y2="17" />
          <path d="M9.3 14.3 12 17l2.7-2.7" />
        </svg>
      )
    case 'exporting':
      return (
        <svg {...common} className={styles.spinnerIcon}>
          <path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5" />
        </svg>
      )
    // Whole-conversation "copy as HTML" toolbar button — a clipboard glyph
    // (distinct from CopyButton.tsx's own per-block plain-text icon, which
    // is a text label, not an SVG) so this reads as a header-toolbar action
    // alongside save/roster/export rather than an inline code-block control.
    case 'copyChat':
      return (
        <svg {...common}>
          <rect x="8" y="7" width="10.5" height="13.5" rx="1.3" />
          <path d="M8 9.5H6.5A1.3 1.3 0 0 0 5.2 10.8V19a1.3 1.3 0 0 0 1.3 1.3H14a1.3 1.3 0 0 0 1.3-1.3v-1.2" />
          <path d="M10.5 4h4.5a1 1 0 0 1 1 1v2h-6.5V5a1 1 0 0 1 1-1Z" />
        </svg>
      )
    case 'copiedChat':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9.25" />
          <path d="M7.5 12.5 10.3 15.3 16.5 9" />
        </svg>
      )
    case 'newAgent':
      return (
        <svg {...common}>
          <circle cx="10.5" cy="8.5" r="3.5" />
          <path d="M4 20c0-3.6 2.9-6 6.5-6 1 0 1.94.18 2.78.52" />
          <line x1="17.5" y1="10.5" x2="17.5" y2="16.5" />
          <line x1="14.5" y1="13.5" x2="20.5" y2="13.5" />
        </svg>
      )
    case 'attach':
      return (
        <svg {...common}>
          <path d="M16.5 6.5 8.7 14.3a3 3 0 1 0 4.24 4.24l7.1-7.1a5 5 0 1 0-7.07-7.07L5.5 11.84" />
        </svg>
      )
    // Shown in the composer's attachment chip while an image is still being
    // read off disk (FileReader is async) — a generic "image slot, not yet
    // filled in" glyph rather than leaving the chip blank/empty-looking.
    case 'imagePlaceholder':
      return (
        <svg {...common} className={styles.spinnerIcon}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="M4 16.5 9 12l3 2.5 4-3.5 4 4" />
        </svg>
      )
    // Send button's icon-only glyph, now that it's a circular button rather
    // than a labeled "Send" rectangle — an upward paper-plane arrow reads as
    // "submit" without needing text.
    case 'send':
      return (
        <svg {...common}>
          <line x1="12" y1="19" x2="12" y2="5" />
          <path d="M6 11 12 5l6 6" />
        </svg>
      )
    // Header meta badges (location/date-time) — same monochrome stroke set
    // as the toolbar glyphs above, replacing full-colour platform emoji so
    // the pills read as one teal-on-cream unit rather than mismatched emoji.
    case 'location':
      return (
        <svg {...common}>
          <path d="M12 21s-7-6.1-7-11.5a7 7 0 1 1 14 0C19 14.9 12 21 12 21Z" />
          <circle cx="12" cy="9.5" r="2.25" />
        </svg>
      )
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3.25 2" />
        </svg>
      )
  }
}

interface LiveToolCall {
  tool: string
  inputs: Record<string, unknown>
  result?: string
  source?: ToolCall['source']
  callIndex: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  // The user's optional 👍/👎 (+ note) on this result; see ResultRating.
  feedback?: ResultFeedback
  // What the user bubble actually shows, when it needs to differ from the
  // literal text sent to the backend as this turn's user message — e.g. the
  // auto-fired initial search still sends a standardized instruction (the
  // backend needs something concrete to act on), but the bubble shows the
  // agent's own original setup purpose instead of that boilerplate.
  // Undefined on every ordinary typed message, where content IS the display.
  displayContent?: string
  // Base64 data URL of an image attached to this turn (composer's
  // paperclip button). Undefined on every message that isn't an upload.
  image?: string
  toolCalls?: ToolCall[]
  liveToolCalls?: LiveToolCall[]
  // Ordered trace of this turn's plan/status/tool/done events, for the
  // toggleable "Graph view" (GraphView.tsx) — accumulated alongside, not
  // instead of, liveToolCalls/toolCalls above. Undefined on a message
  // reloaded from a saved chat (SavedChatMessage carries no trace), in
  // which case GraphView just shows its own "no trace recorded" fallback.
  timeline?: TimelineNode[]
  // The agent's own step-by-step plan for this turn (agent_stream.py's
  // ```mermaid-plan fence) — distinct from the tool-call trace and from any
  // ```mermaid diagram embedded in `content` itself. Rendered at the top of
  // the assistant bubble, i.e. right after the preceding user message.
  planDiagram?: string
  // The one-sentence plain-language lead-in the backend extracts from
  // immediately before the ```mermaid-plan fence (agent_stream.py rule 6) —
  // the diagram alone doesn't tell a user what's about to happen.
  planSummary?: string
  durationSeconds?: number
  usage?: { input_tokens: number; output_tokens: number }
  rateLimits?: { tokens_remaining: string | null; tokens_limit: string | null; requests_remaining: string | null; tokens_reset: string | null }
  // Output relics the agent offered for this answer (done event's
  // relic_suggestions); each renders as a chip that builds the file on click.
  relicSuggestions?: RelicSuggestion[]
  // Relics the user has built from this answer (one per kind), kept so they
  // can be previewed and downloaded again without another model call.
  relics?: Relic[]
}

// Same wording as FeedbackReportModal.tsx's own targetLabel — kept as a
// separate local copy (that component has no shared-util home to import
// from) rather than introducing a new shared module for one small function.
function evalTargetLabel(item: EvalResultItem): string {
  switch (item.target) {
    case 'bootstrap':
      return item.target_id ? `Agent setup (${item.target_id})` : 'Agent setup'
    case 'chat_response':
      return 'Chat response'
    case 'tool_call':
      return item.target_id !== null ? `Tool call #${item.target_id}` : 'Tool call'
    case 'worker_delegation':
      return item.target_id ? `Worker ${item.target_id}` : 'Worker'
    default:
      return item.target
  }
}

interface Props {
  agentConfig: AgentConfig
  agentName: string
  onReset: () => void
  // Navigates back to the Setup/search screen without touching the current
  // conversation's state — distinct from onReset (which recommissions this
  // same agent, wiping its messages). Wired to the header logo below.
  onBackToSetup: () => void
  // Present when jumping straight in from a saved chat (App.tsx's
  // onResumeChat), bypassing bootstrap entirely.
  initialMessages?: SavedChatMessage[]
  chatId?: string
}

export default function Chat({ agentConfig, agentName, onReset, onBackToSetup, initialMessages, chatId }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialMessages ?? [])
  const [input, setInput] = useState('')
  // Fresh agent: mission briefing. Resumed chat (initialMessages): an
  // in-character "Previously…" recap of the story so far.
  const [showBriefing, setShowBriefing] = useState(() => !briefingHidden())
  const [thinking, setThinking] = useState(false)
  // What the backend says it's currently doing while `thinking` is true
  // (agent_stream.py's 'status' events) — shown in place of a bare "Working"
  // spinner so a multi-step turn (retries, tool-result review, the
  // self-eval pass) doesn't look stalled. Cleared whenever a tool_start
  // arrives (the tool card itself becomes the "what's happening" signal)
  // and whenever the turn ends.
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  // Running token count across every LLM call so far this turn
  // (agent_stream.py's 'status' events now carry it) — real, already-
  // computed usage, not just a static status label.
  const [statusTokens, setStatusTokens] = useState<{ input_tokens: number; output_tokens: number } | null>(null)
  // Which provider/model is actually serving this turn's LLM calls, and
  // whether any provider failed over mid-turn (agent_stream.py's 'model'
  // event) — previously invisible during chat; bootstrap already surfaced
  // this via the same event shape.
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [now, setNow] = useState(() => new Date())
  const [error, setError] = useState<string | null>(null)
  // "Add to Roster" is one hiring-themed action that both keeps this
  // conversation (saveChat, local) and files the agent itself as a standing,
  // externally-callable MCP tool (publishAgent, server-side registry) — the
  // agent's track record and its "personnel file" are the same event now,
  // not two separate buttons. Publishing is still a manual, reviewed step
  // (not automatic on bootstrap) since generated tool code has no real
  // sandbox (see AIAgent/CLAUDE.md Limitation #2), so only an agent the user
  // has actually exercised in chat gets made permanently externally-callable.
  const [rosterOpen, setRosterOpen] = useState(false)
  const [rosterName, setRosterName] = useState(agentName)
  const [rosterDescription, setRosterDescription] = useState(agentConfig.purpose ?? '')
  const [addingToRoster, setAddingToRoster] = useState(false)
  const [rosterFeedback, setRosterFeedback] = useState<string | null>(null)
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [relicBusy, setRelicBusy] = useState<string | null>(null)
  const [relicError, setRelicError] = useState<{ key: string; message: string } | null>(null)
  const [relicPreview, setRelicPreview] = useState<{ index: number; kind: RelicKind } | null>(null)
  const [exportMenuFor, setExportMenuFor] = useState<number | null>(null)
  const [pdfPreview, setPdfPreview] = useState<{ blobUrl: string; filename: string; doc: ReturnType<typeof buildChatPdf> } | null>(null)
  // Rendered markdown DOM per assistant message index, so PDF export can
  // walk react-markdown's actual output (link hrefs, list/heading structure)
  // instead of re-parsing the raw markdown string itself.
  const markdownRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  // Sentinel scrolled into view on every feed update (new message, streamed
  // tool_start/tool_result, finished reply) so the transcript follows along
  // live instead of leaving a fast-moving run sitting below the fold.
  const bottomRef = useRef<HTMLDivElement>(null)
  // Stable identity for this conversation so re-saving it (after more
  // messages) updates the same localStorage entry instead of duplicating it.
  const chatIdRef = useRef(chatId ?? crypto.randomUUID())
  // Only a genuinely fresh bootstrap (App.tsx's handleBootstrapDone, which
  // never passes a chatId) should auto-fire the initial search below. Every
  // path that supplies a chatId is some flavor of "resume" — a real saved
  // chat with its own history, or hiring a published agent straight into a
  // blank chat (Setup.tsx's hirePublishedAgent) — and neither should replay
  // the bootstrap-only auto-search, even when there's no history yet to
  // check the length of.
  const autoSentRef = useRef(Boolean(chatId))
  const abortRef = useRef<AbortController | null>(null)
  // Composer's attached-image state. `attachingImage` covers the brief
  // window while FileReader is still converting the picked file to a data
  // URL — the attachment chip shows the imagePlaceholder glyph then, so the
  // slot never reads as empty/broken before the real image is filled in.
  const [attachedImage, setAttachedImage] = useState<string | null>(null)
  const [attachingImage, setAttachingImage] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [viewerImage, setViewerImage] = useState<string | null>(null)
  // Self-evaluation status bar (root CLAUDE.md eval-framework task) — accrues
  // for the whole session, not just the latest turn, since bootstrap-time
  // checks (relayed from a delegated worker, or the agent's own setup) have
  // no single chat message to attach to. Capped client-side; the backend's
  // own eval_results.json is the durable, uncapped log.
  const [evalResults, setEvalResults] = useState<EvalResultItem[]>([])
  const [evalBarCollapsed, setEvalBarCollapsed] = useState(true)
  // Per-message "Graph view" toggle (default off — the existing ToolActivity
  // log stays the default view per the confirmed scope). Keyed by message
  // index, which is stable for the lifetime of one chat session's array.
  const [graphViewMessages, setGraphViewMessages] = useState<Set<number>>(new Set())
  function toggleGraphView(i: number) {
    setGraphViewMessages(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  // The agent's specialty pool, fixed at bootstrap — shown read-only in the
  // chat header and sent with each /agent request (agent_stream.py's
  // _delegation_rule_body iterates over it). Changing focus means going back
  // to Setup, not editing it mid-chat.
  const focusPool = agentConfig.keywords ?? []

  // Recomputed whenever messages changes, so a new image shows up in the
  // strip as soon as the reply that carries it finishes streaming in.
  const assets = useMemo(() => extractImageAssets(messages), [messages])

  // Auto-send an initial task when the agent has a configured focus
  // pool. The pool itself (focusPool) is now the keyword source the
  // backend's delegation rule iterates over (see agent_stream.py's
  // _delegation_rule_body) — this message no longer needs to spell out
  // each keyword itself, just hand over a generic task.
  useEffect(() => {
    if (autoSentRef.current) return
    const kws = focusPool
    if (!kws?.length) return
    autoSentRef.current = true
    // Deliberately says nothing about "search" or location: a specialty in
    // the pool might be a creative/image-generation task (e.g. "clown
    // images") rather than anything to research, and location is already
    // (a) shown as its own pill in the header and (b) injected into the
    // system prompt every turn via agent_stream.py's _location_note, which
    // tells the model to assume it "for anything location-dependent"
    // without it needing to be restated here. A previous version of this
    // message baked in "run your standard search ... in <location>", which
    // — for a non-research specialty with no natural search target — gave
    // a delegated worker's own bootstrap nothing concrete to latch onto
    // except the location text, so it searched the location itself instead
    // of doing anything related to the actual specialty.
    const text = 'Produce your standard output across your full focus pool.'
    sendMessage(text, messages, undefined, text)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function buildSavedChat(): SavedChat {
    return {
      id: chatIdRef.current,
      agentName,
      agentConfig: { ...agentConfig, keywords: focusPool },
      messages: messages.map(({ role, content, feedback, displayContent, image, toolCalls, planDiagram, planSummary, durationSeconds, usage, rateLimits, relicSuggestions, relics }) => ({
        role, content, feedback, displayContent, image, toolCalls, planDiagram, planSummary, durationSeconds, usage, rateLimits, relicSuggestions, relics,
      })),
      savedAt: Date.now(),
    }
  }

  function saveChatLocally() {
    saveChat(buildSavedChat())
    // An explicit save is also an implicit "this is the one to reopen on
    // reload" — otherwise a freshly-bootstrapped-then-saved chat would only
    // become reopenable the next time it's resumed from the dossier, not
    // immediately after the save that made it possible to resume at all.
    setLastOpenedPointer({ kind: 'savedChat', id: chatIdRef.current })
  }

  // Downloads the same SavedChat shape saveChatLocally() writes to
  // localStorage, but as a portable .json file — the reloadable counterpart
  // to the PDF export, readable back in via Setup.tsx's "Load Chat File".
  function handleSaveChatFile() {
    const chat = buildSavedChat()
    const blob = new Blob([JSON.stringify(chat, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const safeName = agentName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'agent'
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const a = document.createElement('a')
    a.href = url
    a.download = `chat-${safeName}-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleSaveChat() {
    if (messages.length === 0) return
    saveChatLocally()
    setSaveFeedback('Saved ✓')
    window.setTimeout(() => setSaveFeedback(null), 2000)
  }

  async function handleAddToRoster() {
    const name = rosterName.trim()
    if (!name || addingToRoster) return
    setAddingToRoster(true)
    setRosterFeedback(null)
    try {
      saveChatLocally()
      await publishAgent(name, rosterDescription.trim(), agentConfig)
      setRosterFeedback(`Added "${name}" to the roster ✓`)
      setRosterOpen(false)
    } catch (err) {
      setRosterFeedback(err instanceof Error ? err.message : 'Failed to add agent to roster')
    } finally {
      setAddingToRoster(false)
      window.setTimeout(() => setRosterFeedback(null), 4000)
    }
  }

  function handleExportPdf() {
    if (messages.length === 0 || exporting) return
    setExporting(true)
    try {
      const pdfMessages: PdfMessage[] = messages
        .map((m, i) => ({
          role: m.role,
          content: m.displayContent ?? m.content,
          contentEl: m.role === 'assistant' ? markdownRefs.current.get(i) ?? null : null,
          toolCallCount: m.toolCalls?.length,
          toolCalls: m.toolCalls,
          durationSeconds: m.durationSeconds,
          usage: m.usage,
        }))
        .filter(m => m.content || m.toolCallCount)

      const traitPool = PERSONALITY_TRAITS[agentConfig.template ?? 'research'] ?? PERSONALITY_TRAITS.research
      const context: PdfAgentContext = {
        purpose: agentConfig.purpose,
        keywords: focusPool,
        location: agentConfig.location,
        model: describeModel(agentConfig.provider, agentConfig.ollama_model),
        persona: agentConfig.persona,
        behaviorToggles: (agentConfig.active_toggles ?? [])
          .map(id => BEHAVIOR_TOGGLES.find(t => t.id === id)?.label ?? id),
        personalityTraits: (agentConfig.active_traits ?? [])
          .map(id => traitPool.find(t => t.id === id)?.label ?? id),
        tools: agentConfig.tools.map(t => t.name),
      }
      const doc = buildChatPdf(`Agent ${agentName}`, pdfMessages, context)
      const safeName = agentName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'agent'
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const filename = `chat-${safeName}-${stamp}.pdf`
      const blobUrl = doc.output('bloburl').toString()
      setPdfPreview({ blobUrl, filename, doc })
    } catch (err) {
      setError(err instanceof Error ? `PDF export failed: ${err.message}` : 'PDF export failed')
    } finally {
      setExporting(false)
    }
  }

  function handleDownloadPdf() {
    if (!pdfPreview) return
    pdfPreview.doc.save(pdfPreview.filename)
  }

  // Builds a relic (POST /relic) and opens its preview; the user downloads
  // from there. A relic already built for this answer just reopens, unless
  // `regenerate`. The answer alone is thin when workers did the research
  // (rule 7: the main reply only synthesises), so their responses travel
  // with it.
  async function handleBuildRelic(index: number, kind: RelicKind, reason = '', regenerate = false) {
    const key = `${index}-${kind}`
    const msg = messages[index]
    setExportMenuFor(null)
    if (!regenerate && msg.relics?.some(r => r.kind === kind)) {
      setRelicPreview({ index, kind })
      return
    }
    if (relicBusy) return
    const question = messages.slice(0, index).reverse().find(m => m.role === 'user')?.content ?? ''
    const workers = (msg.toolCalls ?? [])
      .filter(tc => tc.tool === 'delegate_to_worker')
      .map(tc => { try { return JSON.parse(tc.result) as Record<string, unknown> } catch { return null } })
      .filter((w): w is Record<string, unknown> => !!w && typeof w.response === 'string')
      .map(w => ({ name: String(w.worker_name ?? 'worker'), task: String(w.task ?? ''), response: String(w.response) }))
    const suggestedReason = reason || msg.relicSuggestions?.find(s => s.kind === kind)?.reason || ''

    setRelicBusy(key)
    setRelicError(null)
    try {
      const content = await buildRelic({ kind, reason: suggestedReason }, question, msg.content, workers, agentConfig, agentName)
      const relic: Relic = { kind, content, createdAt: new Date().toISOString() }
      setMessages(prev => prev.map((m, j) => j === index
        ? { ...m, relics: [...(m.relics ?? []).filter(r => r.kind !== kind), relic] }
        : m))
      setRelicPreview({ index, kind })
    } catch (err) {
      setRelicError({ key, message: err instanceof Error ? err.message : 'Could not build that file' })
    } finally {
      setRelicBusy(null)
    }
  }

  async function handleDownloadRelic(relic: Relic) {
    try {
      await downloadRelic(relic, agentName)
    } catch (err) {
      setRelicError({ key: `${relicPreview?.index}-${relic.kind}`, message: err instanceof Error ? err.message : 'Download failed' })
    }
  }

  function handleClosePdfPreview() {
    if (pdfPreview) URL.revokeObjectURL(pdfPreview.blobUrl)
    setPdfPreview(null)
  }

  // Builds a self-contained HTML document of the whole visible transcript —
  // "Copy chat" pastes real formatting (headings/bold/lists/links/tables)
  // into rich-text targets (email, Docs, Word) instead of raw markdown
  // source. Assistant turns reuse react-markdown's own rendered DOM via
  // markdownRefs (same technique the PDF export already uses to avoid
  // re-parsing markdown a second time) so the copied HTML matches exactly
  // what's on screen; a message with no rendered ref yet (still streaming)
  // falls back to its plain text. Tool-call/plan details are intentionally
  // left out — this is a copy of the conversation's text, not its full
  // internal trace (that's what PDF/JSON export are for).
  function buildChatHtmlAndText(): { html: string; text: string } {
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const escapeToParagraphs = (s: string) =>
      s
        .split(/\n{2,}/)
        .map(para => `<p style="margin:0 0 0.6em;">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
        .join('')

    const blocks: string[] = []
    const textLines: string[] = []
    messages.forEach((msg, i) => {
      const shownText = msg.displayContent ?? msg.content
      if (!shownText) return
      const isUser = msg.role === 'user'
      const label = isUser ? 'You' : `Agent ${agentName}`
      const bodyHtml = !isUser && markdownRefs.current.get(i)
        ? markdownRefs.current.get(i)!.innerHTML
        : escapeToParagraphs(shownText)
      blocks.push(
        `<div style="margin:0 0 1.1em;">` +
        `<p style="margin:0 0 0.3em;font-weight:600;color:${isUser ? '#053750' : '#1f6f73'};">${escapeHtml(label)}</p>` +
        `<div>${bodyHtml}</div>` +
        `</div>`
      )
      textLines.push(`${label}:\n${shownText}\n`)
    })

    const html =
      `<div style="font-family:Inter,'Segoe UI',sans-serif;color:#1f2937;max-width:720px;">` +
      `<h2 style="margin:0 0 0.8em;color:#053750;">Agent ${escapeHtml(agentName)} — Chat Transcript</h2>` +
      blocks.join('') +
      `</div>`
    const text = `Agent ${agentName} — Chat Transcript\n\n${textLines.join('\n')}`
    return { html, text }
  }

  async function handleCopyChat() {
    if (messages.length === 0) return
    const { html, text } = buildChatHtmlAndText()
    try {
      if (typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([text], { type: 'text/plain' }),
          }),
        ])
      } else {
        await navigator.clipboard.writeText(text)
      }
      setCopyFeedback('Copied ✓')
    } catch {
      // Clipboard API unavailable/denied — fall back to a plain-text write
      // before giving up entirely, so this still works in more restrictive
      // browser contexts even without HTML formatting.
      try {
        await navigator.clipboard.writeText(text)
        setCopyFeedback('Copied ✓')
      } catch {
        setCopyFeedback('Copy failed')
      }
    } finally {
      window.setTimeout(() => setCopyFeedback(null), 2000)
    }
  }

  useEffect(() => {
    if (!thinking) { setElapsed(0); return }
    const t = setInterval(() => setElapsed(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [thinking])

  // Live clock shown under the location badge — the agent's location context
  // (weather/news/job-search results) is time-sensitive, so a stale page
  // left open should still show the current time rather than whenever it
  // first loaded. Minute resolution is all the badge displays, so a 30s tick
  // is plenty rather than a full per-second re-render.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

  function updateLastMessage(updater: (prev: ChatMessage) => ChatMessage) {
    setMessages(msgs => {
      const last = msgs[msgs.length - 1]
      if (!last || last.role !== 'assistant') return msgs
      return [...msgs.slice(0, -1), updater(last)]
    })
  }

  function stopAgent() {
    abortRef.current?.abort()
  }

  // Stop relies on the fetch's AbortError actually propagating through
  // sendMessage's catch block to clear `thinking`/liveToolCalls — if that
  // never happens (a hung stream that doesn't reject cleanly), the composer
  // stays locked with no way to send another message. Kill doesn't wait on
  // that: it aborts AND unconditionally forces the UI back to a clean,
  // sendable state itself, dropping the in-progress assistant placeholder
  // if it never got any content. Distinct from Recommission, which wipes
  // the whole conversation and starts a fresh agent — this only unsticks
  // the current turn.
  function killAgent() {
    abortRef.current?.abort()
    setMessages(msgs => {
      const last = msgs[msgs.length - 1]
      if (last && last.role === 'assistant' && !last.content && !last.toolCalls?.length) {
        return msgs.slice(0, -1)
      }
      return last && last.role === 'assistant' ? [...msgs.slice(0, -1), { ...last, liveToolCalls: undefined }] : msgs
    })
    setError(null)
    setThinking(false)
  }

  function handleAttachClick() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAttachingImage(true)
    const reader = new FileReader()
    reader.onload = () => {
      setAttachedImage(typeof reader.result === 'string' ? reader.result : null)
      setAttachingImage(false)
    }
    reader.onerror = () => setAttachingImage(false)
    reader.readAsDataURL(file)
  }

  function clearAttachedImage() {
    setAttachedImage(null)
  }

  async function sendMessage(text: string, currentMessages: ChatMessage[] = messages, image?: string, displayText?: string) {
    if ((!text.trim() && !image) || thinking) return
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    const userMsg: ChatMessage = { role: 'user', content: text, displayContent: displayText, image }
    const withUser = [...currentMessages, userMsg]
    setMessages([...withUser, { role: 'assistant', content: '', liveToolCalls: [] }])
    setThinking(true)
    setStatusMessage(null)
    setStatusTokens(null)
    setModelInfo(null)

    const apiMessages = withUser.map(m => ({ role: m.role, content: m.content, image: m.image, feedback: m.feedback }))
    // Send the live, possibly-edited focus pool rather than the static
    // bootstrap-time prop — agent_stream.py rebuilds its delegation
    // instruction from this field fresh on every request.
    const liveAgentConfig = { ...agentConfig, keywords: focusPool }

    try {
      await runAgent(apiMessages, liveAgentConfig, (event: StreamEvent) => {
        switch (event.type) {
          case 'plan':
            updateLastMessage(msg => ({
              ...msg,
              planDiagram: event.diagram,
              planSummary: event.summary ?? undefined,
              timeline: appendTimelineNode(msg.timeline ?? [], { id: 'plan', kind: 'plan', seq: nextSeq(), summary: event.summary }),
            }))
            break

          case 'status':
            setStatusMessage(event.message)
            if (event.tokens_so_far) setStatusTokens(event.tokens_so_far)
            updateLastMessage(msg => {
              const seq = nextSeq()
              return {
                ...msg,
                timeline: appendTimelineNode(msg.timeline ?? [], { id: `status-${seq}`, kind: 'status', seq, message: event.message }),
              }
            })
            break

          case 'model':
            setModelInfo({ used: event.used, failed: event.failed })
            break

          case 'tool_start':
            setStatusMessage(null)
            updateLastMessage(msg => ({
              ...msg,
              liveToolCalls: [
                ...(msg.liveToolCalls ?? []),
                { tool: event.tool, inputs: event.inputs, source: event.source, callIndex: event.call_index },
              ],
              timeline: appendTimelineNode(msg.timeline ?? [], {
                id: `tool-${event.call_index}`, kind: 'tool', seq: nextSeq(),
                callIndex: event.call_index, tool: event.tool, inputs: event.inputs, source: event.source,
              }),
            }))
            break

          case 'tool_result':
            // Delegated workers now run concurrently on the backend, so
            // several tool_start entries for the same tool name (e.g. two
            // pending delegate_to_worker calls) can be pending at once —
            // matching by call_index (not "first pending same-named entry")
            // is what keeps each result attached to the right card.
            updateLastMessage(msg => ({
              ...msg,
              liveToolCalls: (msg.liveToolCalls ?? []).map(tc =>
                tc.callIndex === event.call_index
                  ? { ...tc, result: event.result, source: tc.source ?? event.source }
                  : tc
              ),
              timeline: appendTimelineNode(msg.timeline ?? [], {
                id: `tool-${event.call_index}`, kind: 'tool', seq: nextSeq(),
                callIndex: event.call_index, tool: event.tool, result: event.result, source: event.source,
              }),
            }))
            break

          case 'done':
            updateLastMessage(msg => ({
              ...msg,
              content: event.response,
              toolCalls: event.tool_calls,
              liveToolCalls: undefined,
              durationSeconds: event.duration_seconds,
              usage: event.usage,
              rateLimits: event.rate_limits,
              relicSuggestions: event.relic_suggestions?.length ? event.relic_suggestions : undefined,
              timeline: appendTimelineNode(msg.timeline ?? [], { id: 'done', kind: 'done', seq: nextSeq(), response: event.response }),
            }))
            setThinking(false)
            setStatusMessage(null)
            break

          case 'error':
            setError(event.message)
            updateLastMessage(msg => ({
              ...msg,
              content: '',
              timeline: appendTimelineNode(msg.timeline ?? [], { id: 'error', kind: 'error', seq: nextSeq(), message: event.message }),
            }))
            setThinking(false)
            setStatusMessage(null)
            break

          case 'eval_result':
            setEvalResults(prev => [
              ...prev.slice(-49),
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
            break
        }
      }, controller.signal)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        updateLastMessage(msg => ({
          ...msg,
          toolCalls: (msg.liveToolCalls ?? [])
            .filter(tc => tc.result !== undefined)
            .map(tc => ({ tool: tc.tool, inputs: tc.inputs, result: tc.result!, source: tc.source })),
          liveToolCalls: undefined,
        }))
      } else {
        setError(err instanceof Error ? err.message : 'Request failed')
        updateLastMessage(msg => ({ ...msg, content: '' }))
      }
      setThinking(false)
      setStatusMessage(null)
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if ((!text && !attachedImage) || thinking) return
    setInput('')
    const image = attachedImage ?? undefined
    setAttachedImage(null)
    await sendMessage(text, messages, image)
  }

  // "Try again" on a flagged self-check: the flagged exchange stays exactly
  // where it is in the visible chat (nothing is stripped out) and a new
  // follow-up turn is sent that hands the model the specific finding — check/
  // target/reason — plus the full conversation so far, so the next response
  // is a refinement informed by what was actually flagged rather than a blind
  // identical re-ask.
  function handleRetryEval(item: EvalResultItem) {
    if (thinking) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return
    const label = evalTargetLabel(item)
    const refinement =
      `A self-check flagged your previous response. ` +
      `Target: ${label}. Check: ${item.check.replace(/_/g, ' ')}. ` +
      `Finding: ${item.reason} ` +
      `Please refine your response to address this finding, taking the rest of our conversation into account.`
    void sendMessage(refinement, messages, undefined, `🚩 Reported: ${item.reason}`)
  }

  // The pill under the agent's name should reflect what the user actually
  // configured on the Setup screen (active_traits/active_toggles), not
  // agentConfig.persona.traits — that's the bootstrap LLM's own invented
  // flavor text, unrelated to the real personality/behaviour selections, and
  // showing it (especially after resuming a saved chat) reads as if the
  // agent's identity changed out from under the user.
  const traitPool = PERSONALITY_TRAITS[agentConfig.template ?? 'research'] ?? PERSONALITY_TRAITS.research
  const activePersonalityLabels = [
    ...(agentConfig.active_traits ?? []).map(id => traitPool.find(t => t.id === id)?.label ?? id),
    ...(agentConfig.active_toggles ?? []).map(id => BEHAVIOR_TOGGLES.find(t => t.id === id)?.label ?? id),
  ]

  return (
    <div className={styles.root}>
      {showBriefing && (
        <AgentBriefingModal
          agentConfig={agentConfig}
          agentName={agentName}
          resumedMessages={initialMessages}
          onClose={() => setShowBriefing(false)}
        />
      )}
      <header className={styles.header}>
        <div className={styles.headerIdentity}>
          {/* Goes back to the Setup/search screen — navigation only, unlike
              "New agent" in the toolbar (which recommissions this same agent
              and wipes its messages). A past version of this logo doubled as
              that reset button, which silently lost the conversation; this
              button calls a distinct onBackToSetup instead, so the chat
              state itself is left untouched. */}
          <button type="button" className={styles.headerLogoBtn} onClick={onBackToSetup} aria-label="Back to search">
            <img src={splashLogo} alt="Agent One" className={styles.headerLogo} />
          </button>

          <div className={styles.headerIdentityText}>
            <span className={styles.headerTitle}>Agent {agentName}</span>
            {activePersonalityLabels.length > 0 && (
              <span className={styles.personaTraits}>
                {activePersonalityLabels.join(' · ')}
              </span>
            )}
            {agentConfig.location && (
              <span className={styles.locationBadge}>
                <ToolbarIcon name="location" /> {agentConfig.location}
              </span>
            )}
            <span className={styles.dateTimeBadge}>
              <ToolbarIcon name="clock" /> {formatDate(now, getDateFormat(), true)}
            </span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.modelBadge} title={describeModelFallback(agentConfig.provider)}>
            {describeModel(agentConfig.provider, agentConfig.ollama_model)}
          </span>
          <div className={styles.headerActionButtons}>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleSaveChat}
              disabled={messages.length === 0}
              aria-label={saveFeedback ?? 'Save chat'}
              title={saveFeedback ?? 'Save this conversation locally so it can be reopened later'}
            >
              <ToolbarIcon name={saveFeedback ? 'saved' : 'save'} />
            </button>
            <button
              type="button"
              className={styles.rosterBtn}
              onClick={() => setRosterOpen(o => !o)}
              disabled={messages.length === 0}
              aria-label="Roster"
              title="Save this agent and deploy them as a callable tool on the roster"
            >
              <ToolbarIcon name="roster" />
            </button>
            <button
              type="button"
              className={styles.copyBtn}
              onClick={handleCopyChat}
              disabled={messages.length === 0}
              aria-label={copyFeedback ?? 'Copy chat'}
              title={copyFeedback ?? 'Copy the whole conversation as formatted HTML'}
            >
              <ToolbarIcon name={copyFeedback === 'Copied ✓' ? 'copiedChat' : 'copyChat'} />
            </button>
            <button
              type="button"
              className={styles.exportBtn}
              onClick={handleExportPdf}
              disabled={messages.length === 0 || exporting}
              aria-label={exporting ? 'Exporting…' : 'Export PDF'}
              title="Export PDF"
            >
              <ToolbarIcon name={exporting ? 'exporting' : 'export'} />
            </button>
            <button
              type="button"
              className={styles.resetBtn}
              onClick={onReset}
              aria-label="New agent"
              title="New agent — recommission a fresh agent, wiping this conversation"
            >
              <ToolbarIcon name="newAgent" />
            </button>
          </div>
        </div>
      </header>

      {rosterOpen && (
        <div className={styles.rosterPanel}>
          <input
            className={styles.rosterInput}
            value={rosterName}
            onChange={e => setRosterName(e.target.value)}
            placeholder="Agent name (their ID on the roster)"
          />
          <input
            className={styles.rosterInput}
            value={rosterDescription}
            onChange={e => setRosterDescription(e.target.value)}
            placeholder="Role / what this agent does"
          />
          <button
            type="button"
            className={styles.rosterConfirmBtn}
            onClick={handleAddToRoster}
            disabled={!rosterName.trim() || addingToRoster}
          >
            {addingToRoster ? 'Deploying…' : 'Add to Roster'}
          </button>
          <button type="button" className={styles.rosterCancelBtn} onClick={() => setRosterOpen(false)}>
            Cancel
          </button>
        </div>
      )}
      {rosterFeedback && <p className={styles.rosterFeedback}>{rosterFeedback}</p>}

      <div className={styles.container}>
        <div className={styles.mainContent}>
          {focusPool.length > 0 && (
            <div className={styles.headerKeywords}>
              {[...focusPool].sort((a, b) => a.localeCompare(b)).map(kw => (
                <span key={kw} className={styles.headerChip}>{kw}</span>
              ))}
            </div>
          )}
          {assets.length > 0 && (
            <div className={styles.headerAssets}>
              {assets.map((a, ai) => (
                <button
                  key={a.url + ai}
                  type="button"
                  className={styles.assetThumbBtn}
                  onClick={() => setViewerImage(a.url)}
                  title={a.alt || 'Generated image'}
                  aria-label={a.alt || 'View generated image'}
                >
                  <img src={a.url} alt={a.alt} className={styles.assetThumb} loading="lazy" />
                </button>
              ))}
            </div>
          )}
          <div className={styles.toolsBadges}>
        {agentConfig.tools.filter(t => t.name !== 'save_output').map(t => (
          <span key={t.name} className={styles.badge}>{t.name}</span>
        ))}
      </div>

      <div className={styles.messageList}>
        {messages.length === 0 && !thinking && (
          <p className={styles.emptyHint}>Send a message to start.</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === 'user' ? styles.userBubble : styles.assistantBubble}>
            {msg.image && (
              <button
                type="button"
                className={styles.messageImageBtn}
                onClick={() => setViewerImage(msg.image!)}
                aria-label="Enlarge attached image"
              >
                <img src={msg.image} alt="Attached image" className={styles.messageImage} />
              </button>
            )}
            {msg.planDiagram && (
              <MermaidDiagram chart={msg.planDiagram} label="Plan" caption={msg.planSummary} />
            )}
            {msg.liveToolCalls && msg.liveToolCalls.length > 0 && (
              <>
                <button
                  type="button"
                  className={styles.viewToggleBtn}
                  onClick={() => toggleGraphView(i)}
                >
                  {graphViewMessages.has(i) ? '📋 Log view' : '🕸️ Graph view'}
                </button>
                {graphViewMessages.has(i) ? (
                  <GraphView timeline={msg.timeline ?? []} live evalResults={evalResults} />
                ) : (
                  <ToolActivity
                    toolCalls={msg.liveToolCalls.map(tc => ({
                      tool: tc.tool,
                      inputs: tc.inputs,
                      result: tc.result ?? '…',
                      source: tc.source,
                    }))}
                    live
                    location={agentConfig.location}
                  />
                )}
              </>
            )}
            {msg.content && (
              msg.role === 'assistant'
                ? (() => {
                    const { text: textAfterDiagrams, diagrams } = extractMermaidDiagrams(msg.content)
                    const { text, blobs } = extractJsonBlobs(textAfterDiagrams)
                    return (
                      <>
                        {diagrams.length > 0 && (
                          <div className={styles.extractedDiagrams}>
                            {diagrams.map((chart, di) => (
                              <MermaidDiagram key={di} chart={chart} />
                            ))}
                          </div>
                        )}
                        {blobs.length > 0 && (
                          <div className={styles.extractedDiagrams}>
                            {blobs.map((blob, bi) => (
                              <JsonTree key={bi} data={blob} />
                            ))}
                          </div>
                        )}
                        <div
                          className={styles.markdown}
                          ref={el => {
                            if (el) markdownRefs.current.set(i, el)
                            else markdownRefs.current.delete(i)
                          }}
                        >
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              pre({ children }) {
                                const codeEl = children as React.ReactElement<{ className?: string }> | undefined
                                const className = codeEl?.props?.className ?? ''
                                const lang = /language-(\S+)/.exec(className)?.[1] ?? 'text'
                                return <CodeBlock language={lang}>{children}</CodeBlock>
                              },
                              code({ className, children, ...props }) {
                                return <code className={className} {...props}>{children}</code>
                              },
                              table({ children, ...props }) {
                                return (
                                  <div className={styles.tableWrap}>
                                    <table {...props}>{children}</table>
                                  </div>
                                )
                              },
                              img({ src, alt, ...props }) {
                                return (
                                  <button
                                    type="button"
                                    className={styles.researchImageBtn}
                                    onClick={() => typeof src === 'string' && setViewerImage(src)}
                                    aria-label={alt || 'Enlarge image'}
                                  >
                                    <img
                                      src={src}
                                      alt={alt}
                                      loading="lazy"
                                      className={styles.researchImage}
                                      {...props}
                                    />
                                  </button>
                                )
                              },
                              li({ children, ...props }) {
                                const idea = listItemPlainText(children).trim()
                                return (
                                  <li {...props}>
                                    {children}
                                    {idea && (
                                      <button
                                        type="button"
                                        className={styles.extendIdeaButton}
                                        title="Ask the agent to extend upon this idea"
                                        disabled={thinking}
                                        onClick={() => sendMessage(`Extend upon this idea: ${idea}`)}
                                      >
                                        Extend ↗
                                      </button>
                                    )}
                                  </li>
                                )
                              },
                            }}
                          >
                            {normalizeInlineOrderedLists(text)}
                          </ReactMarkdown>
                        </div>
                      </>
                    )
                  })()
                : <p className={styles.bubbleText}>{msg.displayContent ?? msg.content}</p>
            )}
            {msg.toolCalls && (
              <>
                <button
                  type="button"
                  className={styles.viewToggleBtn}
                  onClick={() => toggleGraphView(i)}
                >
                  {graphViewMessages.has(i) ? '📋 Log view' : '🕸️ Graph view'}
                </button>
                {graphViewMessages.has(i) ? (
                  <GraphView
                    timeline={msg.timeline ?? []}
                    evalResults={i === messages.length - 1 ? evalResults : []}
                  />
                ) : (
                  <ToolActivity
                    toolCalls={msg.toolCalls}
                    live={false}
                    location={agentConfig.location}
                  />
                )}
              </>
            )}
            {msg.role === 'assistant' && msg.durationSeconds !== undefined && (msg.relicSuggestions || msg.relics || msg.content.length >= 200) && (() => {
              const built = msg.relics ?? []
              const isBuilt = (kind: RelicKind) => built.some(r => r.kind === kind)
              const suggested = (msg.relicSuggestions ?? []).filter(s => !isBuilt(s.kind))
              const busyKind = relicBusy?.startsWith(`${i}-`) ? relicBusy.slice(`${i}-`.length) as RelicKind : null
              return (
                <div>
                  {built.map(r => (
                    <button
                      key={`built-${r.kind}`}
                      type="button"
                      className={styles.viewToggleBtn}
                      title="Preview and download"
                      onClick={() => setRelicPreview({ index: i, kind: r.kind })}
                    >
                      📎 {RELIC_LABELS[r.kind]}
                    </button>
                  ))}
                  {suggested.map(s => (
                    <button
                      key={`suggested-${s.kind}`}
                      type="button"
                      className={styles.viewToggleBtn}
                      title={s.reason}
                      disabled={relicBusy !== null}
                      onClick={() => handleBuildRelic(i, s.kind, s.reason)}
                    >
                      ✨ {RELIC_LABELS[s.kind]}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={styles.exportAsBtn}
                    disabled={relicBusy !== null}
                    onClick={() => setExportMenuFor(exportMenuFor === i ? null : i)}
                  >
                    {exportMenuFor === i ? '✕ Close export' : '⬇ Export as…'}
                  </button>
                  {exportMenuFor === i && (
                    <div>
                      {RELIC_KINDS.map(kind => (
                        <button
                          key={`export-${kind}`}
                          type="button"
                          className={styles.viewToggleBtn}
                          disabled={relicBusy !== null}
                          onClick={() => handleBuildRelic(i, kind)}
                        >
                          {isBuilt(kind) ? '📎' : '⬇'} {RELIC_LABELS[kind]}
                        </button>
                      ))}
                    </div>
                  )}
                  {busyKind && <p className={styles.duration}>Building {RELIC_LABELS[busyKind]}…</p>}
                  {relicError && relicError.key.startsWith(`${i}-`) && !relicPreview && (
                    <p className={styles.duration}>{relicError.message}</p>
                  )}
                </div>
              )
            })()}
            {msg.durationSeconds !== undefined && (
              <p className={styles.duration}>
                {msg.toolCalls?.length
                  ? `${msg.toolCalls.length} tool call${msg.toolCalls.length !== 1 ? 's' : ''} · `
                  : ''}
                {msg.durationSeconds}s
                {msg.usage && (
                  <> · {(msg.usage.input_tokens + msg.usage.output_tokens).toLocaleString()} tokens
                  <span className={styles.tokenBreakdown}>
                    ({msg.usage.input_tokens.toLocaleString()} in / {msg.usage.output_tokens.toLocaleString()} out)
                  </span></>
                )}
                {msg.rateLimits?.tokens_remaining && (
                  <span className={styles.rateLimit}>
                    {' '}· {Number(msg.rateLimits.tokens_remaining).toLocaleString()} tokens remaining this minute
                    {msg.rateLimits.tokens_limit && (
                      <> of {Number(msg.rateLimits.tokens_limit).toLocaleString()}</>
                    )}
                  </span>
                )}
              </p>
            )}
            {msg.role === 'assistant' && msg.durationSeconds !== undefined && msg.content && (
              <ResultRating
                feedback={msg.feedback}
                onChange={feedback => setMessages(prev => prev.map((m, mi) => (mi === i ? { ...m, feedback } : m)))}
              />
            )}
            {thinking && i === messages.length - 1 && msg.role === 'assistant' && !msg.content && (
              <>
                <p className={styles.workingText}>
                  {statusMessage ?? 'Working'}{elapsed > 0 ? ` · ${elapsed}s` : ''}
                  {statusTokens && (statusTokens.input_tokens > 0 || statusTokens.output_tokens > 0) && (
                    <> · {(statusTokens.input_tokens + statusTokens.output_tokens).toLocaleString()} tokens so far</>
                  )}
                </p>
                {modelInfo && (
                  <p className={styles.modelInfoLine}>{formatModelInfo(modelInfo)}</p>
                )}
              </>
            )}
          </div>
        ))}
        {error && <p className={styles.error}>{error}</p>}
        <div ref={bottomRef} />
      </div>

      {(attachedImage || attachingImage) && (
        <div className={styles.attachmentChip}>
          {attachingImage ? (
            <span className={styles.attachmentPlaceholder}>
              <ToolbarIcon name="imagePlaceholder" />
              Loading image…
            </span>
          ) : (
            <>
              <img src={attachedImage!} alt="Attached image" className={styles.attachmentThumb} />
              <span>Image attached — the agent will look at it when you send</span>
              <button type="button" className={styles.attachmentRemove} onClick={clearAttachedImage} aria-label="Remove attached image">
                ✕
              </button>
            </>
          )}
        </div>
      )}
      <FeedbackStatusBar
        results={evalResults}
        collapsed={evalBarCollapsed}
        onToggleCollapse={() => setEvalBarCollapsed(c => !c)}
        onClear={() => setEvalResults([])}
        onRetry={handleRetryEval}
        onRemoveItem={(item) => setEvalResults(prev => prev.filter(r => r !== item))}
      />
      <form className={styles.inputRow} onSubmit={handleSend}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className={styles.hiddenFileInput}
          onChange={handleFileChange}
        />
        <button
          type="button"
          className={styles.attachBtn}
          onClick={handleAttachClick}
          disabled={thinking || attachingImage}
          title="Attach an image for the agent to look at"
          aria-label="Attach an image"
        >
          <ToolbarIcon name="attach" />
        </button>
        <input
          className={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Message the agent..."
          disabled={thinking}
        />
        {thinking ? (
          <>
            <button type="button" className={styles.stopBtn} onClick={stopAgent}>
              Stop
            </button>
            <button
              type="button"
              className={styles.killBtn}
              onClick={killAgent}
              title="Force this stuck turn to end and unlock the composer, without wiping the conversation"
            >
              Kill
            </button>
          </>
        ) : (
          <button
            type="submit"
            className={styles.sendBtn}
            disabled={!input.trim() && !attachedImage}
            title="Send"
            aria-label="Send message"
          >
            <ToolbarIcon name="send" />
            <span className={styles.sendLabel}>Send</span>
          </button>
        )}
        <span className={styles.composerDivider} aria-hidden="true" />
        <button
          type="button"
          className={styles.recommissionBtn}
          onClick={onReset}
          disabled={thinking}
          title="Restart the chat — same search, fresh conversation"
        >
          Recommission
        </button>
      </form>
        </div>
      </div>
      {pdfPreview && (
        <PdfPreviewModal
          blobUrl={pdfPreview.blobUrl}
          filename={pdfPreview.filename}
          onDownload={handleDownloadPdf}
          onSaveJson={handleSaveChatFile}
          onClose={handleClosePdfPreview}
        />
      )}
      {relicPreview && (() => {
        const relic = messages[relicPreview.index]?.relics?.find(r => r.kind === relicPreview.kind)
        if (!relic) return null
        const key = `${relicPreview.index}-${relic.kind}`
        return (
          <RelicPreviewModal
            relic={relic}
            filename={relicFilename(relic, agentName)}
            agentName={agentName}
            busy={relicBusy === key}
            error={relicError?.key === key ? relicError.message : null}
            onDownload={() => handleDownloadRelic(relic)}
            onRegenerate={() => handleBuildRelic(relicPreview.index, relic.kind, '', true)}
            onClose={() => { setRelicPreview(null); setRelicError(null) }}
          />
        )
      })()}
      {viewerImage && <ImageViewer src={viewerImage} onClose={() => setViewerImage(null)} />}
    </div>
  )
}

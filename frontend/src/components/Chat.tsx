import { isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { publishAgent, runAgent } from '../api'
import { saveChat } from '../chatStorage'
import { buildChatPdf, type PdfAgentContext, type PdfMessage } from '../chatPdf'
import { BEHAVIOR_TOGGLES, PERSONALITY_TRAITS } from '../agentTypes'
import ToolActivity from './ToolActivity'
import MermaidDiagram from './MermaidDiagram'
import CodeBlock from './CodeBlock'
import PdfPreviewModal from './PdfPreviewModal'
import ImageViewer from './ImageViewer'
import FeedbackStatusBar from './FeedbackStatusBar'
import type { AgentConfig, EvalResultItem, SavedChat, SavedChatMessage, StreamEvent, ToolCall } from '../types'
import { describeModel, describeModelFallback } from '../modelLabel'
import styles from '../styles/Chat.module.css'
import splashLogo from '../assets/splash_logo.png'

type ToolbarIconName = 'save' | 'saved' | 'roster' | 'export' | 'exporting' | 'newAgent' | 'attach' | 'imagePlaceholder' | 'expand' | 'collapse'

// Lenient on purpose (trailing whitespace after the fence marker, CRLF,
// casing, trailing blank lines before the closing fence) — the earlier,
// strict ```mermaid\n version silently failed to match real model output
// whose fence didn't line up exactly, which left every diagram unrendered
// instead of just falling back to a plain code block.
const MERMAID_FENCE_RE = /```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi

// Pulls every ```mermaid fence out of an assistant reply's prose so it can be
// rendered as its own dedicated block (same treatment planDiagram already
// gets) instead of sitting inline mid-paragraph inside the flowing markdown.
function extractMermaidDiagrams(content: string): { text: string; diagrams: string[] } {
  const diagrams: string[] = []
  const text = content.replace(MERMAID_FENCE_RE, (_match, chart: string) => {
    diagrams.push(chart.trim())
    return ''
  })
  return { text, diagrams }
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
    // Toggles the composer between a single-line input and a resizable
    // multi-line textarea — a paragraph glyph (three lines) reads as "let me
    // write more" better than a generic resize/fullscreen arrow would.
    case 'expand':
      return (
        <svg {...common}>
          <line x1="5" y1="7" x2="19" y2="7" />
          <line x1="5" y1="12" x2="19" y2="12" />
          <line x1="5" y1="17" x2="19" y2="17" />
        </svg>
      )
    case 'collapse':
      return (
        <svg {...common}>
          <line x1="5" y1="12" x2="19" y2="12" />
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
  // What the user bubble actually shows, when it needs to differ from the
  // literal text sent to the backend as this turn's user message — e.g. the
  // auto-fired initial search still sends a standardized instruction (the
  // backend needs something concrete to act on), but the bubble shows the
  // agent's own original setup purpose instead of that boilerplate.
  // Undefined on every ordinary typed message, where content IS the display.
  displayContent?: string
  // Base64 data URL of a diagram image attached to this turn (composer's
  // paperclip button). Undefined on every message that isn't an upload.
  image?: string
  toolCalls?: ToolCall[]
  liveToolCalls?: LiveToolCall[]
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
  const [composerExpanded, setComposerExpanded] = useState(false)
  const composerFormRef = useRef<HTMLFormElement>(null)
  const [thinking, setThinking] = useState(false)
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
  const [exporting, setExporting] = useState(false)
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
  // A resumed chat already has its history — don't re-fire the initial
  // auto-search that a fresh bootstrap triggers.
  const autoSentRef = useRef(Boolean(initialMessages && initialMessages.length > 0))
  const abortRef = useRef<AbortController | null>(null)
  // Composer's attached-diagram state. `attachingImage` covers the brief
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

  // Auto-send an initial task when the agent has a configured specialty
  // pool. The pool itself (agentConfig.keywords) is now the keyword source
  // the backend's delegation rule iterates over (see agent_stream.py's
  // _delegation_rule_body) — this message no longer needs to spell out
  // each keyword itself, just hand over a generic task.
  useEffect(() => {
    if (autoSentRef.current) return
    const kws = agentConfig.keywords
    if (!kws?.length) return
    autoSentRef.current = true
    const loc = agentConfig.location ? ` in ${agentConfig.location}` : ''
    // The backend still needs a concrete instruction to act on, but the
    // bubble shows a short greeting instead — the full agentConfig.purpose
    // string (often a long, verbatim setup description) read like the
    // agent narrating its own bio back at the user rather than someone
    // opening a conversation.
    sendMessage(
      `Run your standard search across your full specialty pool${loc}.`,
      messages,
      undefined,
      `Hi — what's your analysis${loc}?`,
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function buildSavedChat(): SavedChat {
    return {
      id: chatIdRef.current,
      agentName,
      agentConfig,
      messages: messages.map(({ role, content, displayContent, image, toolCalls, planDiagram, planSummary, durationSeconds, usage, rateLimits }) => ({
        role, content, displayContent, image, toolCalls, planDiagram, planSummary, durationSeconds, usage, rateLimits,
      })),
      savedAt: Date.now(),
    }
  }

  function saveChatLocally() {
    saveChat(buildSavedChat())
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
        keywords: agentConfig.keywords,
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

  function handleClosePdfPreview() {
    if (pdfPreview) URL.revokeObjectURL(pdfPreview.blobUrl)
    setPdfPreview(null)
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

    const apiMessages = withUser.map(m => ({ role: m.role, content: m.content, image: m.image }))

    try {
      await runAgent(apiMessages, agentConfig, (event: StreamEvent) => {
        switch (event.type) {
          case 'plan':
            updateLastMessage(msg => ({ ...msg, planDiagram: event.diagram, planSummary: event.summary ?? undefined }))
            break

          case 'tool_start':
            updateLastMessage(msg => ({
              ...msg,
              liveToolCalls: [
                ...(msg.liveToolCalls ?? []),
                { tool: event.tool, inputs: event.inputs, source: event.source, callIndex: event.call_index },
              ],
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
            }))
            setThinking(false)
            break

          case 'error':
            setError(event.message)
            updateLastMessage(msg => ({ ...msg, content: '' }))
            setThinking(false)
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

  return (
    <div className={styles.root}>
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
            {agentConfig.persona?.traits && agentConfig.persona.traits.length > 0 && (
              <span className={styles.personaTraits} title={agentConfig.persona.rationale}>
                {agentConfig.persona.traits.join(' · ')}
              </span>
            )}
            {agentConfig.location && (
              <span className={styles.locationBadge}>📍 {agentConfig.location}</span>
            )}
            <span className={styles.dateTimeBadge}>
              🕐 {now.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.modelBadge} title={describeModelFallback(agentConfig.provider)}>
            🧠 {describeModel(agentConfig.provider, agentConfig.ollama_model)}
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
        {agentConfig.keywords && agentConfig.keywords.length > 0 && (
          <div className={styles.headerKeywords}>
            {[...agentConfig.keywords].sort((a, b) => a.localeCompare(b)).map(kw => (
              <span key={kw} className={styles.headerChip}>{kw}</span>
            ))}
          </div>
        )}
      </header>

      <FeedbackStatusBar
        results={evalResults}
        collapsed={evalBarCollapsed}
        onToggleCollapse={() => setEvalBarCollapsed(c => !c)}
      />

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
          <div className={styles.toolsBadges}>
        {agentConfig.tools.map(t => (
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
                aria-label="Enlarge attached diagram"
              >
                <img src={msg.image} alt="Attached diagram" className={styles.messageImage} />
              </button>
            )}
            {msg.planDiagram && (
              <MermaidDiagram chart={msg.planDiagram} label="Plan" caption={msg.planSummary} />
            )}
            {msg.liveToolCalls && msg.liveToolCalls.length > 0 && (
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
            {msg.content && (
              msg.role === 'assistant'
                ? (() => {
                    const { text, diagrams } = extractMermaidDiagrams(msg.content)
                    return (
                      <>
                        {diagrams.length > 0 && (
                          <div className={styles.extractedDiagrams}>
                            {diagrams.map((chart, di) => (
                              <MermaidDiagram key={di} chart={chart} />
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
                            {text}
                          </ReactMarkdown>
                        </div>
                      </>
                    )
                  })()
                : <p className={styles.bubbleText}>{msg.displayContent ?? msg.content}</p>
            )}
            {msg.toolCalls && <ToolActivity toolCalls={msg.toolCalls} live={false} location={agentConfig.location} />}
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
            {thinking && i === messages.length - 1 && msg.role === 'assistant' && !msg.content && (
              <p className={styles.workingText}>
                Working{elapsed > 0 ? ` · ${elapsed}s` : ''}
              </p>
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
              <img src={attachedImage!} alt="Attached diagram" className={styles.attachmentThumb} />
              <span>Diagram attached — the agent will critique it on send</span>
              <button type="button" className={styles.attachmentRemove} onClick={clearAttachedImage} aria-label="Remove attached image">
                ✕
              </button>
            </>
          )}
        </div>
      )}
      <form ref={composerFormRef} className={styles.inputRow} onSubmit={handleSend}>
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
          title="Attach a diagram image for the agent to critique"
          aria-label="Attach a diagram image"
        >
          <ToolbarIcon name="attach" />
        </button>
        <button
          type="button"
          className={styles.attachBtn}
          onClick={() => setComposerExpanded(v => !v)}
          disabled={thinking}
          title={composerExpanded ? 'Collapse to a single line' : 'Expand to a multi-line prompt'}
          aria-label={composerExpanded ? 'Collapse input to a single line' : 'Expand input to multiple lines'}
        >
          <ToolbarIcon name={composerExpanded ? 'collapse' : 'expand'} />
        </button>
        {composerExpanded ? (
          <textarea
            className={`${styles.input} ${styles.inputExpanded}`}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Message the agent... (Shift+Enter for a new line)"
            disabled={thinking}
            rows={3}
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                composerFormRef.current?.requestSubmit()
              }
            }}
          />
        ) : (
          <input
            className={styles.input}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Message the agent..."
            disabled={thinking}
          />
        )}
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
          <button type="submit" className={styles.sendBtn} disabled={!input.trim() && !attachedImage}>
            Send
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
      {viewerImage && <ImageViewer src={viewerImage} onClose={() => setViewerImage(null)} />}
    </div>
  )
}

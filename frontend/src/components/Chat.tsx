import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { publishAgent, runAgent } from '../api'
import { saveChat } from '../chatStorage'
import { buildChatPdf, type PdfMessage } from '../chatPdf'
import ToolActivity from './ToolActivity'
import MermaidDiagram from './MermaidDiagram'
import PdfPreviewModal from './PdfPreviewModal'
import type { AgentConfig, SavedChat, SavedChatMessage, StreamEvent, ToolCall } from '../types'
import styles from '../styles/Chat.module.css'
import splashLogo from '../assets/splash_logo.png'

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
  toolCalls?: ToolCall[]
  liveToolCalls?: LiveToolCall[]
  durationSeconds?: number
  usage?: { input_tokens: number; output_tokens: number }
  rateLimits?: { tokens_remaining: string | null; tokens_limit: string | null; requests_remaining: string | null; tokens_reset: string | null }
}

interface Props {
  agentConfig: AgentConfig
  agentName: string
  onReset: () => void
  // Present when jumping straight in from a saved chat (App.tsx's
  // onResumeChat), bypassing bootstrap entirely.
  initialMessages?: SavedChatMessage[]
  chatId?: string
}

export default function Chat({ agentConfig, agentName, onReset, initialMessages, chatId }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialMessages ?? [])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [elapsed, setElapsed] = useState(0)
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
  // Stable identity for this conversation so re-saving it (after more
  // messages) updates the same localStorage entry instead of duplicating it.
  const chatIdRef = useRef(chatId ?? crypto.randomUUID())
  // A resumed chat already has its history — don't re-fire the initial
  // auto-search that a fresh bootstrap triggers.
  const autoSentRef = useRef(Boolean(initialMessages && initialMessages.length > 0))
  const abortRef = useRef<AbortController | null>(null)

  // Auto-send initial search when keywords are available
  useEffect(() => {
    if (autoSentRef.current) return
    const kws = agentConfig.keywords
    if (!kws?.length) return
    autoSentRef.current = true
    const loc = agentConfig.location ? ` in ${agentConfig.location}` : ''
    sendMessage(`Search for: ${kws.join(', ')}${loc}`)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function saveChatLocally() {
    const chat: SavedChat = {
      id: chatIdRef.current,
      agentName,
      agentConfig,
      messages: messages.map(({ role, content, toolCalls, durationSeconds, usage, rateLimits }) => ({
        role, content, toolCalls, durationSeconds, usage, rateLimits,
      })),
      savedAt: Date.now(),
    }
    saveChat(chat)
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
          content: m.content,
          contentEl: m.role === 'assistant' ? markdownRefs.current.get(i) ?? null : null,
          toolCallCount: m.toolCalls?.length,
          durationSeconds: m.durationSeconds,
          usage: m.usage,
        }))
        .filter(m => m.content || m.toolCallCount)
      const doc = buildChatPdf(`Agent ${agentName}`, pdfMessages)
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

  async function sendMessage(text: string, currentMessages: ChatMessage[] = messages) {
    if (!text.trim() || thinking) return
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    const userMsg: ChatMessage = { role: 'user', content: text }
    const withUser = [...currentMessages, userMsg]
    setMessages([...withUser, { role: 'assistant', content: '', liveToolCalls: [] }])
    setThinking(true)

    const apiMessages = withUser.map(m => ({ role: m.role, content: m.content }))

    try {
      await runAgent(apiMessages, agentConfig, (event: StreamEvent) => {
        switch (event.type) {
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
    if (!text || thinking) return
    setInput('')
    await sendMessage(text)
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerIdentity}>
          <img src={splashLogo} alt="Agent One" className={styles.headerLogo} />
          <div>
            <span className={styles.headerTitle}>Agent {agentName}</span>
            {agentConfig.location && (
              <span className={styles.locationBadge}>📍 {agentConfig.location}</span>
            )}
            {agentConfig.persona?.traits && agentConfig.persona.traits.length > 0 && (
              <span className={styles.personaTraits} title={agentConfig.persona.rationale}>
                {agentConfig.persona.traits.join(' · ')}
              </span>
            )}
            {agentConfig.provider === 'ollama' && (
              <span className={styles.localBadge}>
                Local (Ollama{agentConfig.ollama_model ? `: ${agentConfig.ollama_model}` : ''})
              </span>
            )}
          </div>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.saveBtn}
            onClick={handleSaveChat}
            disabled={messages.length === 0}
            aria-label={saveFeedback ?? 'Save chat'}
            title={saveFeedback ?? 'Save this conversation locally so it can be reopened later'}
          >
            {saveFeedback ? saveFeedback : '💾'}
          </button>
          <button
            type="button"
            className={styles.rosterBtn}
            onClick={() => setRosterOpen(o => !o)}
            disabled={messages.length === 0}
            aria-label="Add to Roster"
            title="Save this agent and deploy them as a callable tool on the roster"
          >
            🪪
          </button>
          <button
            type="button"
            className={styles.exportBtn}
            onClick={handleExportPdf}
            disabled={messages.length === 0 || exporting}
            aria-label={exporting ? 'Exporting…' : 'Export PDF'}
            title="Export PDF"
          >
            {exporting ? '…' : '⬇️'}
          </button>
          <button
            type="button"
            className={styles.resetBtn}
            onClick={onReset}
            aria-label="New agent"
            title="New agent"
          >
            ➕
          </button>
        </div>
        {agentConfig.keywords && agentConfig.keywords.length > 0 && (
          <div className={styles.headerKeywords}>
            {[...agentConfig.keywords].sort((a, b) => a.localeCompare(b)).map(kw => (
              <span key={kw} className={styles.headerChip}>{kw}</span>
            ))}
          </div>
        )}
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
                ? (
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
                        code({ className, children, ...props }) {
                          const isMermaid = className === 'language-mermaid'
                          if (isMermaid) {
                            return <MermaidDiagram chart={String(children).trim()} />
                          }
                          return <code className={className} {...props}>{children}</code>
                        },
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                )
                : <p className={styles.bubbleText}>{msg.content}</p>
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
                Working{elapsed > 0 ? ` · ${elapsed}s` : '…'}
              </p>
            )}
          </div>
        ))}
        {error && <p className={styles.error}>{error}</p>}
      </div>

      <form className={styles.inputRow} onSubmit={handleSend}>
        <input
          className={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Message the agent..."
          disabled={thinking}
        />
        {thinking ? (
          <button type="button" className={styles.stopBtn} onClick={stopAgent}>
            Stop
          </button>
        ) : (
          <button type="submit" className={styles.sendBtn} disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
        </div>
      </div>
      {pdfPreview && (
        <PdfPreviewModal
          blobUrl={pdfPreview.blobUrl}
          filename={pdfPreview.filename}
          onDownload={handleDownloadPdf}
          onClose={handleClosePdfPreview}
        />
      )}
    </div>
  )
}

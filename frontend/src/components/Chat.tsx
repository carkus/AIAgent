import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { runAgent } from '../api'
import { saveChat } from '../chatStorage'
import ToolActivity from './ToolActivity'
import ContinuePanel from './ContinuePanel'
import type { AgentConfig, SavedChat, StreamEvent, ToolCall } from '../types'
import styles from '../styles/Chat.module.css'

interface LiveToolCall {
  tool: string
  inputs: Record<string, unknown>
  result?: string
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
  savedChat?: SavedChat | null
  onReset: () => void
}

export default function Chat({ agentConfig, agentName, savedChat, onReset }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => savedChat?.messages ?? [])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [continueOpen, setContinueOpen] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  // Stable identity for this conversation so re-saving it (after more
  // messages) updates the same localStorage entry instead of duplicating it.
  const chatIdRef = useRef(savedChat?.id ?? crypto.randomUUID())
  // A resumed chat already has its history — don't re-fire the
  // auto-search-on-load effect below.
  const autoSentRef = useRef(Boolean(savedChat?.messages?.length))
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

  function handleSaveChat() {
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
    setSaveFeedback(true)
    window.setTimeout(() => setSaveFeedback(false), 1500)
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

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
                { tool: event.tool, inputs: event.inputs },
              ],
            }))
            break

          case 'tool_result':
            updateLastMessage(msg => ({
              ...msg,
              liveToolCalls: (msg.liveToolCalls ?? []).map(tc =>
                tc.tool === event.tool && tc.result === undefined
                  ? { ...tc, result: event.result }
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
            .map(tc => ({ tool: tc.tool, inputs: tc.inputs, result: tc.result! })),
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
        <div>
          <span className={styles.headerTitle}>Agent {agentName}</span>
          <span className={styles.headerPurpose}>{agentConfig.purpose}</span>
          {agentConfig.provider === 'ollama' && (
            <span className={styles.localBadge}>
              Local (Ollama{agentConfig.ollama_model ? `: ${agentConfig.ollama_model}` : ''})
            </span>
          )}
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.saveBtn}
            onClick={handleSaveChat}
            disabled={messages.length === 0}
          >
            {saveFeedback ? 'Saved ✓' : 'Save chat'}
          </button>
          <button type="button" className={styles.resetBtn} onClick={onReset}>New agent</button>
        </div>
        <ContinuePanel isOpen={continueOpen} onToggle={() => setContinueOpen(!continueOpen)} />
      </header>

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
                }))}
                live
                location={agentConfig.location}
              />
            )}
            {msg.content && (
              msg.role === 'assistant'
                ? (
                  <div className={styles.markdown}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
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
        <div ref={bottomRef} />
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
    </div>
  )
}

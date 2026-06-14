import { useEffect, useRef, useState } from 'react'
import { runAgent } from '../api'
import ToolActivity from './ToolActivity'
import type { AgentConfig, StreamEvent, ToolCall } from '../types'
import styles from './Chat.module.css'

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
  onReset: () => void
}

export default function Chat({ agentConfig, onReset }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

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

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || thinking) return

    setInput('')
    setError(null)

    const userMsg: ChatMessage = { role: 'user', content: text }
    const withUser = [...messages, userMsg]
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
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
      updateLastMessage(msg => ({ ...msg, content: '' }))
      setThinking(false)
    }
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <span className={styles.headerTitle}>Agent</span>
          <span className={styles.headerPurpose}>{agentConfig.purpose}</span>
        </div>
        <button type="button" className={styles.resetBtn} onClick={onReset}>New agent</button>
      </header>

      <div className={styles.toolsBadges}>
        {agentConfig.tools.map(t => (
          <span key={t.name} className={styles.badge}>{t.name}</span>
        ))}
      </div>

      <div className={styles.messageList}>
        {messages.length === 0 && (
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
              />
            )}
            {msg.content && <p className={styles.bubbleText}>{msg.content}</p>}
            {msg.toolCalls && <ToolActivity toolCalls={msg.toolCalls} live={false} />}
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
        <button type="submit" className={styles.sendBtn} disabled={thinking || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

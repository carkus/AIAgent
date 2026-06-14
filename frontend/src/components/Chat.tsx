import { useEffect, useRef, useState } from 'react'
import { runAgent } from '../api'
import ToolActivity from './ToolActivity'
import type { AgentConfig, Message, ToolCall } from '../types'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]
  durationSeconds?: number
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

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || thinking) return

    setInput('')
    setError(null)

    const userMsg: ChatMessage = { role: 'user', content: text }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setThinking(true)

    try {
      const apiMessages: Message[] = updatedMessages.map(m => ({
        role: m.role,
        content: m.content,
      }))
      const result = await runAgent(apiMessages, agentConfig)
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: result.response,
          toolCalls: result.tool_calls,
          durationSeconds: result.duration_seconds,
        },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setThinking(false)
    }
  }

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div>
          <span style={styles.headerTitle}>Agent</span>
          <span style={styles.headerPurpose}>{agentConfig.purpose}</span>
        </div>
        <button style={styles.resetBtn} onClick={onReset}>New agent</button>
      </header>

      <div style={styles.toolsBadges}>
        {agentConfig.tools.map(t => (
          <span key={t.name} style={styles.badge}>{t.name}</span>
        ))}
      </div>

      <div style={styles.messageList}>
        {messages.length === 0 && (
          <p style={styles.emptyHint}>Send a message to start.</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={msg.role === 'user' ? styles.userBubble : styles.assistantBubble}>
            <p style={styles.bubbleText}>{msg.content}</p>
            {msg.toolCalls && <ToolActivity toolCalls={msg.toolCalls} />}
            {msg.durationSeconds !== undefined && (
              <p style={styles.duration}>
                {msg.toolCalls?.length
                  ? `${msg.toolCalls.length} tool call${msg.toolCalls.length !== 1 ? 's' : ''} · `
                  : ''}
                {msg.durationSeconds}s
              </p>
            )}
          </div>
        ))}
        {thinking && (
          <div style={styles.assistantBubble}>
            <p style={{ ...styles.bubbleText, color: '#666' }}>
              Working{elapsed > 0 ? ` · ${elapsed}s` : '…'}
            </p>
          </div>
        )}
        {error && <p style={styles.error}>{error}</p>}
        <div ref={bottomRef} />
      </div>

      <form style={styles.inputRow} onSubmit={handleSend}>
        <input
          style={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Message the agent..."
          disabled={thinking}
        />
        <button style={styles.sendBtn} type="submit" disabled={thinking || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    maxWidth: '820px',
    margin: '0 auto',
    width: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '1rem 1.5rem',
    borderBottom: '1px solid #2a2a2a',
  },
  headerTitle: {
    fontWeight: 700,
    marginRight: '0.75rem',
  },
  headerPurpose: {
    color: '#888',
    fontSize: '0.875rem',
  },
  resetBtn: {
    background: 'transparent',
    border: '1px solid #333',
    borderRadius: '6px',
    color: '#888',
    cursor: 'pointer',
    fontSize: '0.8rem',
    padding: '0.375rem 0.75rem',
  },
  toolsBadges: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    padding: '0.75rem 1.5rem',
    borderBottom: '1px solid #1f1f1f',
  },
  badge: {
    background: '#1e1e2e',
    border: '1px solid #333',
    borderRadius: '4px',
    color: '#a78bfa',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    padding: '0.2rem 0.5rem',
  },
  messageList: {
    flex: 1,
    overflowY: 'auto',
    padding: '1.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  emptyHint: {
    color: '#444',
    textAlign: 'center',
    marginTop: '4rem',
  },
  userBubble: {
    alignSelf: 'flex-end',
    background: '#1e2a4a',
    border: '1px solid #2a3a6a',
    borderRadius: '12px 12px 2px 12px',
    maxWidth: '75%',
    padding: '0.75rem 1rem',
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: '12px 12px 12px 2px',
    maxWidth: '85%',
    padding: '0.75rem 1rem',
  },
  bubbleText: {
    margin: 0,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  inputRow: {
    display: 'flex',
    gap: '0.75rem',
    padding: '1rem 1.5rem',
    borderTop: '1px solid #2a2a2a',
  },
  input: {
    flex: 1,
    background: '#111',
    border: '1px solid #333',
    borderRadius: '8px',
    color: '#e8e8e8',
    fontSize: '0.95rem',
    outline: 'none',
    padding: '0.75rem 1rem',
    fontFamily: 'inherit',
  },
  sendBtn: {
    background: '#4f6ef7',
    border: 'none',
    borderRadius: '8px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '0.95rem',
    fontWeight: 600,
    padding: '0.75rem 1.25rem',
  },
  error: {
    color: '#f87171',
    fontSize: '0.875rem',
    textAlign: 'center',
  },
  duration: {
    color: '#555',
    fontSize: '0.72rem',
    margin: '0.4rem 0 0',
  },
}

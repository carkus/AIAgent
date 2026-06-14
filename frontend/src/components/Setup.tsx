import { useState } from 'react'
import { bootstrap } from '../api'
import type { AgentConfig } from '../types'

interface Props {
  bootstrapping: boolean
  error: string | null
  onStart: () => void
  onDone: (config: AgentConfig) => void
  onError: (msg: string) => void
}

export default function Setup({ bootstrapping, error, onStart, onDone, onError }: Props) {
  const [purpose, setPurpose] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!purpose.trim() || bootstrapping) return
    onStart()
    try {
      const config = await bootstrap(purpose.trim())
      onDone(config)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>AI Agent</h1>
        <p style={styles.subtitle}>Describe what you want your agent to do.</p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <textarea
            style={styles.textarea}
            value={purpose}
            onChange={e => setPurpose(e.target.value)}
            placeholder="e.g. Research companies and write competitive analysis reports"
            rows={5}
            disabled={bootstrapping}
          />
          {error && <p style={styles.error}>{error}</p>}
          <button style={styles.button} type="submit" disabled={bootstrapping || !purpose.trim()}>
            {bootstrapping ? 'Configuring agent...' : 'Create Agent'}
          </button>
        </form>

        {bootstrapping && (
          <p style={styles.hint}>
            Claude is designing your agent's tools and behaviour. This takes ~10 seconds.
          </p>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
  },
  card: {
    background: '#1a1a1a',
    borderRadius: '12px',
    padding: '2.5rem',
    width: '100%',
    maxWidth: '560px',
    border: '1px solid #2a2a2a',
  },
  title: {
    margin: '0 0 0.5rem',
    fontSize: '1.8rem',
    fontWeight: 700,
  },
  subtitle: {
    margin: '0 0 2rem',
    color: '#888',
    fontSize: '0.95rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  textarea: {
    background: '#111',
    border: '1px solid #333',
    borderRadius: '8px',
    color: '#e8e8e8',
    fontSize: '0.95rem',
    padding: '0.875rem',
    resize: 'vertical',
    outline: 'none',
    fontFamily: 'inherit',
  },
  button: {
    background: '#4f6ef7',
    border: 'none',
    borderRadius: '8px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: 600,
    padding: '0.875rem',
  },
  error: {
    color: '#f87171',
    fontSize: '0.875rem',
    margin: 0,
  },
  hint: {
    color: '#666',
    fontSize: '0.85rem',
    marginTop: '1rem',
    textAlign: 'center',
  },
}

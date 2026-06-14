import { useState } from 'react'
import Setup from './components/Setup'
import Chat from './components/Chat'
import type { AgentConfig } from './types'

type Phase = 'setup' | 'bootstrapping' | 'chat'

export default function App() {
  const [phase, setPhase] = useState<Phase>('setup')
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)

  function handleBootstrapStart() {
    setBootstrapError(null)
    setPhase('bootstrapping')
  }

  function handleBootstrapDone(config: AgentConfig) {
    setAgentConfig(config)
    setPhase('chat')
  }

  function handleBootstrapError(msg: string) {
    setBootstrapError(msg)
    setPhase('setup')
  }

  function handleReset() {
    setAgentConfig(null)
    setPhase('setup')
  }

  return (
    <div style={styles.root}>
      {phase === 'setup' || phase === 'bootstrapping' ? (
        <Setup
          bootstrapping={phase === 'bootstrapping'}
          error={bootstrapError}
          onStart={handleBootstrapStart}
          onDone={handleBootstrapDone}
          onError={handleBootstrapError}
        />
      ) : agentConfig ? (
        <Chat agentConfig={agentConfig} onReset={handleReset} />
      ) : null}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100%',
    background: '#0f0f0f',
    color: '#e8e8e8',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
}

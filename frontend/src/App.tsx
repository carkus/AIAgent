import { useState } from 'react'
import Setup from './components/Setup'
import Chat from './components/Chat'
import type { AgentConfig } from './types'
import { SURNAMES } from './surnames'

type Phase = 'setup' | 'bootstrapping' | 'chat'

function randomSurname(): string {
  return SURNAMES[Math.floor(Math.random() * SURNAMES.length)]
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('setup')
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  // Picked once per agent (re-rolled on "New agent") so this instance has a
  // name for the whole session — a little personality, purely cosmetic.
  const [agentName, setAgentName] = useState<string>(randomSurname)

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

  function handleNewAgentName() {
    setAgentName(randomSurname())
  }

  function handleReset() {
    setAgentConfig(null)
    setAgentName(randomSurname())
    setPhase('setup')
  }

  return (
    <div style={styles.root}>
      {phase === 'setup' || phase === 'bootstrapping' ? (
        <Setup
          agentName={agentName}
          onAgentNameChange={setAgentName}
          onNewAgent={handleNewAgentName}
          bootstrapping={phase === 'bootstrapping'}
          error={bootstrapError}
          onStart={handleBootstrapStart}
          onDone={handleBootstrapDone}
          onError={handleBootstrapError}
        />
      ) : agentConfig ? (
        <Chat agentConfig={agentConfig} agentName={agentName} onReset={handleReset} />
      ) : null}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100%',
    background: 'radial-gradient(ellipse 1200px 800px at 15% -10%, #22264a 0%, transparent 55%), radial-gradient(ellipse 1000px 700px at 100% 110%, #1a3a3a 0%, transparent 55%), #14161d',
    color: '#eceef2',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
}

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
    // The bootstrap call now invents its own name/personality from the
    // purpose text (see backend/src/bootstrap.py's persona field) — prefer
    // that over the random placeholder picked on load. Fall back to keeping
    // the placeholder if the model omitted or mangled it.
    if (config.persona?.name) setAgentName(config.persona.name)
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
    background: 'radial-gradient(ellipse 1200px 800px at 15% -10%, rgba(34, 211, 238, 0.14) 0%, transparent 55%), radial-gradient(ellipse 1000px 700px at 100% 110%, rgba(255, 47, 214, 0.10) 0%, transparent 55%), repeating-linear-gradient(180deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 1px, transparent 1px, transparent 3px), #090b10',
    color: '#e4faff',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
}

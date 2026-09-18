import { useState } from 'react'
import Setup from './components/Setup'
import Chat from './components/Chat'
import SplashScreen from './components/SplashScreen'
import type { AgentConfig } from './types'
import { SURNAMES } from './surnames'

type Phase = 'splash' | 'setup' | 'bootstrapping' | 'chat'

function randomSurname(): string {
  return SURNAMES[Math.floor(Math.random() * SURNAMES.length)]
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('splash')
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  // Picked once per agent (re-rolled on "New agent") so this instance has a
  // name for the whole session — a little personality, purely cosmetic.
  const [agentName, setAgentName] = useState<string>(randomSurname)
  // Bumped on every bootstrap so Chat remounts with fresh internal
  // state (messages, chatIdRef) instead of reusing a stale instance.
  const [chatKey, setChatKey] = useState(0)

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
    setChatKey(k => k + 1)
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
      {phase === 'splash' ? (
        <SplashScreen onDone={() => setPhase('setup')} />
      ) : phase === 'setup' || phase === 'bootstrapping' ? (
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
        <Chat
          key={chatKey}
          agentConfig={agentConfig}
          agentName={agentName}
          onReset={handleReset}
        />
      ) : null}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100%',
    background: '#f2efe9',
    color: '#16324a',
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
}

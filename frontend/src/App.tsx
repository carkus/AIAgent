import { useState } from 'react'
import Setup from './components/Setup'
import Chat from './components/Chat'
import SplashScreen from './components/SplashScreen'
import type { AgentConfig, SavedChat } from './types'
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
  // Set only when jumping straight back into a saved chat (Setup's → button)
  // rather than bootstrapping fresh — carries the prior message history into
  // the next Chat mount. Cleared on reset/new bootstrap.
  const [resumeChat, setResumeChat] = useState<SavedChat | null>(null)
  // Bumped on every bootstrap/resume so Chat remounts with fresh internal
  // state (messages, chatIdRef) instead of reusing a stale instance when
  // going straight from one chat/resume into another.
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
    setResumeChat(null)
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
    setResumeChat(null)
    setPhase('setup')
  }

  // Setup's → button on a saved chat — skip bootstrap entirely and drop
  // straight back into that conversation with its original config + history.
  function handleResumeChat(chat: SavedChat) {
    setAgentConfig(chat.agentConfig)
    setAgentName(chat.agentName)
    setResumeChat(chat)
    setChatKey(k => k + 1)
    setPhase('chat')
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
          onResumeChat={handleResumeChat}
        />
      ) : agentConfig ? (
        <Chat
          key={chatKey}
          agentConfig={agentConfig}
          agentName={agentName}
          onReset={handleReset}
          initialMessages={resumeChat?.messages}
          initialChatId={resumeChat?.id}
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

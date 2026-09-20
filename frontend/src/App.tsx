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
  // Bumped on every bootstrap so Chat remounts with fresh internal
  // state (messages, chatIdRef) instead of reusing a stale instance.
  const [chatKey, setChatKey] = useState(0)
  // Set only when jumping straight into Chat from a saved chat (skipping
  // bootstrap entirely) — cleared on the next fresh bootstrap or reset so a
  // resumed conversation's history doesn't leak into an unrelated agent.
  const [resumedChat, setResumedChat] = useState<SavedChat | null>(null)

  function handleBootstrapStart() {
    setBootstrapError(null)
    setResumedChat(null)
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
    setResumedChat(null)
    setPhase('setup')
  }

  // Drop straight back into Chat with a saved conversation's full history,
  // bypassing bootstrap entirely — the saved AgentConfig already has
  // everything the agent loop needs (see types.ts's SavedChat).
  function handleResumeChat(chat: SavedChat) {
    setAgentConfig(chat.agentConfig)
    setAgentName(chat.agentName)
    setResumedChat(chat)
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
          initialMessages={resumedChat?.messages}
          chatId={resumedChat?.id}
        />
      ) : null}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100%',
    background: 'var(--color-bg)',
    color: 'var(--color-text)',
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
}

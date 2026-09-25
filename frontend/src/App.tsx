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
    // agentName is the identity of the saved character being designed on the
    // Setup screen (typed, Character-Generator-picked, or the random
    // placeholder) — Chat is an interrogation of that same character, so its
    // header must show the exact name Setup showed, never a different one.
    // The bootstrap call also invents its own persona.name from the purpose
    // text (backend/src/bootstrap.py), but that's a separate, cosmetic
    // personality flavor (see agentConfig.persona.traits in Chat.tsx) — it
    // must not silently rename the agent out from under the user.
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

  // "Recommission" — restarts the conversation but keeps the same agent
  // config (same search/keywords/purpose), so the user doesn't have to
  // redo Setup to rerun an existing search. Not a return to Setup at all;
  // it's essentially a restart-chat, just under the existing button name.
  function handleReset() {
    setResumedChat(null)
    setChatKey(k => k + 1)
  }

  // Actual return to Setup — leaves agentConfig/messages alone (no reset of
  // any kind), just switches which screen is showing. If the user comes
  // back to Setup and starts a new search, that naturally replaces
  // agentConfig on the next bootstrap; nothing here deletes the current
  // conversation.
  function handleBackToSetup() {
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
          onBackToSetup={handleBackToSetup}
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

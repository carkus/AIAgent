import { useEffect, useRef, useState } from 'react'
import type { AgentConfig, SavedChatMessage } from '../types'
import { fetchChatRecap } from '../api'
// Same dossier chrome as the app's other modals — reused, not a new dialog style.
import styles from '../styles/FeedbackReportModal.module.css'

// The old "Don't show briefings or recaps" opt-out is gone (the recap now
// carries directions to take next), so clear any flag a browser still holds.
try { localStorage.removeItem('agentone_hide_agent_briefing') } catch { /* ignore */ }

function toolLabel(name: string): string {
  const words = name.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// First sentence only — tool descriptions are written for the model and can run long.
function firstSentence(text: string): string {
  const s = (text ?? '').trim()
  const m = s.match(/^.*?[.!?](\s|$)/)
  return (m ? m[0] : s).trim()
}

interface Props {
  agentConfig: AgentConfig
  agentName: string
  // Set when a saved chat is being resumed: the popup becomes a "Previously…"
  // recap, told by the agent in character, instead of the first-meeting
  // mission briefing.
  resumedMessages?: SavedChatMessage[]
  // Sends one of the recap's proposed directions as the user's next message.
  onDirection?: (direction: string) => void
  // Fresh agent only: leave before the first run starts (Chat.tsx holds
  // the auto-start until this modal closes).
  onBackToSetup?: () => void
  onClose: () => void
}

// Shown once when an agent opens. A freshly bootstrapped agent gives a short,
// in-character rundown of what it's here to do, so a new user isn't dropped
// into an empty chat box with no idea what to ask. A resumed chat instead
// opens like a new chapter: the agent tells the story so far and where things
// stand (backend/src/recap.py), falling back to the mission text on failure.
export default function AgentBriefingModal({ agentConfig, agentName, resumedMessages, onDirection, onBackToSetup, onClose }: Props) {
  const startBtnRef = useRef<HTMLButtonElement>(null)
  const isRecap = !!resumedMessages && resumedMessages.length > 0
  const [recap, setRecap] = useState<string | null>(null)
  const [directions, setDirections] = useState<string[]>([])
  const [recapState, setRecapState] = useState<'loading' | 'done' | 'failed'>(isRecap ? 'loading' : 'done')

  useEffect(() => {
    if (!isRecap) return
    const ctrl = new AbortController()
    fetchChatRecap(resumedMessages!, agentConfig, agentName, ctrl.signal)
      .then(r => { setRecap(r.text); setDirections(r.directions); setRecapState('done') })
      .catch(() => { if (!ctrl.signal.aborted) setRecapState('failed') })
    return () => ctrl.abort()
    // Fetched once per open — the props don't change while the modal is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function close() {
    onClose()
  }

  function pickDirection(direction: string) {
    close()
    onDirection?.(direction)
  }

  const showDirections = isRecap && recapState === 'done' && directions.length > 0 && !!onDirection

  useEffect(() => {
    startBtnRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const intro = agentConfig.intro
    ?? "Reporting for duty. Tell me what you're after and I'll get to work — here's what I've got to work with."
  const tools = agentConfig.tools ?? []

  return (
    <div className={styles.overlay} onClick={close}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-briefing-title"
        onClick={e => e.stopPropagation()}
      >
        <span className={styles.dossierTab} aria-hidden="true">{isRecap ? 'Previously' : 'Briefing'}</span>
        <div className={styles.header}>
          <span id="agent-briefing-title" className={styles.title}>Agent {agentName}</span>
          <button type="button" className={styles.closeBtn} onClick={close} aria-label="Close briefing">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {isRecap && recapState !== 'failed' ? (
            <section className={styles.section}>
              <span className={styles.sectionLabel}>Previously…</span>
              {recapState === 'loading'
                ? <p className={styles.reason} style={{ fontStyle: 'italic', opacity: 0.7 }}>Recalling where we left off…</p>
                : <p className={styles.reason}>{recap}</p>}
            </section>
          ) : (
            <section className={styles.section}>
              <span className={styles.sectionLabel}>Mission</span>
              <p className={styles.reason}>{intro}</p>
            </section>
          )}

          {showDirections && (
            <section className={styles.section}>
              <span className={styles.sectionLabel}>Where to next</span>
              <div className={styles.directions} role="group" aria-label="Directions to take next">
                {directions.map(d => (
                  <button key={d} type="button" className={styles.directionBtn} onClick={() => pickDirection(d)}>
                    {d}
                  </button>
                ))}
              </div>
            </section>
          )}

          {!isRecap && tools.length > 0 && (
            <section className={styles.section}>
              <span className={styles.sectionLabel}>Equipment</span>
              {tools.map(t => (
                <p key={t.name} className={styles.reason}>
                  <strong>{toolLabel(t.name)}</strong>
                  {t.description ? ` — ${firstSentence(t.description)}` : ''}
                </p>
              ))}
            </section>
          )}
        </div>

        <div className={styles.footer}>
          {!isRecap && onBackToSetup && (
            <button type="button" className={styles.dismissBtn} onClick={onBackToSetup}>Back to setup</button>
          )}
          <button ref={startBtnRef} type="button" className={styles.retryBtn} onClick={close}>{showDirections ? "I'll type my own" : isRecap ? 'Pick up where we left off' : "Let's begin"}</button>
        </div>
      </div>
    </div>
  )
}

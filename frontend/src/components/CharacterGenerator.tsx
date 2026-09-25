import { useEffect, useRef, useState } from 'react'
import { generateCharacter, type Character } from '../characterData'
import { getTemplate } from '../agentTypes'
import { buildAgentBrief } from '../agentBrief'
import type { AgentTemplateId } from '../types'
import styles from '../styles/CharacterGenerator.module.css'

// Overlay modal, opened from Setup's header — generates a free, instant
// "field agent" dossier card client-side (no bootstrap/LLM call). Doubles
// as a quick way to eyeball the dossier/stamp visual language and as a
// shareable, no-cost marketing gimmick. Same overlay/dialog shape as
// SettingsModal (backdrop click + Escape to dismiss, focus-on-open) rather
// than a full standalone screen, so opening it doesn't navigate away from
// whatever the user was doing in Setup.
export default function CharacterGenerator({ isOpen, agentType, onClose, onEmploy }: { isOpen: boolean; agentType: AgentTemplateId; onClose: () => void; onEmploy: (character: Character) => void }) {
  const [character, setCharacter] = useState<Character>(() => generateCharacter(agentType))
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return
    // Regenerate against Setup's current type on every open, so a type
    // switched since the last time this was opened isn't left showing a
    // stale, mismatched personality pool.
    setCharacter(generateCharacter(agentType))
    closeBtnRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, onClose])

  // Same deterministic, no-LLM-call brief text Setup.tsx falls back to while
  // its own AI-drafted brief is loading — reused here (not a template of its
  // own) so a generated character's dossier states its actual assignment in
  // plain language, to help decide between re-rolls before spending an
  // "Employ Agent" click. Traits/behaviors are stored upper-cased for the
  // tag chips above; lower-cased here so they read naturally mid-sentence.
  // Uses the surname alone (not firstName+surname) to match how the app
  // refers to a deployed agent everywhere else ("Agent <Surname>").
  const brief = buildAgentBrief(
    character.agentType,
    character.specialties,
    '',
    character.surname,
    character.behaviors.map(b => b.toLowerCase()),
    character.traits.map(t => t.toLowerCase()),
  )

  function handleGenerate() {
    setCharacter(generateCharacter(agentType))
  }

  function handleEmploy() {
    onEmploy(character)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="character-gen-title"
        onClick={e => e.stopPropagation()}
      >
      <span className={styles.dossierTab} aria-hidden="true">Agent File</span>
      <div className={styles.header}>
        <h1 id="character-gen-title" className={styles.pageTitle}>The Agent Files</h1>
        <button type="button" ref={closeBtnRef} className={styles.closeBtn} onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <div className={styles.stage}>
        <div className={styles.card}>
          <span className={styles.stamp}>On File</span>
          <p className={styles.letterhead}>Field Agent Dossier</p>
          <h2 className={styles.name}>{character.firstName} {character.surname}</h2>
          <p className={styles.callsign}>&ldquo;{character.callsign}&rdquo;</p>

          <div className={styles.divider} />

          <p className={styles.roleLine}>{character.role}</p>
          <p className={styles.bureauLine}>{character.bureau} · {getTemplate(character.agentType).label}</p>

          <div className={styles.traitRow}>
            {character.traits.map(t => (
              <span key={t} className={styles.traitTag}>{t}</span>
            ))}
          </div>

          <p className={styles.rowLabel}>Standing Orders</p>
          <div className={styles.traitRow}>
            {character.behaviors.map(b => (
              <span key={b} className={styles.behaviorTag}>{b}</span>
            ))}
          </div>

          <p className={styles.rowLabel}>Assigned Specialties</p>
          <div className={styles.traitRow}>
            {character.specialties.map(s => (
              <span key={s} className={styles.specialtyTag}>{s}</span>
            ))}
          </div>

          <p className={styles.rowLabel}>Assignment Brief</p>
          <p className={styles.briefText}>{brief}</p>

          <p className={styles.tagline}>&ldquo;{character.tagline}&rdquo;</p>

          <div className={styles.divider} />

          <div className={styles.footerRow}>
            <span>ID {character.idNumber}</span>
            <span>{character.issued}</span>
          </div>
          <p className={styles.clearance}>{character.clearance}</p>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.generateBtn} onClick={handleGenerate}>
            Generate New Agent
          </button>
          <button type="button" className={styles.employBtn} onClick={handleEmploy}>
            Employ Agent
          </button>
        </div>
      </div>
      </div>
    </div>
  )
}

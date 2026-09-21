import { useState } from 'react'
import { generateCharacter, type Character } from '../characterData'
import styles from '../styles/CharacterGenerator.module.css'

function cardText(c: Character): string {
  return [
    `${c.firstName} ${c.surname}  ("${c.callsign}")`,
    `${c.role} — ${c.bureau}`,
    `Traits: ${c.traits.join(', ')}`,
    `"${c.tagline}"`,
    `ID ${c.idNumber}  •  Issued ${c.issued}  •  ${c.clearance}`,
  ].join('\n')
}

// Standalone screen, reachable from Setup's header — generates a free,
// instant "field agent" dossier card client-side (no bootstrap/LLM call).
// Doubles as a quick way to eyeball the dossier/stamp visual language and
// as a shareable, no-cost marketing gimmick on its own link.
export default function CharacterGenerator({ onBack }: { onBack: () => void }) {
  const [character, setCharacter] = useState<Character>(generateCharacter)
  const [copied, setCopied] = useState(false)

  function handleGenerate() {
    setCopied(false)
    setCharacter(generateCharacter())
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cardText(character))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied (permissions, non-secure context) —
      // there's nothing actionable to do beyond not showing "Copied".
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <button type="button" className={styles.backBtn} onClick={onBack}>
          &larr; Back
        </button>
        <h1 className={styles.pageTitle}>Character Generator</h1>
        <span className={styles.headerSpacer} aria-hidden="true" />
      </div>

      <div className={styles.stage}>
        <div className={styles.card}>
          <span className={styles.stamp}>On File</span>
          <p className={styles.letterhead}>Field Agent Dossier</p>
          <h2 className={styles.name}>{character.firstName} {character.surname}</h2>
          <p className={styles.callsign}>&ldquo;{character.callsign}&rdquo;</p>

          <div className={styles.divider} />

          <p className={styles.roleLine}>{character.role}</p>
          <p className={styles.bureauLine}>{character.bureau}</p>

          <div className={styles.traitRow}>
            {character.traits.map(t => (
              <span key={t} className={styles.traitTag}>{t}</span>
            ))}
          </div>

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
          <button type="button" className={styles.copyBtn} onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy as Text'}
          </button>
        </div>
      </div>
    </div>
  )
}

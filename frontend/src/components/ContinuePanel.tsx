import styles from '../styles/ContinuePanel.module.css'

interface Props {
  isOpen: boolean
  onToggle: () => void
}

export default function ContinuePanel({ isOpen, onToggle }: Props) {
  return (
    <>
      {/* Toggle button */}
      <button className={styles.toggleBtn} onClick={onToggle} title="Toggle Continue panel">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>

      {/* Right panel */}
      {isOpen && (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <h3 className={styles.panelTitle}>Continue</h3>
            <button className={styles.closeBtn} onClick={onToggle}>✕</button>
          </div>
          <div className={styles.panelContent}>
            <div className={styles.placeholder}>
              <p>Continue IDE Extension</p>
              <p className={styles.hint}>Configure Continue settings or interact with your IDE extension here.</p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

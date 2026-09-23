import { useEffect, useRef } from 'react'
import type { EvalResultItem } from '../types'
import styles from '../styles/FeedbackReportModal.module.css'

interface Props {
  item: EvalResultItem
  onClose: () => void
  onRetry?: () => void
}

function targetLabel(item: EvalResultItem): string {
  switch (item.target) {
    case 'bootstrap':
      return item.target_id ? `Agent setup (${item.target_id})` : 'Agent setup'
    case 'chat_response':
      return 'Chat response'
    case 'tool_call':
      return item.target_id !== null ? `Tool call #${item.target_id}` : 'Tool call'
    case 'worker_delegation':
      return item.target_id ? `Worker ${item.target_id}` : 'Worker'
    default:
      return item.target
  }
}

// Same accessible-overlay contract as SettingsModal.tsx (focus on open,
// Escape to dismiss) — this is the app's one other modal, reused here
// rather than inventing a second dialog pattern for a flagged self-check.
export default function FeedbackReportModal({ item, onClose, onRetry }: Props) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeBtnRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-report-title"
        onClick={e => e.stopPropagation()}
      >
        <span className={styles.dossierTab} aria-hidden="true">Flagged Check</span>
        <div className={styles.header}>
          <span id="feedback-report-title" className={styles.title}>Self-check report</span>
          <button ref={closeBtnRef} type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close report">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <section className={styles.section}>
            <span className={styles.sectionLabel}>Target</span>
            <span className={styles.value}>{targetLabel(item)}</span>
          </section>

          <section className={styles.section}>
            <span className={styles.sectionLabel}>Check</span>
            <span className={styles.value}>{item.check.replace(/_/g, ' ')}</span>
          </section>

          <section className={styles.section}>
            <span className={styles.sectionLabel}>Finding</span>
            <p className={styles.reason}>{item.reason}</p>
          </section>

          <section className={styles.section}>
            <span className={styles.sectionLabel}>Method</span>
            <span className={styles.value}>
              {item.method === 'llm_judge' ? 'AI judge' : 'Deterministic'}
            </span>
          </section>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.dismissBtn} onClick={onClose}>Dismiss</button>
          {onRetry && (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>Try again</button>
          )}
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import type { EvalResultItem } from '../types'
import FeedbackReportModal from './FeedbackReportModal'
import styles from '../styles/FeedbackStatusBar.module.css'

interface FeedbackStatusBarProps {
  results: EvalResultItem[]
  collapsed: boolean
  onToggleCollapse: () => void
  onClear?: () => void
  onRetry?: (item: EvalResultItem) => void
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

// Self-evaluation status bar (root CLAUDE.md eval-framework task): reports,
// for every stage of the session (bootstrap, chat response, tool call,
// worker delegation), that a test was run, what it was, and what it found.
// Presentational only — Chat.tsx and Setup.tsx each own their own
// results/collapsed state and pass it down.
export default function FeedbackStatusBar({ results, collapsed, onToggleCollapse, onClear, onRetry }: FeedbackStatusBarProps) {
  const [reportItem, setReportItem] = useState<EvalResultItem | null>(null)

  if (results.length === 0) return null

  const flagged = results.filter((r) => !r.passed).length
  const hasFlagged = flagged > 0
  // Newest first — the most recent check is the one most relevant right now.
  const ordered = [...results].reverse()

  return (
    <div className={`${styles.bar} ${hasFlagged ? styles.barFlagged : ''}`}>
      <div className={styles.summaryRow}>
        <button
          type="button"
          className={styles.summaryToggle}
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
        >
          <span className={styles.summaryTitle}>Self-checks</span>
          <span className={hasFlagged ? styles.summaryCountFlagged : styles.summaryCount}>
            {results.length}{hasFlagged ? ` · ${flagged} flagged` : ''}
          </span>
        </button>
        <div className={styles.summaryActions}>
          {onClear && (
            <button
              type="button"
              className={styles.clearBtn}
              onClick={() => onClear()}
              aria-label="Clear checks"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className={styles.chevronBtn}
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand checks' : 'Collapse checks'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className={styles.list}>
          {ordered.map((item, i) => (
            <div key={i} className={styles.row}>
              <span className={item.passed ? styles.rowIconPass : styles.rowIconFail}>
                {item.passed ? 'OK' : 'FLAG'}
              </span>
              <span className={styles.rowBody}>
                <span className={styles.rowTarget}>{targetLabel(item)}</span>
                {' — '}
                <span className={styles.rowCheck}>{item.check.replace(/_/g, ' ')}</span>
                {': '}
                <span className={styles.rowReason}>{item.reason}</span>
                {!item.passed && (
                  <button
                    type="button"
                    className={styles.retryBtn}
                    onClick={() => setReportItem(item)}
                  >
                    Report
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {reportItem && (
        <FeedbackReportModal
          item={reportItem}
          onClose={() => setReportItem(null)}
          onRetry={onRetry ? () => { onRetry(reportItem); setReportItem(null) } : undefined}
        />
      )}
    </div>
  )
}

import type { EvalResultItem } from '../types'
import styles from '../styles/FeedbackStatusBar.module.css'

interface FeedbackStatusBarProps {
  results: EvalResultItem[]
  collapsed: boolean
  onToggleCollapse: () => void
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
export default function FeedbackStatusBar({ results, collapsed, onToggleCollapse }: FeedbackStatusBarProps) {
  if (results.length === 0) return null

  const flagged = results.filter((r) => !r.passed).length
  const hasFlagged = flagged > 0
  // Newest first — the most recent check is the one most relevant right now.
  const ordered = [...results].reverse()

  return (
    <div className={`${styles.bar} ${hasFlagged ? styles.barFlagged : ''}`}>
      <button
        type="button"
        className={styles.summaryRow}
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
      >
        <span className={styles.summaryText}>
          {results.length} check{results.length === 1 ? '' : 's'}
          {hasFlagged ? ` · ${flagged} flagged` : ' · all passed'}
        </span>
        <span className={styles.chevron}>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className={styles.list}>
          {ordered.map((item, i) => (
            <div key={i} className={styles.row}>
              <span className={item.passed ? styles.rowIconPass : styles.rowIconFail}>
                {item.passed ? '✓' : '⚠'}
              </span>
              <span className={styles.rowBody}>
                <span className={styles.rowTarget}>{targetLabel(item)}</span>
                {' — '}
                <span className={styles.rowCheck}>{item.check.replace(/_/g, ' ')}</span>
                {': '}
                <span className={styles.rowReason}>{item.reason}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

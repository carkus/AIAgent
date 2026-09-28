import { useState } from 'react'
import CopyButton from './CopyButton'
import styles from '../styles/JsonTree.module.css'

function valueClass(v: unknown): string {
  if (typeof v === 'string') return styles.string
  if (typeof v === 'number') return styles.number
  if (typeof v === 'boolean') return styles.boolean
  return styles.nullVal
}

function formatPrimitive(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`
  if (v === null || v === undefined) return 'null'
  return String(v)
}

function TreeNode({ label, value, depth }: { label: string | null; value: unknown; depth: number }) {
  const isArr = Array.isArray(value)
  const isObj = typeof value === 'object' && value !== null && !isArr
  // Collapsed past two levels deep by default — enough to see shape and
  // top-level fields at a glance without dumping a huge nested payload open.
  const [open, setOpen] = useState(depth < 2)

  if (!isObj && !isArr) {
    const isUrl = typeof value === 'string' && /^https?:\/\//i.test(value)
    return (
      <div className={styles.leaf} style={{ paddingLeft: depth * 14 }}>
        {label !== null && <span className={styles.key}>{label}: </span>}
        {isUrl ? (
          <a href={value as string} target="_blank" rel="noreferrer" className={styles.link}>
            {value as string}
          </a>
        ) : (
          <span className={valueClass(value)}>{formatPrimitive(value)}</span>
        )}
      </div>
    )
  }

  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>)

  if (entries.length === 0) {
    return (
      <div className={styles.leaf} style={{ paddingLeft: depth * 14 }}>
        {label !== null && <span className={styles.key}>{label}: </span>}
        <span className={styles.meta}>{isArr ? '[]' : '{}'}</span>
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        className={styles.branch}
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen(o => !o)}
      >
        <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
        {label !== null && <span className={styles.key}>{label}</span>}
        <span className={styles.meta}>{isArr ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && (
        <div>
          {entries.map(([k, v]) => <TreeNode key={k} label={k} value={v} depth={depth + 1} />)}
        </div>
      )}
    </div>
  )
}

// Collapsible viewer for a parsed JSON value — used wherever a raw API/tool
// payload would otherwise be dumped as a flat JSON.stringify blob (a plain
// object leaf renders inline; arrays/objects are expand/collapse branches).
export default function JsonTree({ data }: { data: unknown }) {
  const json = JSON.stringify(data, null, 2)
  return (
    <div className={styles.wrap}>
      <CopyButton text={json} className={styles.copyBtn} />
      <div className={styles.tree}>
        <TreeNode label={null} value={data} depth={0} />
      </div>
    </div>
  )
}

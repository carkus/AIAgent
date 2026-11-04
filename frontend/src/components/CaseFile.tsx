// The run's "case file": every timed step of one assistant turn (TraceSpan,
// streamed from backend/src/run_trace.py) drawn as a waterfall — LLM calls,
// self-checks / scope-guard verdicts, tool calls and delegated workers, each
// with its model, duration, tokens and status. A worker's own bootstrap and
// agent-loop spans nest under its row. Built entirely from the spans that
// travel with the turn; no server state.
import { useMemo, useState } from 'react'
import type { TraceSpan } from '../types'
import styles from '../styles/CaseFile.module.css'

interface Props {
  spans: TraceSpan[]
  live?: boolean
}

interface Row {
  span: TraceSpan
  depth: number
}

const KIND_LABEL: Record<TraceSpan['kind'], string> = {
  llm: 'Model',
  check: 'Check',
  tool: 'Tool',
  worker: 'Worker',
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function orderRows(spans: TraceSpan[]): Row[] {
  const ids = new Set(spans.map(s => s.id))
  const children = new Map<string | null, TraceSpan[]>()
  for (const s of spans) {
    const key = s.parent && ids.has(s.parent) ? s.parent : null
    const list = children.get(key) ?? []
    list.push(s)
    children.set(key, list)
  }
  for (const list of children.values()) list.sort((a, b) => a.start_ms - b.start_ms)
  const rows: Row[] = []
  const walk = (key: string | null, depth: number) => {
    for (const s of children.get(key) ?? []) {
      rows.push({ span: s, depth })
      walk(s.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

export default function CaseFile({ spans, live }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)

  const { rows, t0, total, totals } = useMemo(() => {
    const t0 = Math.min(...spans.map(s => s.start_ms))
    const tEnd = Math.max(...spans.map(s => s.start_ms + s.duration_ms))
    const sum = (kind: TraceSpan['kind']) =>
      spans.filter(s => s.kind === kind).reduce((n, s) => n + s.duration_ms, 0)
    const modelCalls = spans.filter(s => s.kind === 'llm' || s.kind === 'check')
    const models = Array.from(new Set(modelCalls.map(s => s.model).filter(Boolean))) as string[]
    return {
      rows: orderRows(spans),
      t0,
      total: Math.max(tEnd - t0, 1),
      totals: {
        model: sum('llm'),
        checks: sum('check'),
        tools: sum('tool'),
        workers: spans.filter(s => s.kind === 'worker').length,
        calls: modelCalls.length,
        inTok: spans.reduce((n, s) => n + (s.input_tokens ?? 0), 0),
        outTok: spans.reduce((n, s) => n + (s.output_tokens ?? 0), 0),
        errors: spans.filter(s => s.status === 'error').length,
        models,
      },
    }
  }, [spans])

  return (
    <section className={styles.caseFile} aria-label="Case file: run trace">
      <header className={styles.header}>
        <span className={styles.title}>Case file{live ? ' (in progress)' : ''}</span>
        <span className={styles.stat}><strong>{fmtMs(total)}</strong> wall time</span>
        <span className={styles.stat}><strong>{fmtMs(totals.model)}</strong> reasoning</span>
        {totals.checks > 0 && <span className={styles.stat}><strong>{fmtMs(totals.checks)}</strong> self-checks</span>}
        {totals.tools > 0 && <span className={styles.stat}><strong>{fmtMs(totals.tools)}</strong> tools</span>}
        <span className={styles.stat}><strong>{totals.calls}</strong> model calls</span>
        {totals.workers > 0 && <span className={styles.stat}><strong>{totals.workers}</strong> workers</span>}
        {(totals.inTok > 0 || totals.outTok > 0) && (
          <span className={styles.stat}>
            <strong>{fmtTokens(totals.inTok)}</strong> in / <strong>{fmtTokens(totals.outTok)}</strong> out tokens
          </span>
        )}
        {totals.errors > 0 && <span className={styles.statError}><strong>{totals.errors}</strong> failed</span>}
        {totals.models.length > 0 && <span className={styles.models}>{totals.models.join(', ')}</span>}
      </header>

      <ol className={styles.rows}>
        {rows.map(({ span, depth }) => {
          const left = ((span.start_ms - t0) / total) * 100
          const width = Math.max((span.duration_ms / total) * 100, 0.6)
          const tokens = span.input_tokens != null || span.output_tokens != null
            ? `${fmtTokens(span.input_tokens ?? 0)} → ${fmtTokens(span.output_tokens ?? 0)} tok`
            : null
          const open = openId === span.id
          return (
            <li key={span.id} className={styles.row}>
              <button
                type="button"
                className={styles.rowBtn}
                onClick={() => setOpenId(open ? null : span.id)}
                aria-expanded={open}
              >
                <span className={styles.label} style={{ paddingLeft: `${depth * 1.1}rem` }}>
                  <span className={`${styles.kind} ${styles[`kind_${span.kind}`]}`}>{KIND_LABEL[span.kind]}</span>
                  <span className={span.status === 'error' ? styles.nameError : styles.name}>{span.label}</span>
                </span>
                <span className={styles.track}>
                  <span
                    className={`${styles.bar} ${styles[`bar_${span.kind}`]} ${span.status === 'error' ? styles.barError : ''}`}
                    style={{ left: `${Math.min(left, 99.4)}%`, width: `${width}%` }}
                  />
                </span>
                <span className={styles.dur}>{fmtMs(span.duration_ms)}</span>
              </button>
              {open && (
                <div className={styles.detail} style={{ paddingLeft: `${depth * 1.1}rem` }}>
                  <span>Started +{fmtMs(span.start_ms - t0)}</span>
                  {span.model && <span>{span.provider ? `${span.provider} · ` : ''}{span.model}</span>}
                  {tokens && <span>{tokens}</span>}
                  <span>{span.status === 'error' ? 'Failed' : 'OK'}</span>
                  {span.detail && <p className={styles.detailText}>{span.detail}</p>}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

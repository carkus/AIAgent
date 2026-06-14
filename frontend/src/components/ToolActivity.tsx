import type { ToolCall } from '../types'
import styles from './ToolActivity.module.css'

interface Props {
  toolCalls: ToolCall[]
  live?: boolean
}

function parseResult(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

function InputSummary({ inputs }: { inputs: Record<string, unknown> }) {
  return (
    <span className={styles.inputPills}>
      {Object.entries(inputs).map(([k, v]) => (
        <span key={k} className={styles.pill}>
          <span className={styles.pillKey}>{k}</span>
          <span className={styles.pillVal}>{String(v)}</span>
        </span>
      ))}
    </span>
  )
}

function SearchResults({ data }: { data: Record<string, unknown> }) {
  const results = data.results as Array<Record<string, string>> | undefined
  const count = data.count as number | undefined

  if (!results || results.length === 0) {
    return <p className={styles.noResults}>No results returned.</p>
  }

  return (
    <div>
      {count !== undefined && (
        <p className={styles.resultCount}>{count} result{count !== 1 ? 's' : ''}</p>
      )}
      {results.map((r, i) => (
        <div key={i} className={styles.searchResult}>
          <a href={r.url} target="_blank" rel="noreferrer" className={styles.resultTitle}>
            {r.title}
          </a>
          {r.snippet && <p className={styles.resultSnippet}>{r.snippet}</p>}
        </div>
      ))}
    </div>
  )
}

function FetchResult({ data }: { data: Record<string, unknown> }) {
  const status = data.status_code as number | undefined
  const text = (data.text as string | undefined) ?? ''
  const preview = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)

  return (
    <div>
      {status && <span className={styles.statusBadge}>{status}</span>}
      <p className={styles.fetchPreview}>{preview}{text.length > 400 ? '…' : ''}</p>
    </div>
  )
}

function StatusResult({ data }: { data: Record<string, unknown> }) {
  const isError = data.status === 'error' || data.status === 'no_credentials'
  return (
    <div className={`${styles.statusBox} ${isError ? styles.statusBoxError : styles.statusBoxSuccess}`}>
      <span className={`${styles.statusLabel} ${isError ? styles.statusLabelError : styles.statusLabelSuccess}`}>
        {String(data.status)}
      </span>
      {data.message && <p className={styles.statusMessage}>{String(data.message)}</p>}
    </div>
  )
}

function ResultRenderer({ raw }: { raw: string }) {
  const data = parseResult(raw)

  if (typeof data === 'string') {
    return (
      <pre className={data.startsWith('Tool execution error') ? styles.errorText : styles.plainResult}>
        {data}
      </pre>
    )
  }

  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>
    if ('results' in obj) return <SearchResults data={obj} />
    if ('status_code' in obj && 'text' in obj) return <FetchResult data={obj} />
    if ('status' in obj) return <StatusResult data={obj} />
    return <pre className={styles.plainResult}>{JSON.stringify(data, null, 2)}</pre>
  }

  return <pre className={styles.plainResult}>{raw}</pre>
}

export default function ToolActivity({ toolCalls, live = false }: Props) {
  if (toolCalls.length === 0) return null

  return (
    <div className={styles.container}>
      <p className={styles.heading}>
        {live ? 'Running' : 'Tool activity'} · {toolCalls.length} call{toolCalls.length !== 1 ? 's' : ''}
        {live && <span className={styles.liveDot} />}
      </p>
      {toolCalls.map((tc, i) => (
        <div key={i} className={styles.entry}>
          <div className={styles.entryHeader}>
            <span className={styles.toolName}>{tc.tool}</span>
            <InputSummary inputs={tc.inputs} />
          </div>
          <ResultRenderer raw={tc.result} />
        </div>
      ))}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import MermaidDiagram from './MermaidDiagram'
import JsonTree from './JsonTree'
import { buildRelicPdf, parseCsv, parseSlides, RELIC_LABELS } from '../relicFiles'
import type { Relic } from '../types'
import styles from '../styles/PdfPreviewModal.module.css'
import relicStyles from '../styles/RelicPreviewModal.module.css'
import chatStyles from '../styles/Chat.module.css'

interface Props {
  relic: Relic
  filename: string
  agentName: string
  busy: boolean
  error: string | null
  onDownload: () => void
  onRegenerate: () => void
  onClose: () => void
}

// Shows a built relic before it's downloaded. The preview comes from the
// same text the file is built from, so what's shown is what's saved; PDF is
// the exact file, the others are the closest on-screen equivalent.
export default function RelicPreviewModal({ relic, filename, agentName, busy, error, onDownload, onRegenerate, onClose }: Props) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)

  useEffect(() => {
    if (relic.kind !== 'pdf') return
    const url = buildRelicPdf(relic.content, `Agent ${agentName} report`).output('bloburl').toString()
    setPdfUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [relic, agentName])

  const body = useMemo(() => {
    try {
      switch (relic.kind) {
        case 'pdf':
          return null
        case 'csv': {
          const [head, ...rows] = parseCsv(relic.content)
          return (
            <table className={relicStyles.table}>
              <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          )
        }
        case 'json':
          return <JsonTree data={JSON.parse(relic.content)} />
        case 'diagram':
        case 'chart':
          return <MermaidDiagram chart={relic.content} />
        case 'slides': {
          const deck = parseSlides(relic.content)
          return (
            <>
              <div className={relicStyles.slide}>
                <h3>{deck.title}</h3>
                {deck.subtitle && <p>{deck.subtitle}</p>}
              </div>
              {deck.slides.map((s, i) => (
                <div key={i} className={relicStyles.slide}>
                  <span className={relicStyles.slideNumber}>{i + 1}</span>
                  <h3>{s.title}</h3>
                  {s.bullets.length > 0 && <ul>{s.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul>}
                  {s.notes && <p className={relicStyles.notes}>Notes: {s.notes}</p>}
                </div>
              ))}
            </>
          )
        }
        default:
          return (
            <div className={chatStyles.markdown}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{relic.content}</ReactMarkdown>
            </div>
          )
      }
    } catch {
      return <pre className={relicStyles.raw}>{relic.content}</pre>
    }
  }, [relic])

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>{RELIC_LABELS[relic.kind]} · {filename}</span>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close preview">✕</button>
        </div>
        {relic.kind === 'pdf'
          ? (pdfUrl && <iframe className={styles.frame} src={pdfUrl} title="PDF preview" />)
          : <div className={relicStyles.body}>{body}</div>}
        <div className={styles.actions}>
          {error && <span className={relicStyles.error}>{error}</span>}
          <button type="button" className={styles.cancelBtn} onClick={onClose}>Close</button>
          <button
            type="button"
            className={styles.saveJsonBtn}
            onClick={onRegenerate}
            disabled={busy}
            title="Build this again from the same answer (one more model call)"
          >
            {busy ? 'Regenerating…' : 'Regenerate'}
          </button>
          <button type="button" className={styles.downloadBtn} onClick={onDownload} disabled={busy}>Download</button>
        </div>
      </div>
    </div>
  )
}

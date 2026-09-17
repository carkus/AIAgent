import { useEffect, useId, useState } from 'react'
import mermaid from 'mermaid'
import styles from '../styles/Chat.module.css'

let initialized = false

function ensureInitialized() {
  if (initialized) return
  initialized = true
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      background: '#f5f6f4',
      primaryColor: '#e6f2f1',
      primaryTextColor: '#16324a',
      primaryBorderColor: '#1f6f73',
      lineColor: '#3f7ea0',
      secondaryColor: '#eaf3f7',
      tertiaryColor: '#f0efe9',
      fontSize: '13px',
    },
  })
}

// Renders a ```mermaid fenced code block from the agent's reply as an actual
// diagram (flowchart, pie/bar chart, mind map, etc.) instead of raw text —
// the "prefer a diagram over a wordy paragraph" output style.
export default function MermaidDiagram({ chart }: { chart: string }) {
  ensureInitialized()
  const id = useId().replace(/:/g, '-')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    mermaid.render(`mermaid-${id}`, chart)
      .then(result => { if (!cancelled) setSvg(result.svg) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Diagram failed to render') })
    return () => { cancelled = true }
  }, [chart, id])

  if (error) {
    return (
      <div>
        <p className={styles.mermaidError}>Diagram failed to render — showing raw source.</p>
        <pre>{chart}</pre>
      </div>
    )
  }

  if (!svg) return <p className={styles.mermaidLoading}>Rendering diagram…</p>

  return <div className={styles.mermaidDiagram} dangerouslySetInnerHTML={{ __html: svg }} />
}

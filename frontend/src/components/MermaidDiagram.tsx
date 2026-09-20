import { useEffect, useId, useState } from 'react'
import mermaid from 'mermaid'
import styles from '../styles/Chat.module.css'

const GRAPH_ACCENT = '#05384b'

let initialized = false

function ensureInitialized() {
  if (initialized) return
  initialized = true
  // 'base' only themes flowchart-style nodes (primaryColor/lineColor/etc.) —
  // pie and xychart-beta charts pull their slice/bar colors from their own
  // pie1-12/xyChart palettes instead, which default to mermaid's stock
  // pastel set (includes a washed-out pink) if left unset. Pinning both to
  // the app's own teal/steel-blue/navy palette keeps every chart type
  // consistent instead of just flowcharts.
  const fontFamily = "'Space Grotesk', 'Inter', sans-serif"
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      background: '#f5f6f4',
      primaryColor: '#e6f2f1',
      primaryTextColor: '#16324a',
      primaryBorderColor: GRAPH_ACCENT,
      lineColor: GRAPH_ACCENT,
      secondaryColor: '#eaf3f7',
      tertiaryColor: '#f0efe9',
      fontSize: '9px',
      fontFamily,
      pie1: GRAPH_ACCENT,
      pie2: '#3f7ea0',
      pie3: '#c98a2c',
      pie4: '#6b8f71',
      pie5: '#5c6b73',
      pie6: '#b6552c',
      pie7: '#8a9a3f',
      pie8: '#2f4858',
      pie9: '#d9a441',
      pie10: '#4a7c8c',
      pie11: '#7a5c3e',
      pie12: '#597a4a',
      pieOpacity: '1',
      pieStrokeColor: '#f5f6f4',
      pieOuterStrokeColor: '#16324a',
      pieSectionTextColor: '#16324a',
      pieTitleTextColor: '#16324a',
      pieLegendTextColor: '#33475a',
      xyChart: {
        backgroundColor: '#f5f6f4',
        titleColor: '#16324a',
        xAxisLabelColor: '#33475a',
        xAxisTitleColor: '#33475a',
        xAxisTickColor: '#8a94a0',
        xAxisLineColor: '#8a94a0',
        yAxisLabelColor: '#33475a',
        yAxisTitleColor: '#33475a',
        yAxisTickColor: '#8a94a0',
        yAxisLineColor: '#8a94a0',
        plotColorPalette: `${GRAPH_ACCENT},#3f7ea0,#c98a2c,#6b8f71,#b6552c,#5c6b73`,
      },
    },
    // Without this, mermaid renders each diagram at its own natural
    // (often large) pixel size and CSS max-width just clips it — labels
    // end up overlapping nodes/slices instead of the whole chart shrinking
    // to fit the chat bubble.
    flowchart: { useMaxWidth: true },
    pie: { useMaxWidth: true },
    mindmap: { useMaxWidth: true },
    xyChart: { useMaxWidth: true },
  })
}

// Below this viewport width, a horizontally-laid-out flowchart (LR/RL) has
// nowhere near enough room per node — labels overlap or the whole diagram
// forces the chat bubble to scroll sideways. The model writes the chart
// without knowing the viewer's screen size, so it's adapted here instead.
const NARROW_SCREEN_PX = 480

function adaptChartForWidth(chart: string, screenWidth: number): string {
  if (screenWidth >= NARROW_SCREEN_PX) return chart
  return chart.replace(/^(\s*(?:flowchart|graph)\s+)(LR|RL)\b/im, '$1TD')
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
    const adapted = adaptChartForWidth(chart, window.innerWidth)
    mermaid.render(`mermaid-${id}`, adapted)
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

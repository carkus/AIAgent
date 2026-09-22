import { useEffect, useId, useState } from 'react'
import mermaid from 'mermaid'
import styles from '../styles/Chat.module.css'
import ImageViewer from './ImageViewer'
import CopyButton from './CopyButton'

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
  const fontFamily = "'Share Tech Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    look: 'classic',
    // Without this, a parse/render failure makes mermaid build its own
    // big, unstyled "Syntax error in text" error-diagram SVG and inject it
    // straight into <body> (confirmed in mermaid's own source — it renders
    // that diagram before rethrowing, since no container element is passed
    // to render() below). This suppresses that and just throws, which our
    // own catch below already turns into the quieter raw-source fallback.
    suppressErrorRendering: true,
    themeVariables: {
      background: '#f5f6f4',
      primaryColor: '#e6f2f1',
      primaryTextColor: '#16324a',
      primaryBorderColor: GRAPH_ACCENT,
      lineColor: GRAPH_ACCENT,
      secondaryColor: '#eaf3f7',
      tertiaryColor: '#f0efe9',
      fontSize: '14px',
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
    flowchart: { useMaxWidth: true, curve: 'linear' },
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

// Confirmed against a real failure: the model very often ends a flowchart's
// last edge with a bare `end` node (`--> end`, `-->|done| end`, even
// `end[Finish]`) — a completely natural word choice that mermaid's parser
// rejects, because lowercase `end` is reserved (it's what closes a
// `subgraph` block). Capitalizing it to `End` is mermaid's own documented
// workaround and doesn't collide with a real `subgraph ... end` closer,
// since that always sits alone on its own line with no arrow — only lines
// that contain an edge get the identifier rewritten.
const EDGE_LINE_RE = /-->|---|-\.-|==>|~~~/
const BARE_END_RE = /\bend\b/g

function fixReservedEndKeyword(chart: string): string {
  return chart
    .split('\n')
    .map(line => (EDGE_LINE_RE.test(line) ? line.replace(BARE_END_RE, 'End') : line))
    .join('\n')
}

// Confirmed against real repro output: the model occasionally drops a stray
// extra `]` inside a node's own label text (e.g. `B[Compare providers']]`),
// almost always right after an apostrophe — the closing bracket of the
// node's `[...]` shape gets duplicated. Mermaid's flowchart grammar doesn't
// tolerate the extra bracket and fails the whole diagram over one node. Only
// `[` / `]` pairs are targeted (not `(`/`{`, which have their own legitimate
// node shapes) and only within a single line, since a real node's label
// never spans multiple lines. If a line has more `]` than `[`, the runs of
// closing brackets are collapsed down to however many openers exist —
// `A[Label]]` -> `A[Label]`, `A[Label']]]` -> `A[Label']`. Lines that are
// already balanced (the overwhelming majority) are returned untouched.
function fixUnbalancedBrackets(chart: string): string {
  return chart
    .split('\n')
    .map(line => {
      const opens = (line.match(/\[/g) || []).length
      const closes = (line.match(/\]/g) || []).length
      if (closes <= opens) return line
      let excess = closes - opens
      return line.replace(/\]+/g, run => {
        if (excess <= 0) return run
        const drop = Math.min(excess, run.length - 1)
        excess -= drop
        return run.slice(drop)
      })
    })
    .join('\n')
}

// A response occasionally puts plain English (not Mermaid syntax at all)
// into what should have been a ```mermaid-plan/```mermaid fence — confirmed
// in live repro. Rendering that as a diagram always fails and, for the
// labeled Plan-preview usage, surfaces as a broken-looking error box instead
// of just not showing a diagram at all. Cheap heuristic: every real Mermaid
// diagram type opens with one of a small fixed set of keywords on its own
// first non-blank line.
const DIAGRAM_KEYWORD_RE = /^\s*(flowchart|graph|pie|xychart-beta|mindmap|sequenceDiagram|classDiagram|stateDiagram|gantt|journey|erDiagram|timeline|quadrantChart)\b/im

function looksLikeMermaid(chart: string): boolean {
  return DIAGRAM_KEYWORD_RE.test(chart)
}

// Mermaid's rendered <svg> root always carries width="100%" and no height
// attribute at all, relying on a definite-width ancestor to resolve that
// percentage against. That's true for the inline chat preview (.mermaidDiagram
// has a real CSS width), so it renders fine there — but ImageViewer's
// full-screen overlay centers it in a flex box with no definite width of its
// own, and percentage/auto sizing on an SVG with no other intrinsic size
// collapses to 0x0 in that context (confirmed via a standalone repro:
// getBoundingClientRect() on the overlay's svg came back {w:0, h:0} while the
// identical string rendered inline at its real size). Rewriting the root
// element to carry explicit pixel width/height read straight from its own
// viewBox (which mermaid always sets) gives it a self-contained intrinsic
// size in any container, so the existing max-width/max-height:100% rules in
// both CSS contexts can scale it down from a real starting size instead of a
// circular zero.
function withExplicitSvgSize(svg: string): string {
  const match = svg.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/)
  if (!match) return svg
  const [, vbWidth, vbHeight] = match
  return svg.replace(/<svg\b([^>]*)>/, (_full, attrs: string) => {
    const cleaned = attrs.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '')
    return `<svg${cleaned} width="${vbWidth}" height="${vbHeight}">`
  })
}

interface Props {
  chart: string
  // Set only by the plan-preview usage (Chat.tsx) — when present, this
  // component owns the whole labeled box (heading + lead-in sentence) and,
  // critically, shows none of it — not even a loading placeholder — until
  // the diagram has actually finished rendering. A "Plan" box appearing
  // before its diagram is drawn reads as broken, not as loading.
  label?: string
  caption?: string
}

// Renders a ```mermaid fenced code block from the agent's reply as an actual
// diagram (flowchart, pie/bar chart, mind map, etc.) instead of raw text —
// the "prefer a diagram over a wordy paragraph" output style.
export default function MermaidDiagram({ chart, label, caption }: Props) {
  ensureInitialized()
  const id = useId().replace(/:/g, '-')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)

  useEffect(() => {
    if (!looksLikeMermaid(chart)) {
      setSvg(null)
      setError('not-mermaid')
      return
    }
    let cancelled = false
    const adapted = fixUnbalancedBrackets(fixReservedEndKeyword(adaptChartForWidth(chart, window.innerWidth)))
    mermaid.render(`mermaid-${id}`, adapted)
      .then(result => { if (!cancelled) setSvg(withExplicitSvgSize(result.svg)) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Diagram failed to render') })
    return () => { cancelled = true }
  }, [chart, id])

  // Text that never looked like Mermaid in the first place (the model put
  // plain prose in what should have been a diagram fence) — for the labeled
  // Plan-preview usage, show nothing rather than a broken-looking error box;
  // the plain inline-fence usage still falls through to the raw-source
  // fallback below, since there the surrounding chat message already reads
  // fine as plain text either way.
  if (error === 'not-mermaid' && label) return null

  if (!svg && !error) {
    // A labeled box (the plan preview) shows nothing at all while the
    // diagram is still being drawn, rather than an empty/half-finished box
    // with a heading and no picture. The plain inline-fence usage (no
    // label) keeps the lightweight loading line, since it isn't wrapped in
    // its own box to begin with.
    if (label) return null
    return <p className={styles.mermaidLoading}>Rendering diagram…</p>
  }

  const body = error ? (
    <div>
      <p className={styles.mermaidError}>Diagram failed to render — showing raw source.</p>
      <div className={styles.codeCopyWrap}>
        <pre>{chart}</pre>
        <CopyButton text={chart} className={styles.codeCopyBtn} />
      </div>
    </div>
  ) : (
    <>
      <div
        className={styles.mermaidDiagram}
        role="button"
        tabIndex={0}
        aria-label="Open diagram in full view"
        onClick={() => setViewerOpen(true)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setViewerOpen(true)
          }
        }}
        dangerouslySetInnerHTML={{ __html: svg ?? '' }}
      />
      {viewerOpen && svg && <ImageViewer svg={svg} onClose={() => setViewerOpen(false)} />}
    </>
  )

  if (!label) return body

  return (
    <div className={styles.planDiagram}>
      <span className={styles.planDiagramLabel}>{label}</span>
      {caption && <p className={styles.planSummary}>{caption}</p>}
      {body}
    </div>
  )
}

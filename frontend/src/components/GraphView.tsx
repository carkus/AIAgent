// Live node-to-node visualization of one assistant turn's reasoning/tool-use
// trace — a new toggleable view that sits alongside (not replacing)
// ToolActivity.tsx's existing card-based log, per explicit user direction.
// Reads the same TimelineNode[] Chat.tsx accumulates from the agent loop's
// StreamEvents (status/tool_start/tool_result/plan/done/error) — no backend
// changes needed, the event stream already has the right granularity.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  useStore,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { TimelineNode } from '../graphTimeline'
import type { EvalResultItem, TraceSpan } from '../types'
import JsonTree from './JsonTree'
import GraphFrame from './GraphFrame'
import { useDragScroll } from '../useDragScroll'
import styles from '../styles/GraphView.module.css'
import { toolDisplayName } from '../toolLabels'

interface Props {
  timeline: TimelineNode[]
  live?: boolean
  evalResults?: EvalResultItem[]
  // The turn's run-trace spans (CaseFile.tsx's data) — tool and worker
  // nodes show their duration from the top-level span with the same
  // call_index.
  trace?: TraceSpan[]
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

// Horizontal layout: each step is a column, left to right, and the frame
// scrolls sideways rather than shrinking the graph to the chat width.
// Parallel steps (a wave of delegated workers) stack top to bottom in their
// column, so the frame's height is set by the widest branch.
const NODE_WIDTH = 236 // GraphView.module.css .node
const COL_GAP = 56 // room for the edges between columns
const ROW_GAP = 18
const DEFAULT_NODE_HEIGHT = 72 // until React Flow has measured the real card

function parseResultPreview(raw: string | undefined): string {
  if (!raw || raw === '…') return ''
  let text = raw
  try {
    const data = JSON.parse(raw)
    text = typeof data === 'string' ? data : JSON.stringify(data)
  } catch { /* use raw as-is */ }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 150 ? text.slice(0, 150) + '…' : text
}

// Plain-text preview of a markdown reply: drops fenced blocks (diagrams,
// options), link targets and markup characters.
function replyPreview(md: string | undefined): string {
  if (!md) return ''
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 160 ? text.slice(0, 160).replace(/\s+\S*$/, '') + '…' : text
}

// What the run as a whole took, for the "Reply ready" card and its detail.
interface RunSummary {
  tools: number
  workers: number
  modelCalls: number
  tokens: number
  wallMs: number
  diagrams: number
}

function summarizeRun(timeline: TimelineNode[], trace: TraceSpan[], response: string): RunSummary {
  const toolNodes = timeline.filter(n => n.kind === 'tool')
  const workers = toolNodes.filter(n => n.kind === 'tool' && n.tool === 'delegate_to_worker').length
  let tokens = 0
  let first = Infinity
  let last = 0
  for (const s of trace) {
    tokens += (s.input_tokens ?? 0) + (s.output_tokens ?? 0)
    if (!s.parent) {
      first = Math.min(first, s.start_ms)
      last = Math.max(last, s.start_ms + s.duration_ms)
    }
  }
  return {
    tools: toolNodes.length - workers,
    workers,
    modelCalls: trace.filter(s => !s.parent && (s.kind === 'llm' || s.kind === 'check')).length,
    tokens,
    wallMs: first === Infinity ? 0 : last - first,
    diagrams: (response.match(/```mermaid/g) ?? []).length,
  }
}

function runSummaryLine(r: RunSummary): string {
  return [
    r.tools > 0 && `${r.tools} tool${r.tools === 1 ? '' : 's'}`,
    r.workers > 0 && `${r.workers} worker${r.workers === 1 ? '' : 's'}`,
    r.modelCalls > 0 && `${r.modelCalls} model call${r.modelCalls === 1 ? '' : 's'}`,
    r.diagrams > 0 && `${r.diagrams} diagram${r.diagrams === 1 ? '' : 's'}`,
    r.wallMs > 0 && fmtDuration(r.wallMs),
  ].filter(Boolean).join(' · ')
}

function toolIcon(node: Extract<TimelineNode, { kind: 'tool' }>): string {
  if (node.tool === 'delegate_to_worker') return '🤝'
  if (node.source === 'mcp') return '🔌'
  if (node.source === 'generated') return '⚙️'
  return '🧰'
}

// Parses a raw tool/status payload for the full-detail modal — a JSON
// object/array renders through the shared JsonTree viewer (browsable,
// collapsible, same component ToolActivity.tsx and Chat.tsx already use for
// this) instead of a flat JSON.stringify dump; anything else (plain text,
// markdown) falls back to raw text.
function tryParseJson(raw: string | undefined): unknown {
  if (!raw || raw === '…') return undefined
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function nodeDisplay(node: TimelineNode, pending: boolean): { icon: string; title: string; subtitle: string; variant: 'plan' | 'status' | 'tool' | 'done' | 'error' } {
  switch (node.kind) {
    case 'plan':
      return { icon: '🧭', title: 'Plan', subtitle: node.summary ?? '', variant: 'plan' }
    case 'status':
      return { icon: '💭', title: node.title ?? 'Thinking', subtitle: node.why ?? node.message, variant: 'status' }
    case 'tool':
      return { icon: toolIcon(node), title: toolDisplayName(node.tool), subtitle: pending ? 'running…' : parseResultPreview(node.result), variant: 'tool' }
    case 'done':
      return { icon: '✅', title: 'Reply ready', subtitle: replyPreview(node.response), variant: 'done' }
    case 'error':
      return { icon: '⚠️', title: 'Error', subtitle: node.message, variant: 'error' }
  }
}

interface TraceNodeData {
  node: TimelineNode
  pending: boolean
  isLast: boolean
  evalSummary?: { passed: number; failed: number }
  span?: TraceSpan
  run?: RunSummary
  onOpen: (node: TimelineNode) => void
}

function TraceNode({ data }: { data: TraceNodeData }) {
  const { node, pending, evalSummary, span, run, onOpen } = data
  const { icon, title, subtitle, variant } = nodeDisplay(node, pending)

  return (
    <div
      className={`${styles.node} ${styles[`node_${variant}`]} ${pending ? styles.nodePending : ''}`}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onOpen(node) }}
    >
      <Handle isConnectable={false} type="target" position={Position.Left} className={styles.handle} />
      <div className={styles.nodeHeader}>
        <span className={styles.nodeIcon} aria-hidden="true">{icon}</span>
        <span className={styles.nodeTitle}>{title}</span>
        {pending && <span className={styles.liveDot} />}
      </div>
      {subtitle && <p className={styles.nodeSubtitle}>{subtitle}</p>}
      {span && (
        <p className={styles.nodeMeta}>
          {fmtDuration(span.duration_ms)}
          {span.kind === 'worker' && ' · worker'}
          {span.status === 'error' && <span className={styles.evalFail}> · failed</span>}
        </p>
      )}
      {evalSummary && (evalSummary.passed > 0 || evalSummary.failed > 0) && (
        <p className={styles.nodeEval}>
          {evalSummary.passed > 0 && <span className={styles.evalPass}>✓ {evalSummary.passed}</span>}
          {evalSummary.failed > 0 && <span className={styles.evalFail}>✕ {evalSummary.failed}</span>}
          <span className={styles.evalLabel}>self-checks</span>
        </p>
      )}
      {run && runSummaryLine(run) && <p className={styles.nodeMeta}>{runSummaryLine(run)}</p>}
      {node.kind === 'done' && <span className={styles.nodeOpen}>Full reply and checks ›</span>}
      <Handle isConnectable={false} type="source" position={Position.Right} className={styles.handle} />
    </div>
  )
}

const nodeTypes = { trace: TraceNode }

// Full-screen overlay for one tapped node — same click-outside-to-close
// pattern as ImageViewer.tsx, read-only/no zoom since this is text, not an
// image. Shows the untruncated title/message/inputs/result the compact
// 320px card can only ever preview.
function NodeDetailModal({ node, onClose, evalResults, run }: { node: TimelineNode; onClose: () => void; evalResults: EvalResultItem[]; run?: RunSummary }) {
  const { icon, title } = nodeDisplay(node, node.kind === 'tool' && node.result === undefined)
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalPanel} onClick={e => e.stopPropagation()}>
        <button type="button" className={styles.modalCloseBtn} onClick={onClose} aria-label="Close node detail">✕</button>
        <div className={styles.modalHeader}>
          <span aria-hidden="true">{icon}</span>
          <span>{title}</span>
        </div>
        {node.kind === 'plan' && (
          <p className={styles.modalText}>{node.summary || '(no summary)'}</p>
        )}
        {node.kind === 'status' && (
          <>
            {node.why && <p className={styles.modalText}>{node.why}</p>}
            <p className={styles.modalText}>{node.message}</p>
          </>
        )}
        {node.kind === 'error' && (
          <p className={styles.modalText}>{node.message}</p>
        )}
        {node.kind === 'done' && (
          <>
            {run && runSummaryLine(run) && <p className={styles.modalMeta}>{runSummaryLine(run)}{run.tokens > 0 && ` · ${run.tokens.toLocaleString()} tokens`}</p>}
            <p className={styles.modalLabel}>Reply</p>
            {(() => {
              const parsed = tryParseJson(node.response)
              return parsed !== undefined
                ? <JsonTree data={parsed} />
                : node.response
                  ? <div className={styles.modalMarkdown}><ReactMarkdown remarkPlugins={[remarkGfm]}>{node.response}</ReactMarkdown></div>
                  : <p className={styles.modalText}>(empty)</p>
            })()}
            {evalResults.length > 0 && (
              <>
                <p className={styles.modalLabel}>Self-checks</p>
                <ul className={styles.checkList}>
                  {evalResults.map((e, i) => (
                    <li key={`${e.check}-${i}`}>
                      <span className={e.passed ? styles.evalPass : styles.evalFail}>{e.passed ? '✓' : '✕'}</span>{' '}
                      <strong>{e.check.replace(/_/g, ' ')}</strong>
                      {e.reason && <span className={styles.checkReason}> — {e.reason}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        {node.kind === 'tool' && (
          <>
            {node.inputs && Object.keys(node.inputs).length > 0 && (
              <>
                <p className={styles.modalLabel}>Inputs</p>
                <JsonTree data={node.inputs} />
              </>
            )}
            <p className={styles.modalLabel}>Result</p>
            {node.result === undefined ? (
              <p className={styles.modalText}>running…</p>
            ) : (() => {
              const parsed = tryParseJson(node.result)
              return parsed !== undefined
                ? <JsonTree data={parsed} />
                : <pre className={styles.modalPre}>{node.result || '(empty)'}</pre>
            })()}
          </>
        )}
      </div>
    </div>
  )
}

interface Size { width: number; height: number }

function buildGraph(timeline: TimelineNode[], live: boolean, evalResults: EvalResultItem[], trace: TraceSpan[], onOpen: (node: TimelineNode) => void, sizes: Map<string, Size>): { nodes: Node[]; edges: Edge[] } {
  const spanByCall = new Map<number, TraceSpan>()
  for (const s of trace) {
    if (!s.parent && s.call_index != null && (s.kind === 'tool' || s.kind === 'worker')) spanByCall.set(s.call_index, s)
  }
  // Rank assignment: 'plan'/'status'/'done'/'error' always start a fresh
  // column; a run of 'tool' nodes following the same status/plan shares one
  // column (parallel delegate_to_worker waves stack within that column) —
  // see graphTimeline.ts's module doc for why this mirrors the backend's own
  // status-boundary event shape instead of needing a separate layout engine.
  let sawAny = false
  let maxRank = -1
  let toolCol: number | null = null
  const rankOf = new Map<string, number>()

  for (const node of timeline) {
    let r: number
    if (node.kind === 'tool') {
      r = toolCol !== null ? toolCol : (sawAny ? maxRank + 1 : 0)
      toolCol = r
    } else {
      r = sawAny ? maxRank + 1 : 0
      toolCol = r + 1
    }
    sawAny = true
    maxRank = Math.max(maxRank, r)
    rankOf.set(node.id, r)
  }

  const byRank = new Map<number, TimelineNode[]>()
  for (const node of timeline) {
    const r = rankOf.get(node.id)!
    if (!byRank.has(r)) byRank.set(r, [])
    byRank.get(r)!.push(node)
  }

  const hasTerminal = timeline.some(n => n.kind === 'done' || n.kind === 'error')
  const lastNode = timeline[timeline.length - 1]
  const evalSummary = evalResults.length > 0
    ? { passed: evalResults.filter(e => e.passed).length, failed: evalResults.filter(e => !e.passed).length }
    : undefined

  // One column per rank, left to right. A column's cards stack downward,
  // centred on the same midline, so a single step lines up with the middle
  // of the branch before or after it.
  const pos = new Map<string, { x: number; y: number }>()
  ;[...byRank.keys()].sort((a, b) => a - b).forEach((r, col) => {
    const group = byRank.get(r)!
    const heights = group.map(n => sizes.get(n.id)?.height ?? DEFAULT_NODE_HEIGHT)
    const total = heights.reduce((a, b) => a + b, 0) + ROW_GAP * (group.length - 1)
    let y = -total / 2
    group.forEach((n, i) => {
      pos.set(n.id, { x: col * (NODE_WIDTH + COL_GAP), y })
      y += heights[i] + ROW_GAP
    })
  })

  const nodes: Node[] = timeline.map(node => {
    const pending = node.kind === 'tool'
      ? node.result === undefined
      : live && !hasTerminal && node === lastNode
    return {
      id: node.id,
      type: 'trace',
      position: pos.get(node.id)!,
      // React Flow drops its measurement whenever it is handed a new node
      // object; passing the last known size back keeps the layout stable
      // (its ResizeObserver still reports any real change in size).
      ...(sizes.has(node.id) ? { measured: sizes.get(node.id) } : {}),
      data: { node, pending, isLast: node === lastNode, evalSummary: node.kind === 'done' ? evalSummary : undefined, span: node.kind === 'tool' ? spanByCall.get(node.callIndex) : undefined, run: node.kind === 'done' ? summarizeRun(timeline, trace, node.response) : undefined, onOpen },
      draggable: false,
      connectable: false,
    }
  })

  const edges: Edge[] = []
  const ranks = [...byRank.keys()].sort((a, b) => a - b)
  for (let i = 0; i < ranks.length - 1; i++) {
    const from = byRank.get(ranks[i])!
    const to = byRank.get(ranks[i + 1])!
    const toPending = to.some(n => n.kind === 'tool' ? n.result === undefined : (live && !hasTerminal && n === lastNode))
    for (const a of from) {
      for (const b of to) {
        edges.push({
          id: `${a.id}->${b.id}`,
          source: a.id,
          target: b.id,
          animated: toPending,
          className: styles.edge,
        })
      }
    }
  }

  return { nodes, edges }
}

export default function GraphView(props: Props) {
  if (props.timeline.length === 0) {
    return <p className={styles.empty}>No live trace recorded for this reply.</p>
  }
  // The provider lets the frame's zoom buttons drive React Flow's own viewport.
  return (
    <ReactFlowProvider>
      <GraphViewInner {...props} />
    </ReactFlowProvider>
  )
}

// Inset (px) around the graph, and the tallest the frame may grow (as a
// share of the window) before the graph is zoomed out to fit instead.
const FIT_PAD = 16
const MAX_FRAME_VH = 0.85
const MIN_FRAME_PX = 140
const MIN_ZOOM = 0.2
const MAX_ZOOM = 2
const ZOOM_STEP = 1.25

function GraphViewInner({ timeline, live = false, evalResults = [], trace = [] }: Props) {
  const [openNode, setOpenNode] = useState<TimelineNode | null>(null)
  // Measured card heights feed back into the layout so rows sit tight.
  const [sizes, setSizes] = useState<Map<string, Size>>(() => new Map())
  const { nodes, edges } = useMemo(() => buildGraph(timeline, live, evalResults, trace, setOpenNode, sizes), [timeline, live, evalResults, trace, sizes])
  const flow = useReactFlow()
  const initialized = useNodesInitialized()
  // Changes whenever any card's measured size changes, so a card that grows
  // in place (no node added) still triggers a re-layout and refit.
  const sizeKey = useStore(st => {
    let k = ''
    for (const n of st.nodeLookup.values()) k += `${n.id}:${Math.round(n.measured?.width ?? 0)}x${Math.round(n.measured?.height ?? 0)};`
    return k
  })
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState<number | undefined>(undefined)
  const [contentWidth, setContentWidth] = useState<number | undefined>(undefined)
  // null = automatic: 100%, or smaller only if the tallest branch would
  // push the frame past MAX_FRAME_VH. The +/- buttons set it explicitly.
  const [userZoom, setUserZoom] = useState<number | null>(null)
  const [zoomLevel, setZoomLevel] = useState(1)
  // While live, keep the newest step in view unless the reader scrolled back.
  const followRef = useRef(true)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // The frame is sized to the graph: exactly as tall as its tallest
  // branch, and as wide as the whole run, which the frame scrolls through
  // sideways. React Flow's own viewport is the full drawn width, so it never
  // pans; the browser's scrollbar does the moving.
  const fitToContent = useCallback(() => {
    if (!width) return
    // By id, so React Flow uses its internal measured sizes; the user
    // nodes' own `measured` can lag a card that just grew.
    const b = flow.getNodesBounds(flow.getNodes().map(n => n.id))
    if (!b.width || !b.height) return
    const maxH = window.innerHeight * MAX_FRAME_VH
    const z = userZoom ?? Math.min(1, (maxH - 2 * FIT_PAD) / b.height)
    const h = Math.max(MIN_FRAME_PX, b.height * z + 2 * FIT_PAD)
    const w = Math.max(width, b.width * z + 2 * FIT_PAD)
    setHeight(h)
    setContentWidth(w)
    setZoomLevel(z)
    void flow.setViewport({
      x: FIT_PAD - b.x * z,
      y: (h - b.height * z) / 2 - b.y * z,
      zoom: z,
    })
    const scroller = scrollRef.current
    if (live && followRef.current && scroller) {
      requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth })
    }
  }, [flow, width, userZoom, live])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const onScroll = () => {
      followRef.current = scroller.scrollWidth - scroller.scrollLeft - scroller.clientWidth < 40
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })

    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])
  useDragScroll(scrollRef)

  const zoomBy = (factor: number) =>
    setUserZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel * factor)))

  // Fit-to-frame is the default view, and it is re-applied whenever the
  // graph changes (a step or worker added, a card resized) or the frame
  // width changes, even if the user had zoomed or panned in the meantime.
  // Runs a frame late so React Flow's store already holds the new
  // positions and measured sizes when the bounds are read.
  useEffect(() => {
    // Merge every real (non-zero) measurement into the layout sizes; a card
    // that grew moves everything below it down on the next render.
    let changed = false
    const next = new Map(sizes)
    for (const { id } of flow.getNodes()) {
      // The internal node holds the ResizeObserver's latest size.
      const m = flow.getInternalNode(id)?.measured
      const w = Math.round(m?.width ?? 0)
      const h = Math.round(m?.height ?? 0)
      if (!w || !h) continue
      const prev = next.get(id)
      if (!prev || prev.width !== w || prev.height !== h) { next.set(id, { width: w, height: h }); changed = true }
    }
    if (changed) { setSizes(next); return } // re-layout; this effect runs again and then fits
    if (!initialized) return
    const raf = requestAnimationFrame(fitToContent)
    return () => cancelAnimationFrame(raf)
  }, [initialized, nodes, sizeKey, fitToContent, flow, sizes])

  return (
    <div ref={wrapRef}>
    <GraphFrame
      className={styles.container}
      label="Reasoning trace graph"
      height={height}
      scrollX
      contentWidth={contentWidth}
      scrollRef={scrollRef}
      zoom={{
        zoomIn: () => zoomBy(ZOOM_STEP),
        zoomOut: () => zoomBy(1 / ZOOM_STEP),
        fit: () => setUserZoom(null),
        level: zoomLevel,
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        minZoom={0.1}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        connectOnClick={false}
        elementsSelectable={false}
        onNodeClick={(_, n) => setOpenNode((n.data as unknown as TraceNodeData).node)}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e2dfd5" />
      </ReactFlow>
      {/* Portalled: inside the frame, a transformed ancestor turned the
          fixed overlay into one clipped to the graph box. */}
      {openNode && createPortal(
        <NodeDetailModal
          node={openNode}
          onClose={() => setOpenNode(null)}
          evalResults={evalResults}
          run={openNode.kind === 'done' ? summarizeRun(timeline, trace, openNode.response) : undefined}
        />,
        document.body,
      )}
    </GraphFrame>
    </div>
  )
}

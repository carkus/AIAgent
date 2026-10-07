// Live node-to-node visualization of one assistant turn's reasoning/tool-use
// trace — a new toggleable view that sits alongside (not replacing)
// ToolActivity.tsx's existing card-based log, per explicit user direction.
// Reads the same TimelineNode[] Chat.tsx accumulates from the agent loop's
// StreamEvents (status/tool_start/tool_result/plan/done/error) — no backend
// changes needed, the event stream already has the right granularity.
import { useMemo, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { TimelineNode } from '../graphTimeline'
import type { EvalResultItem } from '../types'
import JsonTree from './JsonTree'
import GraphFrame from './GraphFrame'
import styles from '../styles/GraphView.module.css'

interface Props {
  timeline: TimelineNode[]
  live?: boolean
  evalResults?: EvalResultItem[]
}

const COL_WIDTH = 360
const ROW_HEIGHT = 150

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
      return { icon: '💭', title: 'Thinking', subtitle: node.message, variant: 'status' }
    case 'tool':
      return { icon: toolIcon(node), title: node.tool, subtitle: pending ? 'running…' : parseResultPreview(node.result), variant: 'tool' }
    case 'done':
      return { icon: '✅', title: 'Reply ready', subtitle: parseResultPreview(node.response), variant: 'done' }
    case 'error':
      return { icon: '⚠️', title: 'Error', subtitle: node.message, variant: 'error' }
  }
}

interface TraceNodeData {
  node: TimelineNode
  pending: boolean
  isLast: boolean
  evalSummary?: { passed: number; failed: number }
  onOpen: (node: TimelineNode) => void
}

function TraceNode({ data }: { data: TraceNodeData }) {
  const { node, pending, evalSummary, onOpen } = data
  const { icon, title, subtitle, variant } = nodeDisplay(node, pending)

  return (
    <div
      className={`${styles.node} ${styles[`node_${variant}`]} ${pending ? styles.nodePending : ''}`}
      onClick={() => onOpen(node)}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onOpen(node) }}
    >
      <Handle type="target" position={Position.Left} className={styles.handle} />
      <div className={styles.nodeHeader}>
        <span className={styles.nodeIcon} aria-hidden="true">{icon}</span>
        <span className={styles.nodeTitle}>{title}</span>
        {pending && <span className={styles.liveDot} />}
      </div>
      {subtitle && <p className={styles.nodeSubtitle}>{subtitle}</p>}
      {evalSummary && (evalSummary.passed > 0 || evalSummary.failed > 0) && (
        <p className={styles.nodeEval}>
          {evalSummary.passed > 0 && <span className={styles.evalPass}>✓ {evalSummary.passed}</span>}
          {evalSummary.failed > 0 && <span className={styles.evalFail}>✕ {evalSummary.failed}</span>}
        </p>
      )}
      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  )
}

const nodeTypes = { trace: TraceNode }

// Full-screen overlay for one tapped node — same click-outside-to-close
// pattern as ImageViewer.tsx, read-only/no zoom since this is text, not an
// image. Shows the untruncated title/message/inputs/result the compact
// 320px card can only ever preview.
function NodeDetailModal({ node, onClose }: { node: TimelineNode; onClose: () => void }) {
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
          <p className={styles.modalText}>{node.message}</p>
        )}
        {node.kind === 'error' && (
          <p className={styles.modalText}>{node.message}</p>
        )}
        {node.kind === 'done' && (() => {
          const parsed = tryParseJson(node.response)
          return parsed !== undefined
            ? <JsonTree data={parsed} />
            : <p className={styles.modalText}>{node.response || '(empty)'}</p>
        })()}
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

function buildGraph(timeline: TimelineNode[], live: boolean, evalResults: EvalResultItem[], onOpen: (node: TimelineNode) => void): { nodes: Node[]; edges: Edge[] } {
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

  const nodes: Node[] = timeline.map(node => {
    const r = rankOf.get(node.id)!
    const group = byRank.get(r)!
    const idx = group.indexOf(node)
    const y = idx * ROW_HEIGHT - ((group.length - 1) * ROW_HEIGHT) / 2
    const pending = node.kind === 'tool'
      ? node.result === undefined
      : live && !hasTerminal && node === lastNode
    return {
      id: node.id,
      type: 'trace',
      position: { x: r * COL_WIDTH, y },
      data: { node, pending, isLast: node === lastNode, evalSummary: node.kind === 'done' ? evalSummary : undefined, onOpen },
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

const FIT_OPTIONS = { padding: 0.25, maxZoom: 1 }

function GraphViewInner({ timeline, live = false, evalResults = [] }: Props) {
  const [openNode, setOpenNode] = useState<TimelineNode | null>(null)
  const { nodes, edges } = useMemo(() => buildGraph(timeline, live, evalResults, setOpenNode), [timeline, live, evalResults])
  const flow = useReactFlow()
  const { zoom } = useViewport()

  return (
    <GraphFrame
      className={styles.container}
      label="Reasoning trace graph"
      zoom={{
        zoomIn: () => { void flow.zoomIn({ duration: 150 }) },
        zoomOut: () => { void flow.zoomOut({ duration: 150 }) },
        fit: () => { void flow.fitView({ ...FIT_OPTIONS, duration: 150 }) },
        level: zoom,
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={FIT_OPTIONS}
        minZoom={0.1}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e2dfd5" />
      </ReactFlow>
      {openNode && <NodeDetailModal node={openNode} onClose={() => setOpenNode(null)} />}
    </GraphFrame>
  )
}

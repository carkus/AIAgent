// The Setup Brief drawn as a flow: the commission → how the agent understood
// it → the lines of work it will split into → the result it hands back.
// Same look and behaviour as the run trace (GraphView): horizontal, sized to
// its tallest branch, scrolled or dragged sideways inside GraphFrame. The
// content is the brief call's own "map" (brief.py's _brief_map), so it is
// the model's reading of the job, not a re-layout of the keyword list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { BriefMap } from '../api'
import GraphFrame from './GraphFrame'
import { useDragScroll } from '../useDragScroll'
import graph from '../styles/GraphView.module.css'
import styles from '../styles/BriefGraph.module.css'

const NODE_WIDTH = 220 // BriefGraph.module.css .node
const COL_GAP = 48
const ROW_GAP = 14
const DEFAULT_NODE_HEIGHT = 70
const FIT_PAD = 14
const MIN_FRAME_PX = 120
const MIN_ZOOM = 0.3
const MAX_ZOOM = 2
const ZOOM_STEP = 1.25

type Variant = 'ask' | 'understood' | 'work' | 'result'

interface BriefNodeData extends Record<string, unknown> {
  variant: Variant
  icon: string
  title: string
  detail?: string
  items?: string[]
}

function BriefNode({ data }: { data: BriefNodeData }) {
  return (
    <div className={`${styles.node} ${styles[`node_${data.variant}`]}`}>
      {data.variant !== 'ask' && <Handle type="target" position={Position.Left} className={graph.handle} />}
      <div className={graph.nodeHeader}>
        <span className={graph.nodeIcon} aria-hidden="true">{data.icon}</span>
        <span className={styles.nodeTitle}>{data.title}</span>
      </div>
      {data.detail && <p className={styles.nodeText}>{data.detail}</p>}
      {data.items && data.items.length > 0 && (
        <ul className={styles.nodeList}>
          {data.items.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      )}
      {data.variant !== 'result' && <Handle type="source" position={Position.Right} className={graph.handle} />}
    </div>
  )
}

const nodeTypes = { brief: BriefNode }

interface Size { width: number; height: number }

function buildGraph(map: BriefMap, sizes: Map<string, Size>): { nodes: Node[]; edges: Edge[] } {
  const columns: { id: string; data: BriefNodeData }[][] = [
    [{ id: 'ask', data: { variant: 'ask', icon: '📨', title: 'The commission', detail: map.ask } }],
    ...(map.understood.length > 0
      ? [[{ id: 'understood', data: { variant: 'understood' as const, icon: '🧠', title: 'Understood as', items: map.understood } }]]
      : []),
    map.work.map((w, i) => ({
      id: `work-${i}`,
      data: { variant: 'work' as const, icon: '🕵️', title: w.label, detail: w.detail || undefined },
    })),
    [{ id: 'result', data: { variant: 'result', icon: '📁', title: 'Desired result', detail: map.result } }],
  ]

  // Same placement as the trace graph: one column per stage, a stage's
  // branches stacked and centred on a shared midline.
  const nodes: Node[] = []
  columns.forEach((col, c) => {
    const heights = col.map(n => sizes.get(n.id)?.height ?? DEFAULT_NODE_HEIGHT)
    let y = -(heights.reduce((a, b) => a + b, 0) + ROW_GAP * (col.length - 1)) / 2
    col.forEach((n, i) => {
      nodes.push({
        id: n.id,
        type: 'brief',
        position: { x: c * (NODE_WIDTH + COL_GAP), y },
        ...(sizes.has(n.id) ? { measured: sizes.get(n.id) } : {}),
        data: n.data,
        draggable: false,
        connectable: false,
      })
      y += heights[i] + ROW_GAP
    })
  })

  const edges: Edge[] = []
  for (let c = 0; c < columns.length - 1; c++) {
    for (const a of columns[c]) {
      for (const b of columns[c + 1]) {
        edges.push({ id: `${a.id}->${b.id}`, source: a.id, target: b.id, className: graph.edge })
      }
    }
  }
  return { nodes, edges }
}

export default function BriefGraph({ map }: { map: BriefMap }) {
  return (
    <ReactFlowProvider>
      <BriefGraphInner map={map} />
    </ReactFlowProvider>
  )
}

function BriefGraphInner({ map }: { map: BriefMap }) {
  const [sizes, setSizes] = useState<Map<string, Size>>(() => new Map())
  const { nodes, edges } = useMemo(() => buildGraph(map, sizes), [map, sizes])
  const flow = useReactFlow()
  const initialized = useNodesInitialized()
  const sizeKey = useStore(st => {
    let k = ''
    for (const n of st.nodeLookup.values()) k += `${n.id}:${Math.round(n.measured?.width ?? 0)}x${Math.round(n.measured?.height ?? 0)};`
    return k
  })
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useDragScroll(scrollRef)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState<number | undefined>(undefined)
  const [contentWidth, setContentWidth] = useState<number | undefined>(undefined)
  const [userZoom, setUserZoom] = useState<number | null>(null)
  const [zoomLevel, setZoomLevel] = useState(1)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const fitToContent = useCallback(() => {
    if (!width) return
    const b = flow.getNodesBounds(flow.getNodes().map(n => n.id))
    if (!b.width || !b.height) return
    const z = userZoom ?? 1
    const h = Math.max(MIN_FRAME_PX, b.height * z + 2 * FIT_PAD)
    setHeight(h)
    setContentWidth(Math.max(width, b.width * z + 2 * FIT_PAD))
    setZoomLevel(z)
    void flow.setViewport({ x: FIT_PAD - b.x * z, y: (h - b.height * z) / 2 - b.y * z, zoom: z })
  }, [flow, width, userZoom])

  // Feed measured card heights back into the layout, then fit.
  useEffect(() => {
    let changed = false
    const next = new Map(sizes)
    for (const { id } of flow.getNodes()) {
      const m = flow.getInternalNode(id)?.measured
      const w = Math.round(m?.width ?? 0)
      const h = Math.round(m?.height ?? 0)
      if (!w || !h) continue
      const prev = next.get(id)
      if (!prev || prev.width !== w || prev.height !== h) { next.set(id, { width: w, height: h }); changed = true }
    }
    if (changed) { setSizes(next); return }
    if (!initialized) return
    const raf = requestAnimationFrame(fitToContent)
    return () => cancelAnimationFrame(raf)
  }, [initialized, nodes, sizeKey, fitToContent, flow, sizes])

  const zoomBy = (factor: number) =>
    setUserZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel * factor)))

  return (
    <div ref={wrapRef}>
      <GraphFrame
        className={graph.container}
        label="Brief graph"
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
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#e2dfd5" />
        </ReactFlow>
      </GraphFrame>
    </div>
  )
}

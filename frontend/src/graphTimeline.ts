// Shared data model for the live "node-to-node" reasoning graph (GraphView.tsx)
// — an ordered trace of everything that happened during one assistant turn,
// built incrementally by Chat.tsx's sendMessage() switch block as StreamEvents
// arrive, alongside (not replacing) the existing liveToolCalls/toolCalls log
// data ToolActivity.tsx already renders. Purely a frontend accumulation; the
// backend emits no new events for this — see CLAUDE.md's "Live status
// updates during the agent loop" for the status/tool_start/tool_result/done
// vocabulary this reads.
import type { ToolCall } from './types'

export type TimelineNode =
  | { id: string; kind: 'plan'; seq: number; summary: string | null }
  | { id: string; kind: 'status'; seq: number; message: string }
  | {
      id: string
      kind: 'tool'
      seq: number
      callIndex: number
      tool: string
      // Omitted (not merely undefined) on the tool_result patch — see
      // appendTimelineNode below, which relies on an absent key leaving the
      // tool_start-captured inputs untouched during the object-spread merge.
      inputs?: Record<string, unknown>
      result?: string
      source?: ToolCall['source']
    }
  | { id: string; kind: 'done'; seq: number; response: string }
  | { id: string; kind: 'error'; seq: number; message: string }

// Appends a new node, or — for a 'tool' node whose callIndex already has a
// 'tool' entry (the tool_result for an earlier tool_start) — patches that
// entry in place instead of duplicating it, mirroring how liveToolCalls
// already resolves tool_result against its matching tool_start by callIndex.
export function appendTimelineNode(timeline: TimelineNode[], node: TimelineNode): TimelineNode[] {
  if (node.kind === 'tool') {
    const idx = timeline.findIndex(n => n.kind === 'tool' && n.callIndex === node.callIndex)
    if (idx !== -1) {
      const prev = timeline[idx] as Extract<TimelineNode, { kind: 'tool' }>
      const next = [...timeline]
      // Same "prefer the already-captured value" precedence as Chat.tsx's
      // liveToolCalls merge (tc.source ?? event.source) — tool_result
      // carries no `inputs` and may carry no `source`, so either patch must
      // not clobber what tool_start already captured.
      next[idx] = {
        ...prev,
        result: node.result ?? prev.result,
        source: prev.source ?? node.source,
      }
      return next
    }
  }
  return [...timeline, node]
}

let seqCounter = 0
export function nextSeq(): number {
  seqCounter += 1
  return seqCounter
}

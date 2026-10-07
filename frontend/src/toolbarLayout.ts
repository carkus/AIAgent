// User-arranged toolbars: per-toolbar button order and visibility, edited
// with ToolbarBuilder and remembered in this browser (localStorage, a
// per-viewer convenience — a missing or blocked store just means the
// default layout). Any toolbar can opt in: give it an id and its items.
import { useCallback, useMemo, useState, type DragEvent } from 'react'

export interface ToolbarItem {
  id: string
  label: string
  // Items only reorder within their own group, so a visually distinct group
  // (e.g. the Brief's outputs) stays together.
  group: string
  // Always shown; can still be moved.
  locked?: boolean
}

interface StoredLayout {
  order: string[]
  hidden: string[]
}

const storageKey = (toolbarId: string) => `aiagent_toolbar_${toolbarId}`

function readLayout(toolbarId: string): StoredLayout | null {
  try {
    const raw = localStorage.getItem(storageKey(toolbarId))
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!Array.isArray(data?.order) || !Array.isArray(data?.hidden)) return null
    return { order: data.order.map(String), hidden: data.hidden.map(String) }
  } catch {
    return null
  }
}

function writeLayout(toolbarId: string, layout: StoredLayout | null) {
  try {
    if (layout) localStorage.setItem(storageKey(toolbarId), JSON.stringify(layout))
    else localStorage.removeItem(storageKey(toolbarId))
  } catch {
    // Storage blocked: the layout still applies for this page view.
  }
}

// Stored ids that no longer exist are dropped; items added since the layout
// was saved go at the end of the order, visible.
function reconcile(items: ToolbarItem[], stored: StoredLayout | null): StoredLayout {
  const known = new Set(items.map(i => i.id))
  const order = (stored?.order ?? []).filter(id => known.has(id))
  for (const item of items) if (!order.includes(item.id)) order.push(item.id)
  const locked = new Set(items.filter(i => i.locked).map(i => i.id))
  const hidden = (stored?.hidden ?? []).filter(id => known.has(id) && !locked.has(id))
  return { order, hidden }
}

export interface ToolbarLayout {
  items: ToolbarItem[]
  // Visible ids of one group, in the user's order.
  visible: (group: string) => string[]
  // All ids of one group (shown and hidden), in the user's order.
  ordered: (group: string) => string[]
  isHidden: (id: string) => boolean
  // Puts `id` where `targetId` is, within their shared group.
  moveTo: (id: string, targetId: string) => void
  toggle: (id: string) => void
  reset: () => void
  isDefault: boolean
}

export function useToolbarLayout(toolbarId: string, items: ToolbarItem[]): ToolbarLayout {
  const [stored, setStored] = useState<StoredLayout | null>(() => readLayout(toolbarId))
  const layout = useMemo(() => reconcile(items, stored), [items, stored])
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items])

  const save = useCallback((next: StoredLayout | null) => {
    setStored(next)
    writeLayout(toolbarId, next)
  }, [toolbarId])

  const ordered = useCallback(
    (group: string) => layout.order.filter(id => byId.get(id)?.group === group),
    [layout, byId],
  )

  const visible = useCallback(
    (group: string) => ordered(group).filter(id => !layout.hidden.includes(id)),
    [ordered, layout],
  )

  const moveTo = useCallback((id: string, targetId: string) => {
    if (id === targetId || byId.get(id)?.group !== byId.get(targetId)?.group) return
    const order = layout.order.filter(o => o !== id)
    const at = order.indexOf(targetId)
    const after = layout.order.indexOf(id) < layout.order.indexOf(targetId)
    order.splice(after ? at + 1 : at, 0, id)
    save({ order, hidden: layout.hidden })
  }, [byId, layout, save])

  const toggle = useCallback((id: string) => {
    if (byId.get(id)?.locked) return
    const hidden = layout.hidden.includes(id)
      ? layout.hidden.filter(h => h !== id)
      : [...layout.hidden, id]
    save({ order: layout.order, hidden })
  }, [byId, layout, save])

  const reset = useCallback(() => save(null), [save])

  return {
    items,
    visible,
    ordered,
    isHidden: id => layout.hidden.includes(id),
    moveTo,
    toggle,
    reset,
    isDefault: stored === null,
  }
}

// Drag-to-reorder on the toolbar's own buttons: spread dragProps(id) onto
// each button. Buttons reorder live as the dragged one passes over a peer
// in the same group, and the new order is saved with the layout.
export function useToolbarDrag(layout: ToolbarLayout) {
  const [dragId, setDragId] = useState<string | null>(null)
  const groupOf = (id: string) => layout.items.find(i => i.id === id)?.group
  return {
    dragId,
    dragProps: (id: string) => ({
      draggable: true,
      onDragStart: (e: DragEvent) => { setDragId(id); e.dataTransfer.effectAllowed = 'move' },
      onDragEnter: () => { if (dragId) layout.moveTo(dragId, id) },
      onDragOver: (e: DragEvent) => { if (dragId && groupOf(dragId) === groupOf(id)) e.preventDefault() },
      onDrop: (e: DragEvent) => e.preventDefault(),
      onDragEnd: () => setDragId(null),
    }),
  }
}

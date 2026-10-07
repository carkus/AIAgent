import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ToolbarLayout } from '../toolbarLayout'
import styles from '../styles/ToolbarBuilder.module.css'

interface Props {
  layout: ToolbarLayout
  // Sections of the editor, in display order; items reorder within these.
  groups: { id: string; label: string }[]
  renderIcon?: (id: string) => ReactNode
  disabled?: boolean
}

// The "customise this toolbar" button and its editor: tick to show or hide
// each button, or reset to default. Order is changed on the toolbar itself,
// by dragging a button (useToolbarDrag).
// Works for any toolbar driven by useToolbarLayout.
export default function ToolbarBuilder({ layout, groups, renderIcon, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const labelOf = (id: string) => layout.items.find(i => i.id === id)?.label ?? id
  const lockedIds = new Set(layout.items.filter(i => i.locked).map(i => i.id))

  return (
    <div className={styles.wrap} ref={wrapRef} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Customise toolbar: show or hide buttons (drag a button to move it)"
        aria-label="Customise toolbar"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="5" cy="12" r="1.2" />
          <circle cx="12" cy="12" r="1.2" />
          <circle cx="19" cy="12" r="1.2" />
        </svg>
      </button>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Customise toolbar">
          {groups.map(group => {
            const ids = layout.ordered(group.id)
            if (ids.length === 0) return null
            return (
              <section key={group.id} className={styles.group}>
                <h4 className={styles.groupTitle}>{group.label}</h4>
                <ul className={styles.list}>
                  {ids.map(id => {
                    const hidden = layout.isHidden(id)
                    const locked = lockedIds.has(id)
                    return (
                      <li key={id} className={`${styles.row} ${hidden ? styles.rowHidden : ''}`}>
                        {renderIcon && <span className={styles.icon} aria-hidden="true">{renderIcon(id)}</span>}
                        <span className={styles.label}>{labelOf(id)}</span>
                        <label className={styles.show} title={locked ? 'Always shown' : hidden ? 'Show' : 'Hide'}>
                          <input
                            type="checkbox"
                            checked={!hidden}
                            disabled={locked}
                            onChange={() => layout.toggle(id)}
                            aria-label={`Show ${labelOf(id)}`}
                          />
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
          <div className={styles.footer}>
            <button type="button" className={styles.resetBtn} onClick={layout.reset} disabled={layout.isDefault}>
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

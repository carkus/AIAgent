import { useEffect, useRef, useState } from 'react'
import { THEME_COLORS, getCurrentTheme, resetTheme, setThemeColor } from '../theme'
import styles from '../styles/ThemeSettings.module.css'

// A small always-present control (fixed corner, every phase — splash/setup/
// chat all render inside App.tsx's root) so appearance isn't tied to any one
// screen: the "main default colours" (background/surface/text/accents — see
// theme.ts) are a global preference, not a per-agent setting like the
// existing SettingsModal's location/provider fields.
export default function ThemeSettings() {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setValues(getCurrentTheme())
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function handleChange(key: string, value: string) {
    setThemeColor(key, value)
    setValues(v => ({ ...v, [key]: value }))
  }

  function handleReset() {
    resetTheme()
    setValues(getCurrentTheme())
  }

  return (
    <div className={styles.wrap} ref={panelRef}>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Colour theme">
          <div className={styles.panelHeader}>
            <span>Colours</span>
            <button type="button" className={styles.closeBtn} onClick={() => setOpen(false)} aria-label="Close colour picker">✕</button>
          </div>
          {THEME_COLORS.map(c => (
            <label key={c.key} className={styles.row}>
              <input
                type="color"
                className={styles.swatch}
                value={values[c.key] ?? c.default}
                onChange={e => handleChange(c.key, e.target.value)}
              />
              <span className={styles.label}>{c.label}</span>
            </label>
          ))}
          <button type="button" className={styles.resetBtn} onClick={handleReset}>Reset to defaults</button>
        </div>
      )}
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(o => !o)}
        aria-label="Change theme colours"
        title="Change theme colours"
      >
        🎨
      </button>
    </div>
  )
}

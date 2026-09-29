import { useEffect, useRef, useState } from 'react'
import { THEME_TOKENS, getStoredOverrides, setThemeOverride, resetTheme, type ThemeOverrides } from '../theme'
import styles from '../styles/ThemePicker.module.css'

interface Props {
  isOpen: boolean
  onClose: () => void
}

// Deliberately its own floating popover, not a section inside SettingsModal
// (which sits behind a full-screen dimming overlay) — the whole point of a
// live color picker is watching the rest of the app change color as you
// drag a swatch, so this renders with no backdrop at all: the page stays
// fully visible and interactive around it.
export default function ThemePicker({ isOpen, onClose }: Props) {
  const [themeOverrides, setThemeOverrides] = useState<ThemeOverrides>(() => getStoredOverrides())
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function handlePointerDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby="theme-picker-title"
    >
      <div className={styles.header}>
        <span id="theme-picker-title" className={styles.title}>Theme</span>
        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close theme picker">
          ✕
        </button>
      </div>

      <div className={styles.grid}>
        {THEME_TOKENS.map(token => (
          <label key={token.key} className={styles.field}>
            <input
              type="color"
              className={styles.swatch}
              value={themeOverrides[token.key] || token.default}
              onChange={e => setThemeOverrides(setThemeOverride(token.key, e.target.value))}
            />
            <span>{token.label}</span>
          </label>
        ))}
      </div>

      <button
        type="button"
        className={styles.resetBtn}
        onClick={() => setThemeOverrides(resetTheme())}
        disabled={Object.keys(themeOverrides).length === 0}
      >
        Reset to default colors
      </button>
    </div>
  )
}

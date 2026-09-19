// The app's "main default colours" — background, cards, text, and the two
// accent colors used throughout Chat/Setup/ToolActivity for links, buttons,
// and highlights (see index.css's :root block, which defines the CSS
// variable each of these keys maps to and documents which literal hexes
// were migrated to reference them). ThemeSettings.tsx is the only consumer;
// this module just owns the read/write/persist mechanics so that component
// stays UI-only.
export interface ThemeColorDef {
  key: string
  label: string
  default: string
}

export const THEME_COLORS: ThemeColorDef[] = [
  { key: '--color-bg', label: 'Background', default: '#fbfaf8' },
  { key: '--color-surface', label: 'Cards / panels', default: '#fffefd' },
  { key: '--color-text', label: 'Text', default: '#16324a' },
  { key: '--color-accent', label: 'Primary accent (links, buttons)', default: '#0b495e' },
  { key: '--color-accent-secondary', label: 'Secondary accent', default: '#3f7ea0' },
]

const STORAGE_KEY = 'aiagent-theme-overrides'

/** Call once at startup — reapplies any saved overrides on top of index.css's defaults. */
export function loadTheme(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as Record<string, string>
    for (const { key } of THEME_COLORS) {
      if (saved[key]) document.documentElement.style.setProperty(key, saved[key])
    }
  } catch {
    // Malformed/blocked storage — just run with the CSS defaults.
  }
}

/** Current effective value for each variable (inline override, else the CSS default). */
export function getCurrentTheme(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement)
  const result: Record<string, string> = {}
  for (const { key, default: fallback } of THEME_COLORS) {
    const inline = document.documentElement.style.getPropertyValue(key).trim()
    result[key] = inline || computed.getPropertyValue(key).trim() || fallback
  }
  return result
}

export function setThemeColor(key: string, value: string): void {
  document.documentElement.style.setProperty(key, value)
  persist()
}

export function resetTheme(): void {
  for (const { key } of THEME_COLORS) {
    document.documentElement.style.removeProperty(key)
  }
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

function persist(): void {
  try {
    const current: Record<string, string> = {}
    for (const { key } of THEME_COLORS) {
      const v = document.documentElement.style.getPropertyValue(key).trim()
      if (v) current[key] = v
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Theme just won't survive a reload — not worth surfacing an error for.
  }
}

// Central catalog of the app's editable theme colors, backing the Settings
// tab's color picker. Mirrors src/styles/index.css's :root custom properties
// — this is the "variable" that index.css's own comment (theme colors, no
// live picker, "tried and removed") refers to; this file is that picker,
// rebuilt fresh rather than resurrecting whatever the prior attempt was.
//
// Only the *base* tokens are user-editable. --color-accent-hover isn't a
// separate swatch — it's derived from --color-accent via an HSL lightness
// shift (shiftLightness below) so a changed base color's hover state stays
// visually coherent instead of drifting out of sync with a hand-picked hex
// the user never touched.

export interface ThemeToken {
  key: string
  cssVar: string
  label: string
  default: string
}

export const THEME_TOKENS: ThemeToken[] = [
  { key: 'bg', cssVar: '--color-bg', label: 'Page background', default: '#fbfaf8' },
  { key: 'surface', cssVar: '--color-surface', label: 'Card/surface background', default: '#fffefd' },
  { key: 'text', cssVar: '--color-text', label: 'Body text', default: '#1f5373' },
  { key: 'muted', cssVar: '--color-muted', label: 'Muted/secondary text', default: '#6b7785' },
  { key: 'border', cssVar: '--color-border', label: 'Borders', default: '#ddd9cd' },
  { key: 'accent', cssVar: '--color-accent', label: 'Buttons and Focus', default: '#014792' },
  { key: 'accentSecondary', cssVar: '--color-accent-secondary', label: 'Secondary accent', default: '#3f7ea0' },
  { key: 'dossier', cssVar: '--color-dossier', label: 'Dossier panel', default: '#ede4cd' },
]

export type ThemeOverrides = Partial<Record<string, string>>

const STORAGE_KEY = 'aiagent-theme-overrides'

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')
  return `#${c(r / 255)}${c(g / 255)}${c(b / 255)}`
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  const d = max - min
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r: h = ((g - b) / d) % 6; break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4; break
    }
    h *= 60
    if (h < 0) h += 360
  }
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

// Shifts lightness by `delta` (negative = darker), holding hue/saturation
// fixed. Falls back to the input hex unchanged if it isn't a valid #rrggbb.
function shiftLightness(hex: string, delta: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const [h, s, l] = rgbToHsl(...rgb)
  const [r, g, b] = hslToRgb(h, s, clamp01(l + delta))
  return rgbToHex(r, g, b)
}

function hexToRgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

// Re-derives one of the manila-folder palette's originally-hardcoded colors
// (e.g. the dossier border or title text) from a new picked base color, by
// transferring the same hue/saturation/lightness offset that the *default*
// version of that color had from the *default* base — so picking a new
// folder color shifts its border/text/shadow shades along with it instead
// of leaving them stuck on the old tan.
function deriveRelative(newBase: string, defaultBase: string, defaultTarget: string): string {
  const newRgb = hexToRgb(newBase)
  const baseRgb = hexToRgb(defaultBase)
  const targetRgb = hexToRgb(defaultTarget)
  if (!newRgb || !baseRgb || !targetRgb) return defaultTarget
  const [newH, newS, newL] = rgbToHsl(...newRgb)
  const [baseH, baseS, baseL] = rgbToHsl(...baseRgb)
  const [targetH, targetS, targetL] = rgbToHsl(...targetRgb)
  const [r, g, b] = hslToRgb(
    (newH + (targetH - baseH) + 360) % 360,
    clamp01(newS + (targetS - baseS)),
    clamp01(newL + (targetL - baseL)),
  )
  return rgbToHex(r, g, b)
}

export function getStoredOverrides(): ThemeOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function storeOverrides(overrides: ThemeOverrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // Best-effort only — a failed save just means the picked theme won't
    // survive a reload; the applied colors on the current page are unaffected.
  }
}

// Applies overrides (falling back to each token's default) as CSS custom
// properties on :root, and re-derives the hover/active/tint variants that
// index.css otherwise hardcodes for --color-accent/--color-menu-bg.
export function applyTheme(overrides: ThemeOverrides): void {
  const root = document.documentElement.style
  const get = (key: string) => overrides[key] || THEME_TOKENS.find(t => t.key === key)!.default

  for (const token of THEME_TOKENS) {
    root.setProperty(token.cssVar, get(token.key))
  }

  const accent = get('accent')
  root.setProperty('--color-accent-hover', shiftLightness(accent, -0.12))

  // Manila-folder palette — every dossier/modal surface (SettingsModal,
  // CharacterGenerator, AgentStableModal, FeedbackReportModal's shared
  // chrome, plus Setup's own saved-searches folder) was previously a
  // hardcoded copy of the same handful of tan/brown hex values; all of them
  // now shift together relative to this one base swatch.
  const dossier = get('dossier')
  const DOSSIER_DEFAULT = '#ede4cd'
  const deriveDossier = (defaultTarget: string) => deriveRelative(dossier, DOSSIER_DEFAULT, defaultTarget)
  const dossierText = deriveDossier('#6b5a32')
  root.setProperty('--color-dossier-border', deriveDossier('#cfbf94'))
  root.setProperty('--color-dossier-text', dossierText)
  root.setProperty('--color-dossier-muted', deriveDossier('#8a7a52'))
  root.setProperty('--color-dossier-shadow-light', deriveDossier('#f5eeda'))
  root.setProperty('--color-dossier-shadow-mid', deriveDossier('#e2d6b3'))
  root.setProperty('--color-dossier-text-a35', hexToRgba(dossierText, 0.35))
  root.setProperty('--color-dossier-text-a10', hexToRgba(dossierText, 0.1))
  root.setProperty('--color-dossier-text-a08', hexToRgba(dossierText, 0.08))
  root.setProperty('--color-dossier-setup-bg', deriveDossier('#f1ebd9'))
  root.setProperty('--color-dossier-setup-border', deriveDossier('#ddd9cd'))
  root.setProperty('--color-dossier-setup-shadow-light', deriveDossier('#faf8f0'))
  root.setProperty('--color-dossier-setup-shadow-mid', deriveDossier('#e2dfd5'))
}

export function setThemeOverride(key: string, hex: string): ThemeOverrides {
  const next = { ...getStoredOverrides(), [key]: hex }
  storeOverrides(next)
  applyTheme(next)
  return next
}

export function resetTheme(): ThemeOverrides {
  storeOverrides({})
  applyTheme({})
  return {}
}

// Cross-app date-format preference, set on the Settings screen
// (SettingsModal.tsx's "Date & Time" section) and persisted under the same
// aiagent_* localStorage idiom Setup.tsx already uses for provider/
// maxDelegations/searchDefaults. Setup.tsx owns a reactive useState mirror
// of this key for its own dropdown + saved-chat/search timestamps; every
// other place that renders a date (Chat.tsx's header clock,
// ToolActivity.tsx's job-listing posted dates, chatPdf.ts's export footer)
// has no shared state with Setup's phase, so it reads the same key straight
// from localStorage via getDateFormat() instead of receiving it as a prop.
export type DateFormatId = 'auto' | 'dmy' | 'mdy' | 'iso'

export const DATE_FORMAT_STORAGE_KEY = 'aiagent_date_format'

export const DATE_FORMAT_OPTIONS: { id: DateFormatId; label: string }[] = [
  { id: 'auto', label: 'Auto (browser locale)' },
  { id: 'dmy', label: 'DD/MM/YYYY' },
  { id: 'mdy', label: 'MM/DD/YYYY' },
  { id: 'iso', label: 'YYYY-MM-DD' },
]

export function getDateFormat(): DateFormatId {
  const raw = localStorage.getItem(DATE_FORMAT_STORAGE_KEY)
  return raw === 'dmy' || raw === 'mdy' || raw === 'iso' ? raw : 'auto'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatDate(value: Date | string | number, format: DateFormatId, withTime = false): string {
  const date = value instanceof Date ? value : new Date(value)
  if (isNaN(date.getTime())) return ''

  if (format === 'auto') {
    return withTime
      ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  }

  const time = withTime ? ` ${pad(date.getHours())}:${pad(date.getMinutes())}` : ''
  if (format === 'dmy') return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}${time}`
  if (format === 'mdy') return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}${time}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}${time}` // iso
}

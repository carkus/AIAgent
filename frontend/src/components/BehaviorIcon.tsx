// Mono line-art behaviour-toggle icons (stroke=currentColor, no fill), shared
// by Setup.tsx and AdvancedSetup.tsx so both screens render the same pills.
// Same mono line-art style as Setup.tsx's AgentTypeIcon (stroke=currentColor, no
// fill) — the behavior toggles previously used colorful emoji, which read
// as a different, more novelty visual language than the rest of the picker
// UI; these plain geometric glyphs match the site's own style instead.
export default function BehaviorIcon({ id }: { id: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (id) {
    case 'concise':
      return (
        <svg {...common}>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="15" y2="12" />
          <line x1="4" y1="17" x2="10" y2="17" />
        </svg>
      )
    case 'skeptical':
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <line x1="20.5" y1="20.5" x2="15.3" y2="15.3" />
          <path d="M8.7 8.8a1.8 1.8 0 1 1 2.9 1.4c-.9.7-1.1 1.1-1.1 2" />
          <circle cx="10.5" cy="14.6" r="0.65" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'cite-sources':
      return (
        <svg {...common}>
          <path d="M10 14a5 5 0 0 0 7.07 0l1.83-1.83a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
          <path d="M14 10a5 5 0 0 0-7.07 0L5.1 11.83a5 5 0 0 0 7.07 7.07l1.5-1.5" />
        </svg>
      )
    case 'proactive':
      return (
        <svg {...common}>
          <path d="M4 16 10 10l3 3 6-7" />
          <path d="M16 6h4v4" />
        </svg>
      )
    case 'max-delegation':
      return (
        <svg {...common}>
          <circle cx="12" cy="5.3" r="1.6" />
          <circle cx="5.3" cy="18.3" r="1.6" />
          <circle cx="18.7" cy="18.3" r="1.6" />
          <path d="M12 7v3.5M12 10.5 6.4 16.8M12 10.5l5.6 6.3" />
        </svg>
      )
    default:
      return null
  }
}

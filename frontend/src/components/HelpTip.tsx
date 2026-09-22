import styles from '../styles/HelpTip.module.css'

interface Props {
  text: string
  label: string
  // 'lg' is only used for the one generic panel-level help button (Setup.tsx's
  // agentCard header) — every per-subsection help button is the default 'sm'.
  size?: 'sm' | 'lg'
  // 'up' opens the popover above the button instead of below — for buttons
  // near the bottom of their container where a downward popover would run
  // off the panel or get clipped by scroll overflow.
  direction?: 'down' | 'up'
  className?: string
}

// Small "?" button whose explanation appears on hover/focus — a plain CSS
// :hover/:focus-within reveal (the popover is always in the DOM, just
// invisible) rather than a click-to-toggle popover mounted via React state,
// so it never "loads in" a beat after the pointer arrives. The button itself
// does nothing on click (no onClick handler at all), so it can sit inside a
// parent that toggles a collapsed section without needing to stop
// propagation on a click that no longer happens.
export default function HelpTip({ text, label, size = 'sm', direction = 'down', className }: Props) {
  return (
    <span className={`${styles.wrap} ${direction === 'up' ? styles.up : ''} ${className ?? ''}`}>
      <button
        type="button"
        className={size === 'lg' ? styles.btnLg : styles.btn}
        onClick={e => e.stopPropagation()}
        aria-label={label}
      >
        ?
      </button>
      <span className={styles.popover} role="tooltip">
        {text}
      </span>
    </span>
  )
}

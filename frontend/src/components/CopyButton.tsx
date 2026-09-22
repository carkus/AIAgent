import { useState } from 'react'
import styles from '../styles/CopyButton.module.css'

// Shared clipboard-copy control for every code/JSON display area (fenced
// code blocks, tool-call plain/error/JSON results, the file-preview modal,
// the mermaid raw-source fallback) so clipboard-write + timed "Copied"
// feedback isn't reimplemented at each call site.
export default function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable or permission-denied — nothing sensible to
      // show beyond just not flipping into the "Copied" state.
    }
  }

  return (
    <button
      type="button"
      className={`${styles.copyButton} ${copied ? styles.copied : ''} ${className ?? ''}`}
      onClick={handleClick}
      title="Copy to clipboard"
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

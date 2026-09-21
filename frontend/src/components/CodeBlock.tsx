import { useState, type ReactNode } from 'react'
import styles from '../styles/Chat.module.css'

// Wraps a fenced (or indented) markdown code block — everything except
// ```mermaid, which Chat.tsx's `pre` override skips this for entirely so
// MermaidDiagram can render unwrapped. Shows the block's language in a
// header bar and lets the block itself be collapsed away, since a long
// JSON/code dump in a reply can otherwise dominate the whole message.
export default function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeBlockLang}>{language}</span>
        <button
          type="button"
          className={styles.codeBlockToggle}
          onClick={() => setCollapsed(c => !c)}
          aria-label={collapsed ? 'Expand code block' : 'Collapse code block'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && <pre className={styles.codeBlockPre}>{children}</pre>}
    </div>
  )
}

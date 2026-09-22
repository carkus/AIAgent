import { isValidElement, useState, type ReactNode } from 'react'
import styles from '../styles/Chat.module.css'
import CopyButton from './CopyButton'

// Pulls the literal text out of the rendered `<code>` children (react-markdown
// hands back an element tree, not a plain string) so the copy button copies
// what the block actually contains, not JSX.
function nodeToPlainText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToPlainText).join('')
  if (isValidElement(node)) return nodeToPlainText((node.props as { children?: ReactNode }).children)
  return ''
}

// Wraps a fenced (or indented) markdown code block — everything except
// ```mermaid, which Chat.tsx's `pre` override skips this for entirely so
// MermaidDiagram can render unwrapped. Shows the block's language in a
// header bar, lets the block itself be collapsed away (a long JSON/code
// dump in a reply can otherwise dominate the whole message), and offers a
// one-click copy of its raw content.
export default function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <button
          type="button"
          className={styles.codeBlockHeaderToggle}
          onClick={() => setCollapsed(c => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand code block' : 'Collapse code block'}
        >
          <span className={styles.codeBlockLang}>{language}</span>
          <span className={styles.codeBlockToggle} aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </button>
        <CopyButton text={nodeToPlainText(children)} className={styles.codeBlockCopy} />
      </div>
      {!collapsed && <pre className={styles.codeBlockPre}>{children}</pre>}
    </div>
  )
}

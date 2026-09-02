import jsPDF from 'jspdf'

/**
 * Text-based chat PDF export. Unlike a DOM screenshot, this draws real
 * vector text — selectable, searchable, and small — and reconstructs
 * hyperlinks as real clickable PDF link annotations. Visual styling
 * (bubble colors, borders, etc.) is intentionally NOT preserved; only
 * structure that affects reading (headings, lists, code, bold/italic,
 * links) survives.
 *
 * Assistant messages are markdown rendered by react-markdown in the chat
 * UI; rather than re-parsing the raw markdown string, this walks the
 * already-rendered DOM (`contentEl`, a ref to that message's `.markdown`
 * container) so link hrefs, list structure, and inline emphasis come
 * from the same parse react-markdown already did — one source of truth.
 */

export interface PdfMessage {
  role: 'user' | 'assistant'
  content: string
  /** Rendered markdown DOM for assistant messages; null/omitted for user messages (plain text). */
  contentEl?: HTMLElement | null
  toolCallCount?: number
  durationSeconds?: number
  usage?: { input_tokens: number; output_tokens: number }
}

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string }

type Block =
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'listitem'; ordered: boolean; index: number; runs: Run[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; runs: Run[] }
  | { kind: 'rule' }

// ---- DOM -> Block extraction (assistant markdown only) --------------------

interface InlineState {
  bold: boolean
  italic: boolean
  code: boolean
  href?: string
}

function walkInline(node: Node, state: InlineState, runs: Run[]) {
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent || ''
      if (text) runs.push({ text, bold: state.bold, italic: state.italic, code: state.code, href: state.href })
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const el = child as HTMLElement
    switch (el.tagName.toLowerCase()) {
      case 'br':
        runs.push({ text: '\n' })
        return
      case 'a':
        walkInline(el, { ...state, href: el.getAttribute('href') || undefined }, runs)
        return
      case 'strong':
      case 'b':
        walkInline(el, { ...state, bold: true }, runs)
        return
      case 'em':
      case 'i':
        walkInline(el, { ...state, italic: true }, runs)
        return
      case 'code':
        walkInline(el, { ...state, code: true }, runs)
        return
      default:
        walkInline(el, state, runs)
    }
  })
}

function inlineRuns(el: Element): Run[] {
  const runs: Run[] = []
  walkInline(el, { bold: false, italic: false, code: false }, runs)
  return runs
}

function extractBlocks(root: HTMLElement): Block[] {
  const blocks: Block[] = []
  root.childNodes.forEach(node => {
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()

    if (/^h[1-6]$/.test(tag)) {
      blocks.push({ kind: 'heading', level: Number(tag[1]), runs: inlineRuns(el) })
    } else if (tag === 'p') {
      blocks.push({ kind: 'paragraph', runs: inlineRuns(el) })
    } else if (tag === 'ul' || tag === 'ol') {
      const ordered = tag === 'ol'
      Array.from(el.children).forEach((li, i) => {
        blocks.push({ kind: 'listitem', ordered, index: i + 1, runs: inlineRuns(li) })
      })
    } else if (tag === 'pre') {
      blocks.push({ kind: 'code', text: el.textContent || '' })
    } else if (tag === 'blockquote') {
      blocks.push({ kind: 'quote', runs: inlineRuns(el) })
    } else if (tag === 'hr') {
      blocks.push({ kind: 'rule' })
    } else if (tag === 'table') {
      Array.from(el.querySelectorAll('tr')).forEach(tr => {
        const cells = Array.from(tr.children).map(td => (td.textContent || '').trim())
        blocks.push({ kind: 'paragraph', runs: [{ text: cells.join('   |   ') }] })
      })
    } else {
      blocks.push({ kind: 'paragraph', runs: inlineRuns(el) })
    }
  })
  return blocks
}

// ---- PDF layout / drawing --------------------------------------------------

const FONT_BODY = 'helvetica'
const FONT_CODE = 'courier'
const LINK_COLOR: [number, number, number] = [37, 99, 235]
const TEXT_COLOR: [number, number, number] = [20, 20, 20]
const META_COLOR: [number, number, number] = [120, 120, 120]
const LABEL_COLOR_USER: [number, number, number] = [79, 110, 247]
const LABEL_COLOR_ASSISTANT: [number, number, number] = [16, 130, 100]

const PAGE_MARGIN = 48
const HEADING_SIZE: Record<number, number> = { 1: 16, 2: 14, 3: 12.5, 4: 11.5, 5: 11, 6: 11 }
const BODY_SIZE = 10.5
const CODE_SIZE = 9
const META_SIZE = 8.5
const LABEL_SIZE = 10.5

interface Cursor {
  y: number
}

class PdfLayout {
  pdf: jsPDF
  pageWidth: number
  pageHeight: number
  contentWidth: number
  bottomLimit: number
  cursor: Cursor

  constructor() {
    this.pdf = new jsPDF({ unit: 'pt', format: 'a4' })
    this.pageWidth = this.pdf.internal.pageSize.getWidth()
    this.pageHeight = this.pdf.internal.pageSize.getHeight()
    this.contentWidth = this.pageWidth - PAGE_MARGIN * 2
    this.bottomLimit = this.pageHeight - PAGE_MARGIN
    this.cursor = { y: PAGE_MARGIN }
  }

  private newPage() {
    this.pdf.addPage()
    this.cursor.y = PAGE_MARGIN
  }

  /** Reserve vertical space, breaking to a new page first if it won't fit. */
  ensureRoom(height: number) {
    if (this.cursor.y + height > this.bottomLimit) this.newPage()
  }

  gap(height: number) {
    this.cursor.y += height
  }

  rule() {
    this.ensureRoom(10)
    this.pdf.setDrawColor(200, 200, 200)
    this.pdf.setLineWidth(0.75)
    this.pdf.line(PAGE_MARGIN, this.cursor.y, this.pageWidth - PAGE_MARGIN, this.cursor.y)
    this.cursor.y += 12
  }

  label(text: string, color: [number, number, number]) {
    this.ensureRoom(LABEL_SIZE * 1.6)
    this.pdf.setFont(FONT_BODY, 'bold')
    this.pdf.setFontSize(LABEL_SIZE)
    this.pdf.setTextColor(...color)
    this.cursor.y += LABEL_SIZE
    this.pdf.text(text, PAGE_MARGIN, this.cursor.y)
    this.cursor.y += 4
  }

  meta(text: string) {
    this.ensureRoom(META_SIZE * 1.6)
    this.pdf.setFont(FONT_BODY, 'normal')
    this.pdf.setFontSize(META_SIZE)
    this.pdf.setTextColor(...META_COLOR)
    this.cursor.y += META_SIZE
    this.pdf.text(text, PAGE_MARGIN, this.cursor.y)
    this.cursor.y += 6
  }

  plainText(text: string, x: number, width: number, fontSize: number) {
    this.pdf.setFont(FONT_BODY, 'normal')
    this.pdf.setFontSize(fontSize)
    this.pdf.setTextColor(...TEXT_COLOR)
    const lines: string[] = this.pdf.splitTextToSize(text, width)
    const lineHeight = fontSize * 1.4
    for (const line of lines) {
      this.ensureRoom(lineHeight)
      this.cursor.y += lineHeight
      this.pdf.text(line, x, this.cursor.y)
    }
    this.cursor.y += 6
  }

  code(text: string) {
    const x = PAGE_MARGIN + 10
    const width = this.contentWidth - 10
    this.pdf.setFont(FONT_CODE, 'normal')
    this.pdf.setFontSize(CODE_SIZE)
    this.pdf.setTextColor(...TEXT_COLOR)
    const lineHeight = CODE_SIZE * 1.4
    const rawLines = text.split('\n')
    for (const raw of rawLines) {
      const wrapped: string[] = raw ? this.pdf.splitTextToSize(raw, width) : ['']
      for (const line of wrapped) {
        this.ensureRoom(lineHeight)
        this.cursor.y += lineHeight
        this.pdf.text(line, x, this.cursor.y)
      }
    }
    this.cursor.y += 8
  }

  /** Word-wraps mixed-style runs (bold/italic/code/href) into lines, drawing real link annotations. */
  richText(runs: Run[], opts: { x: number; width: number; fontSize: number; prefix?: string }) {
    const { x, width, fontSize } = opts
    const lineHeight = fontSize * 1.42
    let cx = x
    let firstLineOfBlock = true

    if (opts.prefix) {
      this.ensureRoom(lineHeight)
      this.cursor.y += lineHeight
      this.pdf.setFont(FONT_BODY, 'bold')
      this.pdf.setFontSize(fontSize)
      this.pdf.setTextColor(...TEXT_COLOR)
      this.pdf.text(opts.prefix, PAGE_MARGIN, this.cursor.y)
      firstLineOfBlock = false
    }

    const advanceLine = () => {
      this.ensureRoom(lineHeight)
      this.cursor.y += lineHeight
      cx = x
    }

    if (firstLineOfBlock) advanceLine()

    for (const tok of tokenize(runs)) {
      if (tok.isBreak) {
        advanceLine()
        continue
      }
      const style = tok.bold && tok.italic ? 'bolditalic' : tok.bold ? 'bold' : tok.italic ? 'italic' : 'normal'
      this.pdf.setFont(tok.code ? FONT_CODE : FONT_BODY, tok.code ? 'normal' : style)
      this.pdf.setFontSize(fontSize)
      const w = this.pdf.getTextWidth(tok.text)

      if (tok.isSpace) {
        if (cx > x) cx += w
        continue
      }

      if (cx + w > x + width && cx > x) advanceLine()

      if (tok.href) {
        this.pdf.setTextColor(...LINK_COLOR)
        this.pdf.textWithLink(tok.text, cx, this.cursor.y, { url: tok.href })
        this.pdf.setDrawColor(...LINK_COLOR)
        this.pdf.setLineWidth(0.5)
        this.pdf.line(cx, this.cursor.y + 1.5, cx + w, this.cursor.y + 1.5)
      } else {
        this.pdf.setTextColor(...TEXT_COLOR)
        this.pdf.text(tok.text, cx, this.cursor.y)
      }
      cx += w
    }

    this.cursor.y += 6
  }
}

interface Token { text: string; href?: string; bold?: boolean; italic?: boolean; code?: boolean; isSpace?: boolean; isBreak?: boolean }

function tokenize(runs: Run[]): Token[] {
  const tokens: Token[] = []
  for (const run of runs) {
    if (run.text === '\n') {
      tokens.push({ text: '', isBreak: true })
      continue
    }
    // Split on whitespace but keep the whitespace as its own token (capturing
    // group) so exact spacing/adjacency from the source DOM is preserved —
    // e.g. "here!" right after a link stays glued, not "here !".
    for (const part of run.text.split(/(\s+)/)) {
      if (part === '') continue
      tokens.push({
        text: part,
        href: run.href,
        bold: run.bold,
        italic: run.italic,
        code: run.code,
        isSpace: /^\s+$/.test(part),
      })
    }
  }
  return tokens
}

function drawBlock(layout: PdfLayout, block: Block) {
  switch (block.kind) {
    case 'heading':
      layout.richText(block.runs, { x: PAGE_MARGIN, width: layout.contentWidth, fontSize: HEADING_SIZE[block.level] ?? 11 })
      break
    case 'paragraph':
      if (block.runs.length) layout.richText(block.runs, { x: PAGE_MARGIN, width: layout.contentWidth, fontSize: BODY_SIZE })
      break
    case 'listitem': {
      const indent = 16
      const prefix = block.ordered ? `${block.index}.` : '•'
      layout.richText(block.runs, { x: PAGE_MARGIN + indent, width: layout.contentWidth - indent, fontSize: BODY_SIZE, prefix })
      break
    }
    case 'quote':
      layout.richText(block.runs, { x: PAGE_MARGIN + 14, width: layout.contentWidth - 14, fontSize: BODY_SIZE })
      break
    case 'code':
      layout.code(block.text)
      break
    case 'rule':
      layout.rule()
      break
  }
}

function formatMeta(msg: PdfMessage): string | null {
  const parts: string[] = []
  if (msg.toolCallCount) parts.push(`${msg.toolCallCount} tool call${msg.toolCallCount !== 1 ? 's' : ''}`)
  if (msg.durationSeconds !== undefined) parts.push(`${msg.durationSeconds}s`)
  if (msg.usage) parts.push(`${(msg.usage.input_tokens + msg.usage.output_tokens).toLocaleString()} tokens`)
  return parts.length ? parts.join(' · ') : null
}

/** Builds the chat PDF and returns the jsPDF document without saving it (for preview-before-download). */
export function buildChatPdf(title: string, messages: PdfMessage[]): jsPDF {
  const layout = new PdfLayout()

  layout.pdf.setFont(FONT_BODY, 'bold')
  layout.pdf.setFontSize(15)
  layout.pdf.setTextColor(...TEXT_COLOR)
  layout.cursor.y += 15
  layout.pdf.text(title, PAGE_MARGIN, layout.cursor.y)
  layout.meta(`Exported ${new Date().toLocaleString()}`)
  layout.rule()

  for (const msg of messages) {
    if (msg.role === 'user') {
      layout.label('You', LABEL_COLOR_USER)
      layout.plainText(msg.content, PAGE_MARGIN, layout.contentWidth, BODY_SIZE)
    } else {
      layout.label('Assistant', LABEL_COLOR_ASSISTANT)
      const blocks = msg.contentEl ? extractBlocks(msg.contentEl) : []
      if (blocks.length) {
        for (const block of blocks) drawBlock(layout, block)
      } else if (msg.content) {
        layout.plainText(msg.content, PAGE_MARGIN, layout.contentWidth, BODY_SIZE)
      }
      const metaText = formatMeta(msg)
      if (metaText) layout.meta(metaText)
    }
    layout.gap(8)
  }

  return layout.pdf
}

// Turns a relic's text content (backend/src/relic.py) into the file the user
// downloads, and the parsed shapes RelicPreviewModal shows before that.
// docx and pptxgenjs are large, so they load only when that kind is
// downloaded.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { buildReportPdf } from './chatPdf'
import { renderMermaidSvg } from './components/MermaidDiagram'
import type { Relic, RelicKind } from './types'

export const RELIC_LABELS: Record<RelicKind, string> = {
  csv: 'Spreadsheet (CSV)',
  json: 'Data (JSON)',
  chart: 'Chart (PNG)',
  diagram: 'Diagram (SVG)',
  markdown: 'Markdown document',
  docx: 'Word document',
  pdf: 'PDF report',
  slides: 'Slide deck',
}

// Export menu order.
export const RELIC_KINDS = Object.keys(RELIC_LABELS) as RelicKind[]

const EXTENSIONS: Record<RelicKind, string> = {
  csv: 'csv', json: 'json', chart: 'png', diagram: 'svg',
  markdown: 'md', docx: 'docx', pdf: 'pdf', slides: 'pptx',
}

export function relicFilename(relic: Relic, agentName: string): string {
  const safeName = agentName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'agent'
  const stamp = relic.createdAt.slice(0, 19).replace(/[:T]/g, '-')
  return `${safeName}-${relic.kind}-${stamp}.${EXTENSIONS[relic.kind]}`
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// RFC 4180-style parse: quoted fields may hold commas, newlines and "" escapes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim())) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f.trim())) rows.push(row)
  return rows
}

export interface SlideDeck {
  title: string
  subtitle?: string
  slides: { title: string; bullets: string[]; notes?: string }[]
}

export function parseSlides(content: string): SlideDeck {
  const data = JSON.parse(content) as Partial<SlideDeck>
  return {
    title: String(data.title ?? 'Slides'),
    subtitle: data.subtitle ? String(data.subtitle) : undefined,
    slides: (data.slides ?? []).map(s => ({
      title: String(s.title ?? ''),
      bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : [],
      notes: s.notes ? String(s.notes) : undefined,
    })),
  }
}

// Rendered markdown as a detached element, with the document's own `# title`
// pulled out so the PDF/Word title isn't followed by a duplicate heading.
function markdownDocument(content: string, fallbackTitle: string): { title: string; el: HTMLDivElement } {
  const el = document.createElement('div')
  el.innerHTML = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, content))
  const h1 = el.querySelector('h1')
  const title = h1?.textContent?.trim() || fallbackTitle
  h1?.remove()
  return { title, el }
}

export function buildRelicPdf(content: string, fallbackTitle: string) {
  const { title, el } = markdownDocument(content, fallbackTitle)
  return buildReportPdf(title, el)
}

async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const width = parseFloat(root.getAttribute('width') ?? '') || 1200
  const height = parseFloat(root.getAttribute('height') ?? '') || 800
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Could not draw the chart as an image'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width * scale)
  canvas.height = Math.ceil(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not draw the chart as an image')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not draw the chart as an image'))), 'image/png'))
}

async function buildDocx(content: string, fallbackTitle: string): Promise<Blob> {
  const d = await import('docx')
  const { title, el } = markdownDocument(content, fallbackTitle)

  type RunFormat = { bold?: boolean; italics?: boolean; code?: boolean; link?: boolean }
  const runs = (node: Node, fmt: RunFormat = {}): InstanceType<typeof d.TextRun>[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      return text ? [new d.TextRun({
        text,
        bold: fmt.bold,
        italics: fmt.italics,
        font: fmt.code ? 'Consolas' : undefined,
        color: fmt.link ? '1F6F73' : undefined,
        underline: fmt.link ? {} : undefined,
      })] : []
    }
    if (!(node instanceof HTMLElement)) return []
    const tag = node.tagName.toLowerCase()
    if (tag === 'br') return [new d.TextRun({ text: '', break: 1 })]
    if (tag === 'ul' || tag === 'ol') return []
    const next: RunFormat = {
      ...fmt,
      bold: fmt.bold || tag === 'strong' || tag === 'b' || tag === 'th',
      italics: fmt.italics || tag === 'em' || tag === 'i',
      code: fmt.code || tag === 'code',
      link: fmt.link || tag === 'a',
    }
    return Array.from(node.childNodes).flatMap(child => runs(child, next))
  }

  const blocks: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = []
  const list = (listEl: Element, level: number) => {
    const ordered = listEl.tagName.toLowerCase() === 'ol'
    Array.from(listEl.children).forEach((li, n) => {
      const prefix = ordered ? [new d.TextRun(`${n + 1}. `)] : []
      blocks.push(new d.Paragraph({
        children: [...prefix, ...runs(li)],
        ...(ordered ? { indent: { left: 360 * (level + 1) } } : { bullet: { level } }),
      }))
      li.querySelectorAll(':scope > ul, :scope > ol').forEach(sub => list(sub, level + 1))
    })
  }
  const headings: Record<string, (typeof d.HeadingLevel)[keyof typeof d.HeadingLevel]> = {
    h2: d.HeadingLevel.HEADING_1,
    h3: d.HeadingLevel.HEADING_2,
  }

  blocks.push(new d.Paragraph({ text: title, heading: d.HeadingLevel.TITLE }))
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase()
    if (tag === 'ul' || tag === 'ol') list(child, 0)
    else if (tag === 'table') {
      blocks.push(new d.Table({
        width: { size: 100, type: d.WidthType.PERCENTAGE },
        rows: Array.from(child.querySelectorAll('tr')).map(tr => new d.TableRow({
          children: Array.from(tr.children).map(cell => new d.TableCell({
            children: [new d.Paragraph({ children: runs(cell) })],
          })),
        })),
      }))
      blocks.push(new d.Paragraph({ text: '' }))
    } else if (tag === 'hr') blocks.push(new d.Paragraph({ text: '' }))
    else if (tag === 'pre') blocks.push(new d.Paragraph({ children: runs(child, { code: true }) }))
    else if (tag === 'blockquote') blocks.push(new d.Paragraph({ children: runs(child, { italics: true }), indent: { left: 720 } }))
    else blocks.push(new d.Paragraph({
      children: runs(child),
      heading: headings[tag] ?? (/^h[4-6]$/.test(tag) ? d.HeadingLevel.HEADING_3 : undefined),
    }))
  }

  const doc = new d.Document({ creator: 'Agent One', title, sections: [{ children: blocks }] })
  return d.Packer.toBlob(doc)
}

async function buildPptx(content: string): Promise<Blob> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const deck = parseSlides(content)
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = deck.title
  const text = { fontFace: 'Calibri', color: '33475A' }

  const cover = pptx.addSlide()
  cover.addText(deck.title, { ...text, x: 0.6, y: 2.4, w: 12.1, h: 1.2, fontSize: 36, bold: true, color: '16324A' })
  if (deck.subtitle) cover.addText(deck.subtitle, { ...text, x: 0.6, y: 3.6, w: 12.1, h: 0.8, fontSize: 18, color: '6B7785' })

  for (const s of deck.slides) {
    const slide = pptx.addSlide()
    slide.addText(s.title, { ...text, x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontSize: 28, bold: true, color: '16324A' })
    if (s.bullets.length) {
      slide.addText(
        s.bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true } })),
        { ...text, x: 0.8, y: 1.5, w: 11.7, h: 5.4, fontSize: 18, valign: 'top', paraSpaceAfter: 8 },
      )
    }
    if (s.notes) slide.addNotes(s.notes)
  }
  return (await pptx.write({ outputType: 'blob' })) as Blob
}

export async function downloadRelic(relic: Relic, agentName: string): Promise<void> {
  const filename = relicFilename(relic, agentName)
  const fallbackTitle = `Agent ${agentName} report`
  const { kind, content } = relic
  if (kind === 'csv') downloadBlob(new Blob([content], { type: 'text/csv;charset=utf-8' }), filename)
  else if (kind === 'json') downloadBlob(new Blob([content], { type: 'application/json' }), filename)
  else if (kind === 'markdown') downloadBlob(new Blob([content], { type: 'text/markdown;charset=utf-8' }), filename)
  else if (kind === 'diagram') downloadBlob(new Blob([await renderMermaidSvg(content)], { type: 'image/svg+xml' }), filename)
  else if (kind === 'chart') downloadBlob(await svgToPng(await renderMermaidSvg(content)), filename)
  else if (kind === 'pdf') buildRelicPdf(content, fallbackTitle).save(filename)
  else if (kind === 'docx') downloadBlob(await buildDocx(content, fallbackTitle), filename)
  else downloadBlob(await buildPptx(content), filename)
}

// Lenient on purpose (trailing whitespace after the fence marker, CRLF,
// casing, trailing blank lines before the closing fence) — an earlier,
// strict ```mermaid\n version silently failed to match real model output
// whose fence didn't line up exactly, which left every diagram unrendered
// instead of just falling back to a plain code block.
const MERMAID_FENCE_RE = /```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi

// Pulls every ```mermaid fence out of a reply's prose so it can be rendered
// as its own dedicated diagram block instead of sitting inline mid-paragraph
// inside the flowing markdown. Shared by Chat.tsx (the main agent's own
// reply) and ToolActivity.tsx's WorkerResultCard (a delegated worker's
// reply) — a worker gets the same "prefer a diagram" system-prompt rules as
// the main agent, so its response can contain a fence too.
export function extractMermaidDiagrams(content: string): { text: string; diagrams: string[] } {
  const diagrams: string[] = []
  const text = content.replace(MERMAID_FENCE_RE, (_match, chart: string) => {
    diagrams.push(chart.trim())
    return ''
  })
  return { text, diagrams }
}

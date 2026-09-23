// LLM replies sometimes run a numbered list inline as prose instead of one
// item per line, e.g. "...gather info: 1. **A**: text 2. **B**: text" — with
// no line break before each marker, remark-gfm has no way to see these as
// list items, so the whole run renders as a single flat paragraph. Inserting
// a line break before each inline "N. " marker that follows sentence-ending
// punctuation lets remark-gfm parse the run as a real ordered list instead.
export function normalizeInlineOrderedLists(text: string): string {
  return text.replace(/([:.!?])[ \t]+(\d{1,2}\.[ \t]+)/g, (_match, punct: string, marker: string) => `${punct}\n${marker}`)
}

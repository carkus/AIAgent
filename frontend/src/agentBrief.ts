// Shared by Setup.tsx (the live pre-commission Brief preview) and
// CharacterGenerator.tsx (the "Open Agent Files" dossier, to aid picking
// between generated characters before "Employ Agent" loads one into Setup) —
// both need the same deterministic, no-LLM-call brief text from a set of
// agent params, just fed different sources for those params (typed
// keywords/location vs. a generated character's specialties).
import type { AgentTemplateId } from './types'

export function joinNatural(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// Same-turn fallback while the AI-drafted brief (backend/src/brief.py) is
// loading or has failed — must still mention active behaviors/traits, not
// just the specialty keywords, since those change what the agent will
// actually do just as much as a specialty does (see brief.py's own note).
export function buildAgentBrief(agentType: AgentTemplateId, keywords: string[], loc: string, agentName: string, behaviors: string[] = [], traits: string[] = []): string {
  const topics = joinNatural(keywords)
  const beat = loc ? ` in ${loc}` : ''
  const name = `Agent ${agentName}`
  const extras = [...behaviors, ...traits]
  const extrasClause = extras.length > 0 ? ` It will do this with ${joinNatural(extras)} behavior active.` : ''
  switch (agentType) {
    case 'research':
      return `${name} will research and analyze ${topics}${beat}. If commissioned, it will search, cross-reference sources, and report back with findings and key data points.${extrasClause}`
    case 'job_search':
      return `${name} will find roles in ${topics}${beat}. If commissioned, it will search listings, screen them against your criteria, and report back the strongest matches.${extrasClause}`
    default:
      return `${name} will track ${topics}${beat}. If commissioned, it will monitor developments and report back on what's most relevant.${extrasClause}`
  }
}

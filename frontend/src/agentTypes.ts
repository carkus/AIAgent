// Agent type templates + personality trait pools — shared by Setup.tsx (the
// real Setup form), Chat.tsx (rendering a saved/active agent's config), and
// characterData.ts (the Agent Generator, which needs to pick a real
// AgentTemplateId + real trait ids so a generated character's type and
// personality actually carry through into Setup when "Employed", not just
// its cosmetic name). Lives outside components/ so characterData.ts can
// import it without a circular components/Setup.tsx <-> CharacterGenerator
// dependency.
import type { AgentTemplateId } from './types'

// Each template controls both the purpose text sent to bootstrap (which
// determines what tools/behaviour Claude designs) and what the keyword
// chips mean in that context. `search_jobs` (live Adzuna listings) and
// `fetch_page` (general web fetch) are the two built-in primitives every
// agent gets — see backend/src/agent_stream.py — so "Job search" leans on
// the former, "Research" the latter, and "General" leaves it up to bootstrap.
export interface AgentTemplate {
  id: AgentTemplateId
  label: string
  keywordPlaceholder: string
  buildPurpose: (keywords: string[], location: string) => string
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'general',
    label: 'General assistant',
    keywordPlaceholder: 'Type a topic, press Enter…',
    buildPurpose: (keywords, loc) =>
      `General-purpose assistant covering the following topics: ${keywords.join(', ')}` +
      `${loc ? ` (relevant to ${loc})` : ''}. ` +
      `Give general, well-rounded information about each topic — what it is, ` +
      `why it matters, and the key facts a newcomer would want to know — ` +
      `rather than a deep or narrowly-angled investigation.`,
  },
  {
    id: 'research',
    label: 'Researcher',
    keywordPlaceholder: 'Buid your agent.',
    buildPurpose: (keywords, loc) =>
      `Research agent for the following keywords: ${keywords.join(', ')}` +
      `${loc ? ` in ${loc}` : ''}. ` +
      `Focus specifically on recent changes and developments in the industry, ` +
      `research or work being done at universities, and new or emerging technology, ` +
      `for each keyword. Analyse patterns and trends within that scope, ` +
      `and present clear findings for each keyword.`,
  },
  {
    id: 'job_search',
    label: 'Job search',
    keywordPlaceholder: 'Type a job title or skill, press Enter…',
    buildPurpose: (keywords, loc) =>
      `Job search agent for the following roles or skills: ${keywords.join(', ')}` +
      `${loc ? ` in ${loc}` : ''}. ` +
      `Search live job listings, compare requirements and salary across postings, ` +
      `and present clear, ranked findings for each role or skill.`,
  },
]

export function getTemplate(id: AgentTemplateId | undefined): AgentTemplate {
  return AGENT_TEMPLATES.find(t => t.id === id) ?? AGENT_TEMPLATES[0]
}

export interface PersonalityTrait {
  id: string
  label: string
  // Appended verbatim to the bootstrap purpose string when selected — same
  // compounding shape as BehaviorToggle.instruction in Setup.tsx, so a
  // chosen trait actually shapes the agent instead of being cosmetic flavor.
  instruction: string
}

// Every `instruction` above is written as "Adopt a(n) <trait> personality: <effect>.",
// with <effect> phrased as a bare verb clause (e.g. "keep pulling on…", "double-check
// details…") so it reads correctly after "a tendency to". Reworded in plain,
// user-facing terms instead of showing the raw bootstrap-facing imperative text.
// Used by Setup's personality summary line only, never sent to bootstrap itself.
export function describeTraitEffect(trait: PersonalityTrait): string {
  const colonIdx = trait.instruction.indexOf(':')
  const effect = (colonIdx >= 0 ? trait.instruction.slice(colonIdx + 1) : trait.instruction).trim()
  return `The agent has demonstrated a tendency to ${effect}`
}

// Personality traits the user picks per agent, scoped by agent type so the
// pool stays relevant (a job-search agent doesn't need "Curious"). Unlike
// the old auto-picked flavor traits this replaces, nothing here is chosen
// for the user — an agent has no personality trait unless one is selected.
export const PERSONALITY_TRAITS: Record<AgentTemplateId, PersonalityTrait[]> = {
  research: [
    { id: 'inquisitive', label: 'Inquisitive', instruction: 'Adopt an inquisitive personality: keep pulling on follow-up angles and related questions the user did not explicitly ask for, instead of stopping at the literal specialty.' },
    { id: 'meticulous', label: 'Meticulous', instruction: 'Adopt a meticulous personality: double-check details, flag caveats and uncertainty explicitly, and never overstate how confident a finding is.' },
    { id: 'analytical', label: 'Analytical', instruction: 'Adopt an analytical personality: structure findings as comparisons, patterns, and trends rather than a flat narrative summary.' },
    { id: 'methodical', label: 'Methodical', instruction: 'Adopt a methodical personality: work through each specialty in clear, deliberate order and show the reasoning steps behind a conclusion, not just the conclusion.' },
    { id: 'curious', label: 'Curious', instruction: 'Adopt a curious personality: call out surprising or noteworthy findings with genuine interest, rather than reporting everything in the same flat tone.' },
  ],
  job_search: [
    { id: 'persistent', label: 'Persistent', instruction: 'Adopt a persistent personality: keep searching across more listings and phrasing variations before concluding nothing suitable exists.' },
    { id: 'sharp-eyed', label: 'Sharp-eyed', instruction: 'Adopt a sharp-eyed personality: actively flag red flags, mismatches, or unusual terms buried in a listing rather than only reporting the headline fit.' },
    { id: 'resourceful', label: 'Resourceful', instruction: 'Adopt a resourceful personality: try adjacent titles, skills, or locations before giving up whenever a search comes up short.' },
    { id: 'diligent', label: 'Diligent', instruction: 'Adopt a diligent personality: verify each listing’s requirements against the stated criteria point by point instead of skimming.' },
    { id: 'discerning', label: 'Discerning', instruction: 'Adopt a discerning personality: rank and filter listings critically, and say plainly when a match is weak rather than padding out the results.' },
  ],
  general: [
    { id: 'adaptable', label: 'Adaptable', instruction: 'Adopt an adaptable personality: shift depth and approach to fit each topic rather than applying one fixed format to all of them.' },
    { id: 'practical', label: 'Practical', instruction: 'Adopt a practical personality: favor concrete, actionable takeaways over abstract discussion.' },
    { id: 'attentive', label: 'Attentive', instruction: 'Adopt an attentive personality: track small details across topics and call back to them when relevant instead of treating each one in isolation.' },
    { id: 'versatile', label: 'Versatile', instruction: 'Adopt a versatile personality: draw connections across the different topics covered rather than reporting on each in a silo.' },
    { id: 'observant', label: 'Observant', instruction: 'Adopt an observant personality: note what has changed since anything already discussed, and highlight what is genuinely new.' },
  ],
}

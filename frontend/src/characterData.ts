// Data pools + generator for the standalone Character Generator screen
// (see components/CharacterGenerator.tsx). Purely client-side and free —
// no bootstrap/LLM call involved, so it's safe to mash "Generate" as many
// times as you like, both for quick internal testing of the dossier/stamp
// visual language and as a possible standalone marketing gimmick on its
// own link. Reuses SURNAMES (already used for "Agent <Surname>" naming)
// for the surname half of the name, paired with a vintage first-name pool
// and a noir callsign for extra flavor.
import { SURNAMES } from './surnames'
import { AGENT_TEMPLATES, PERSONALITY_TRAITS, BEHAVIOR_TOGGLES, SPECIALTY_SAMPLES } from './agentTypes'
import type { AgentTemplateId } from './types'

const FIRST_NAMES = [
  'Eleanor', 'Marcus', 'Vivian', 'Desmond', 'Odette', 'Roland', 'Thea', 'Gideon',
  'Imogen', 'Silas', 'Bertram', 'Wren', 'Alistair', 'Mireille', 'Otto', 'Josephine',
  'Leopold', 'Adelina', 'Frasier', 'Cordelia', 'Ambrose', 'Perpetua', 'Nikolai',
  'Beatrix', 'Emeric', 'Solveig', 'Tobias', 'Rosalind', 'Edmund', 'Constance',
]

const CALLSIGN_ADJECTIVES = [
  'Silver', 'Iron', 'Quiet', 'Crimson', 'Hollow', 'Northern', 'Velvet', 'Amber',
  'Grey', 'Last', 'Broken', 'Winter', 'Copper', 'Pale', 'Steel',
]

const CALLSIGN_NOUNS = [
  'Fox', 'Heron', 'Wolf', 'Compass', 'Lantern', 'Raven', 'Anchor', 'Hawk',
  'Ledger', 'Cipher', 'Magpie', 'Sparrow', 'Falcon', 'Vulture', 'Owl',
]

const ROLES = [
  'Deep-Cover Operative', 'Signals Analyst', 'Field Recruiter', 'Document Forger',
  'Courier Handler', 'Surveillance Chief', 'Cryptanalyst', 'Liaison Officer',
  'Interrogation Specialist', 'Logistics Coordinator', 'Counter-Intelligence Officer',
  'Wireless Operator', 'Safehouse Keeper', 'Dead-Drop Runner',
]

const BUREAUS = [
  'Bureau of Applied Inquiry', '7th Division', 'Overseas Registry',
  'Central Filing Office', 'Section Nine', 'Joint Records Office',
  'Northern Field Office', 'Special Correspondence Unit',
  'Office of Unlisted Affairs', 'Third Registry',
]

const TAGLINES = [
  'Never files a report the same way twice.',
  'Trusts nobody, remembers everybody.',
  'Has a cover story for every day of the week.',
  'Keeps three passports and one real name.',
  'Reads a room before it’s finished being built.',
  'Owes a favor to exactly the wrong people.',
  'Once talked a border guard into apologizing.',
  'Files everything. Forgets nothing. Forgives less.',
  'Has never once been where the paperwork says.',
  'Speaks four languages and trusts none of them.',
]

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
]

export interface Character {
  firstName: string
  surname: string
  callsign: string
  // Real agent type + personality trait ids (from agentTypes.ts, the same
  // pools Setup.tsx's own Type/Personality controls use) — not just cosmetic
  // dossier flavor, so "Employ Agent" can actually set Setup's Agent Type
  // and Personality selections to match instead of only the display name.
  agentType: AgentTemplateId
  role: string
  bureau: string
  traitIds: string[]
  traits: string[]
  // Behavior toggle ids + display labels (agentTypes.ts's BEHAVIOR_TOGGLES,
  // one flat pool shared by every agent type, unlike traits above) — same
  // "real id so Employ Agent can actually apply it in Setup" treatment.
  behaviorIds: string[]
  behaviors: string[]
  // Sampled from SPECIALTY_SAMPLES (agentTypes.ts) — same "real value so
  // Employ Agent can actually apply it in Setup" treatment as traitIds/
  // behaviorIds above; these land in Setup's specialty chips, not just the
  // dossier card, and stay fully editable there afterward.
  specialties: string[]
  tagline: string
  idNumber: string
  issued: string
}

function pick<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]
}

// Sampling without replacement so the same trait never appears twice on one card.
function pickMany<T>(pool: T[], count: number): T[] {
  const copy = [...pool]
  const result: T[] = []
  for (let i = 0; i < count && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length)
    result.push(copy[idx])
    copy.splice(idx, 1)
  }
  return result
}

function randomIdNumber(): string {
  const letters = () => String.fromCharCode(65 + Math.floor(Math.random() * 26))
  const digits = Math.floor(1000 + Math.random() * 9000)
  return `${letters()}${letters()}-${digits}-${letters()}`
}

function randomIssueDate(): string {
  const day = 1 + Math.floor(Math.random() * 28)
  const month = pick(MONTHS)
  const year = 1946 + Math.floor(Math.random() * 21)
  return `${day} ${month} ${year}`
}

// `forcedType` ties the card to whatever agent type is actually selected in
// Setup right now, so the traits shown are the real, currently-relevant
// personality pool rather than a random type's — falls back to a random
// pick only when no type is supplied (there isn't one outside Setup's context).
export function generateCharacter(forcedType?: AgentTemplateId): Character {
  const agentType = forcedType ?? pick(AGENT_TEMPLATES).id
  const traitPool = PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research
  const chosenTraits = pickMany(traitPool, Math.min(3, traitPool.length))
  const chosenBehaviors = pickMany(BEHAVIOR_TOGGLES, Math.min(2, BEHAVIOR_TOGGLES.length))
  const specialtyPool = SPECIALTY_SAMPLES[agentType] ?? SPECIALTY_SAMPLES.research
  const chosenSpecialties = pickMany(specialtyPool, Math.min(3, specialtyPool.length))
  return {
    firstName: pick(FIRST_NAMES),
    surname: pick(SURNAMES),
    callsign: `${pick(CALLSIGN_ADJECTIVES)} ${pick(CALLSIGN_NOUNS)}`,
    agentType,
    role: pick(ROLES),
    bureau: pick(BUREAUS),
    traitIds: chosenTraits.map(t => t.id),
    traits: chosenTraits.map(t => t.label.toUpperCase()),
    behaviorIds: chosenBehaviors.map(t => t.id),
    behaviors: chosenBehaviors.map(t => t.label.toUpperCase()),
    specialties: chosenSpecialties,
    tagline: pick(TAGLINES),
    idNumber: randomIdNumber(),
    issued: randomIssueDate(),
  }
}

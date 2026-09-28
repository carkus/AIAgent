import type { SavedChat } from './types'

// Client-side chat persistence. The backend is stateless (CLAUDE.md limitation
// #3: full history always travels with every /agent request), so "saving a
// chat" just means keeping a snapshot of agentConfig + agentName + messages
// around in localStorage — same idiom as Setup.tsx's `aiagent_saved_searches`.
const STORAGE_KEY = 'aiagent_saved_chats'

export function loadSavedChats(): SavedChat[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function writeSavedChats(chats: SavedChat[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chats))
}

// Upserts by id, most-recently-saved first, so re-saving the same
// conversation (e.g. after sending a few more messages) updates its existing
// entry instead of piling up duplicates.
export function saveChat(chat: SavedChat): SavedChat[] {
  const rest = loadSavedChats().filter(c => c.id !== chat.id)
  const updated = [chat, ...rest]
  writeSavedChats(updated)
  return updated
}

export function deleteSavedChat(id: string): SavedChat[] {
  const updated = loadSavedChats().filter(c => c.id !== id)
  writeSavedChats(updated)
  return updated
}

// "Hiding" a chat only affects what the dossier list renders — the entry
// stays in `aiagent_saved_chats` untouched, so it isn't lost, just tucked
// out of view (distinct from deleteSavedChat, which is a real delete).
const HIDDEN_KEY = 'aiagent_hidden_chats'

export function loadHiddenChatIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function hideSavedChat(id: string): string[] {
  const updated = [...new Set([...loadHiddenChatIds(), id])]
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(updated))
  return updated
}

// Remembers which chat/agent was last open so a page reload can drop the
// user straight back into it instead of the splash/setup screen — but only
// a *pointer* (kind + id), never a full snapshot, so "still exist" means
// something: App.tsx re-checks the pointer against the live source (saved
// chats in localStorage, or the published-agent registry on the backend)
// on every load rather than trusting a possibly-stale cached copy. A saved
// chat that's since been deleted, or a published agent that's since been
// unpublished, correctly fails that check and falls back to a fresh start.
export type LastOpenedPointer =
  | { kind: 'savedChat'; id: string }
  | { kind: 'publishedAgent'; id: string }

const LAST_OPENED_KEY = 'aiagent_last_opened'

export function getLastOpenedPointer(): LastOpenedPointer | null {
  try {
    const raw = localStorage.getItem(LAST_OPENED_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function setLastOpenedPointer(pointer: LastOpenedPointer | null) {
  try {
    if (pointer) localStorage.setItem(LAST_OPENED_KEY, JSON.stringify(pointer))
    else localStorage.removeItem(LAST_OPENED_KEY)
  } catch {
    // localStorage unavailable (private browsing, quota) — reopening on
    // reload just won't work this session, nothing else depends on it.
  }
}

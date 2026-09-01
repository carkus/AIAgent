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

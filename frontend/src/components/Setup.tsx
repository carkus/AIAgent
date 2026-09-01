import { useEffect, useRef, useState } from 'react'
import { bootstrap, listOllamaModels } from '../api'
import type { AgentConfig, LlmProvider } from '../types'
import styles from '../styles/Setup.module.css'

interface Props {
  bootstrapping: boolean
  error: string | null
  onStart: () => void
  onDone: (config: AgentConfig) => void
  onError: (msg: string) => void
}

const STORAGE_KEY = 'aiagent_saved_searches'

interface SavedSearch {
  id: string
  name: string
  keywords: string[]
}

function loadSaved(): SavedSearch[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveToDisk(searches: SavedSearch[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(searches))
}

export default function Setup({ bootstrapping, error, onStart, onDone, onError }: Props) {
  const [keywords, setKeywords] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [location, setLocation] = useState('Melbourne, Australia')
  const [provider, setProvider] = useState<LlmProvider>(null)
  const [ollamaModel, setOllamaModel] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [saved, setSaved] = useState<SavedSearch[]>(loadSaved)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (provider !== 'ollama' || modelsLoaded) return
    listOllamaModels().then(models => {
      setAvailableModels(models)
      setModelsLoaded(true)
      if (models.length > 0) setOllamaModel(prev => prev ?? models[0])
    })
  }, [provider, modelsLoaded])

  function addKeyword() {
    const kw = draft.trim()
    if (!kw || keywords.map(k => k.toLowerCase()).includes(kw.toLowerCase())) return
    const next = [...keywords, kw]
    setKeywords(next)
    setDraft('')
    inputRef.current?.focus()
    // Auto-save the accumulated keyword set
    const entry: SavedSearch = { id: Date.now().toString(), name: next.join(', '), keywords: next }
    const updated = [entry, ...saved.filter(s => s.name !== entry.name)]
    setSaved(updated)
    saveToDisk(updated)
  }

  function removeKeyword(kw: string) {
    setKeywords(prev => prev.filter(k => k !== kw))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); addKeyword() }
    if (e.key === 'Backspace' && !draft && keywords.length > 0) {
      setKeywords(prev => prev.slice(0, -1))
    }
  }

  function saveSearch() {
    if (keywords.length === 0) return
    const entry: SavedSearch = {
      id: Date.now().toString(),
      name: keywords.join(', '),
      keywords: [...keywords],
    }
    const updated = [entry, ...saved.filter(s => s.name !== entry.name)]
    setSaved(updated)
    saveToDisk(updated)
  }

  function loadSearch(entry: SavedSearch) {
    setKeywords([...entry.keywords])
    setDraft('')
    inputRef.current?.focus()
  }

  function deleteSearch(id: string) {
    const updated = saved.filter(s => s.id !== id)
    setSaved(updated)
    saveToDisk(updated)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (keywords.length === 0 || bootstrapping) return
    const loc = location.trim()
    const purpose =
      `Research agent for the following keywords: ${keywords.join(', ')}` +
      `${loc ? ` in ${loc}` : ''}. ` +
      `Search for relevant information, analyse patterns and trends, ` +
      `and present clear findings for each keyword.`
    onStart()
    try {
      const config = await bootstrap(purpose, provider, provider === 'ollama' ? ollamaModel : null)
      onDone({ ...config, keywords, location: loc, provider, ollama_model: provider === 'ollama' ? ollamaModel : null })
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>AI Agent</h1>
        <p className={styles.subtitle}>Add keywords, then hit Create Agent.</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.chipArea} onClick={() => inputRef.current?.focus()}>
            {keywords.map(kw => (
              <span key={kw} className={styles.chip}>
                {kw}
                <button
                  type="button"
                  className={styles.chipX}
                  onClick={ev => { ev.stopPropagation(); removeKeyword(kw) }}
                  aria-label={`Remove ${kw}`}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              ref={inputRef}
              className={styles.chipInput}
              value={draft}
              onChange={e => setDraft(e.target.value.slice(0, 50))}
              onKeyDown={handleKeyDown}
              onBlur={() => { if (draft.trim()) addKeyword() }}
              placeholder={keywords.length === 0 ? 'Type a keyword, press Enter…' : 'Add another…'}
              disabled={bootstrapping}
              maxLength={50}
            />
          </div>

          <div className={styles.locationRow}>
            <span className={styles.locationLabel}>Location</span>
            <input
              className={styles.locationInput}
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="e.g. Melbourne, Australia"
              disabled={bootstrapping}
            />
          </div>

          <div className={styles.locationRow}>
            <span className={styles.locationLabel}>Model</span>
            <select
              className={styles.providerSelect}
              value={provider ?? ''}
              onChange={e => setProvider((e.target.value || null) as LlmProvider)}
              disabled={bootstrapping}
            >
              <option value="">Auto (cloud, falls back to local)</option>
              <option value="gemini">Cloud only (Gemini)</option>
              <option value="ollama">Local only (Ollama) — free, needs `ollama serve` running</option>
            </select>
          </div>
          {provider === 'ollama' && (
            <>
              <div className={styles.locationRow}>
                <span className={styles.locationLabel}>Local model</span>
                {availableModels.length > 0 ? (
                  <select
                    className={styles.providerSelect}
                    value={ollamaModel ?? ''}
                    onChange={e => setOllamaModel(e.target.value || null)}
                    disabled={bootstrapping}
                  >
                    {availableModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <select className={styles.providerSelect} disabled>
                    <option>{modelsLoaded ? 'No local models found' : 'Loading…'}</option>
                  </select>
                )}
              </div>
              <p className={styles.providerHint}>
                {availableModels.length > 0
                  ? 'Different local models vary a lot in tool-calling/JSON reliability — worth trying a few.'
                  : 'No pulled models detected — is `ollama serve` running? Try `ollama pull qwen2.5:7b`.'}
                {' '}Only works with `sam local` / the local dev server, not a deployed agent.
              </p>
            </>
          )}

          <div className={styles.hintRow}>
            <p className={styles.charHint}>
              {draft.length > 0
                ? `${50 - draft.length} chars remaining`
                : `${keywords.length} keyword${keywords.length !== 1 ? 's' : ''} added`}
            </p>
            {keywords.length > 0 && (
              <button
                type="button"
                className={styles.clearBtn}
                onClick={() => { setKeywords([]); setDraft(''); inputRef.current?.focus() }}
                disabled={bootstrapping}
              >
                Clear all
              </button>
            )}
          </div>

          {saved.length > 0 && (
            <div className={styles.savedSection}>
              <p className={styles.savedHeading}>Saved searches</p>
              <div className={styles.savedList}>
                {saved.map(s => (
                  <div key={s.id} className={styles.savedRow} onClick={() => loadSearch(s)}>
                    <div className={styles.savedChips}>
                      {s.keywords.map(kw => (
                        <span key={kw} className={styles.savedChip}>{kw}</span>
                      ))}
                    </div>
                    <button
                      type="button"
                      className={styles.savedDelete}
                      onClick={ev => { ev.stopPropagation(); deleteSearch(s.id) }}
                      aria-label="Delete saved search"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={saveSearch}
              disabled={keywords.length === 0 || bootstrapping}
            >
              Save search
            </button>
            <button
              type="submit"
              className={styles.createBtn}
              disabled={bootstrapping || keywords.length === 0}
            >
              {bootstrapping ? 'Configuring agent…' : 'Create Agent'}
            </button>
          </div>
        </form>

        {bootstrapping && (
          <p className={styles.loadingHint}>
            {provider === 'ollama'
              ? `${ollamaModel ?? 'Your local model'} is designing your agent's tools and behaviour. This may take longer than the cloud default.`
              : 'Designing your agent\'s tools and behaviour. This takes ~10 seconds.'}
          </p>
        )}
      </div>
    </div>
  )
}

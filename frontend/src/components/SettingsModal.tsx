import { useEffect, useRef } from 'react'
import type { LlmProvider } from '../types'
import styles from '../styles/SettingsModal.module.css'

interface Props {
  isOpen: boolean
  onClose: () => void
  location: string
  onLocationChange: (value: string) => void
  locationSuggestions: string[]
  showLocationSuggestions: boolean
  onLocationFocus: () => void
  onLocationBlur: () => void
  onSelectLocation: (name: string) => void
  onDetectLocation: () => void
  detectingLocation: boolean
  provider: LlmProvider
  onProviderChange: (p: LlmProvider) => void
  ollamaModel: string | null
  onOllamaModelChange: (m: string | null) => void
  availableModels: string[]
  modelsLoaded: boolean
  disabled: boolean
}

export default function SettingsModal({
  isOpen,
  onClose,
  location,
  onLocationChange,
  locationSuggestions,
  showLocationSuggestions,
  onLocationFocus,
  onLocationBlur,
  onSelectLocation,
  onDetectLocation,
  detectingLocation,
  provider,
  onProviderChange,
  ollamaModel,
  onOllamaModelChange,
  availableModels,
  modelsLoaded,
  disabled,
}: Props) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  // Accessible-overlay basics: focus moves into the dialog on open, Escape
  // dismisses it — this app has no other dialog to mirror, so this is the
  // minimum a11y contract (focus + keyboard dismissal) rather than a full
  // focus trap.
  useEffect(() => {
    if (!isOpen) return
    closeBtnRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={e => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span id="settings-title" className={styles.title}>Settings</span>
          <button ref={closeBtnRef} type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <section className={styles.section}>
            <span className={styles.sectionLabel}>Location</span>
            <div className={styles.locationRow}>
              <div className={styles.locationInputWrap}>
                <input
                  className={styles.locationInput}
                  value={location}
                  onChange={e => onLocationChange(e.target.value)}
                  onFocus={onLocationFocus}
                  onBlur={onLocationBlur}
                  placeholder="e.g. Melbourne, Australia"
                  disabled={disabled}
                  autoComplete="off"
                />
                {showLocationSuggestions && locationSuggestions.length > 0 && (
                  <ul className={styles.locationSuggestions}>
                    {locationSuggestions.map(name => (
                      <li key={name} onMouseDown={() => onSelectLocation(name)}>
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                type="button"
                className={styles.detectBtn}
                onClick={onDetectLocation}
                disabled={disabled || detectingLocation}
              >
                {detectingLocation ? 'Detecting…' : '📍 Detect my location'}
              </button>
            </div>
          </section>

          <section className={styles.section}>
            <span className={styles.sectionLabel}>Model</span>
            <select
              className={styles.providerSelect}
              value={provider ?? ''}
              onChange={e => onProviderChange((e.target.value || null) as LlmProvider)}
              disabled={disabled}
            >
              <option value="">Auto (cloud, falls back to local)</option>
              <option value="gemini">Cloud only (Gemini)</option>
              <option value="ollama">Local only (Ollama) — free, needs `ollama serve` running</option>
            </select>

            {provider === 'ollama' && (
              <>
                {availableModels.length > 0 ? (
                  <select
                    className={styles.providerSelect}
                    value={ollamaModel ?? ''}
                    onChange={e => onOllamaModelChange(e.target.value || null)}
                    disabled={disabled}
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
                <p className={styles.providerHint}>
                  {availableModels.length > 0
                    ? 'Different local models vary a lot in tool-calling/JSON reliability — worth trying a few.'
                    : 'No pulled models detected — is `ollama serve` running? Try `ollama pull qwen2.5:7b`.'}
                  {' '}Only works with `sam local` / the local dev server, not a deployed agent.
                </p>
              </>
            )}
          </section>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.doneBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

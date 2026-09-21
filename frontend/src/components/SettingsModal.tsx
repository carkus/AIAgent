import { useEffect, useRef, useState } from 'react'
import type { LlmProvider, SearchDefaults } from '../types'
import { listMcpTools, type McpServerInfo } from '../api'
import { isTinyOllamaModel } from '../modelLabel'
import styles from '../styles/SettingsModal.module.css'

// Mirrors backend/src/agent_stream.py's MAX_DELEGATIONS_PER_REQUEST — shown
// as the placeholder/hint here, not enforced client-side; the backend clamps
// for real.
const DEFAULT_MAX_DELEGATIONS = 6
const DEFAULT_RESULTS_PER_PAGE = 20

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
  maxDelegations: number | null
  onMaxDelegationsChange: (n: number | null) => void
  searchDefaults: SearchDefaults
  onSearchDefaultsChange: (d: SearchDefaults) => void
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
  maxDelegations,
  onMaxDelegationsChange,
  searchDefaults,
  onSearchDefaultsChange,
  disabled,
}: Props) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const [mcpServers, setMcpServers] = useState<McpServerInfo[] | null>(null)

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

  // Read-only, so fetched fresh each time the panel opens rather than
  // threaded through Setup.tsx's own state — nothing here is user-editable.
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    listMcpTools().then(servers => { if (!cancelled) setMcpServers(servers) })
    return () => { cancelled = true }
  }, [isOpen])

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
        <span className={styles.dossierTab} aria-hidden="true">Settings File</span>
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
                </p>
                {isTinyOllamaModel(ollamaModel) && (
                  <p className={styles.providerWarning}>
                    ⚠ {ollamaModel} is a small model (≤3B params) — it frequently fails to
                    return valid AgentConfig JSON for bootstrap. If design fails, try Cloud
                    (Gemini) or a larger local model instead.
                  </p>
                )}
              </>
            )}
          </section>

          <section className={styles.section}>
            <span className={styles.sectionLabel}>Delegation</span>
            <input
              className={styles.numberInput}
              type="number"
              min={1}
              max={20}
              value={maxDelegations ?? ''}
              placeholder={String(DEFAULT_MAX_DELEGATIONS)}
              onChange={e => {
                const v = e.target.value
                onMaxDelegationsChange(v === '' ? null : Math.max(1, Math.min(20, Number(v))))
              }}
              disabled={disabled}
            />
            <p className={styles.providerHint}>
              Max worker agents this agent can spin up per turn when a task splits
              across several specialties/topics. Higher means more parallel research
              but more API cost per message. Default {DEFAULT_MAX_DELEGATIONS}.
            </p>
          </section>

          <section className={styles.section}>
            <span className={styles.sectionLabel}>Search defaults</span>
            <div className={styles.searchGrid}>
              <label className={styles.searchField}>
                <span>Country</span>
                <input
                  className={styles.numberInput}
                  type="text"
                  maxLength={2}
                  placeholder="au"
                  value={searchDefaults.country ?? ''}
                  onChange={e => onSearchDefaultsChange({
                    ...searchDefaults,
                    country: e.target.value.trim().toLowerCase().slice(0, 2) || undefined,
                  })}
                  disabled={disabled}
                />
              </label>
              <label className={styles.searchField}>
                <span>Results per page</span>
                <input
                  className={styles.numberInput}
                  type="number"
                  min={1}
                  max={50}
                  placeholder={String(DEFAULT_RESULTS_PER_PAGE)}
                  value={searchDefaults.results_per_page ?? ''}
                  onChange={e => {
                    const v = e.target.value
                    onSearchDefaultsChange({
                      ...searchDefaults,
                      results_per_page: v === '' ? undefined : Math.max(1, Math.min(50, Number(v))),
                    })
                  }}
                  disabled={disabled}
                />
              </label>
              <label className={styles.searchField}>
                <span>Radius (km)</span>
                <input
                  className={styles.numberInput}
                  type="number"
                  min={0}
                  placeholder="any"
                  value={searchDefaults.radius_km ?? ''}
                  onChange={e => {
                    const v = e.target.value
                    onSearchDefaultsChange({
                      ...searchDefaults,
                      radius_km: v === '' ? undefined : Math.max(0, Number(v)),
                    })
                  }}
                  disabled={disabled}
                />
              </label>
            </div>
            <p className={styles.providerHint}>
              Adzuna job-search defaults (backend/src/tools.py's search_jobs) — the
              agent can still override any of these per search; these just fill in
              whatever it leaves out. Radius only applies alongside a location.
            </p>
          </section>

          <section className={styles.section}>
            <span className={styles.sectionLabel}>MCP tools</span>
            {mcpServers === null ? (
              <p className={styles.providerHint}>Loading…</p>
            ) : mcpServers.length === 0 ? (
              <p className={styles.providerHint}>No vetted MCP servers configured.</p>
            ) : (
              <ul className={styles.mcpList}>
                {mcpServers.map(server => (
                  <li key={server.server_id} className={styles.mcpServer}>
                    <div className={styles.mcpServerHeader}>
                      <span className={server.reachable ? styles.mcpDotOn : styles.mcpDotOff} aria-hidden="true" />
                      <span className={styles.mcpServerName}>{server.server_id}</span>
                      <span className={styles.mcpServerStatus}>
                        {server.reachable ? 'active' : 'unreachable'}
                      </span>
                    </div>
                    <p className={styles.providerHint}>{server.description}</p>
                    {server.tools.length > 0 && (
                      <div className={styles.mcpToolPills}>
                        {server.tools.map(t => (
                          <span key={t.name} className={styles.mcpToolPill} title={t.description}>
                            {t.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className={styles.providerHint}>
              Read-only — the vetted servers bootstrap can pick real tools from
              instead of writing a Python implementation (backend/src/mcp_registry.py).
            </p>
          </section>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.doneBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

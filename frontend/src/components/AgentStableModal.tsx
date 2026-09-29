import { useEffect, useRef, useState } from 'react'
import type { EvalResultItem } from '../types'
import { fetchAgentEvalLog, listPublishedAgents, type PublishedAgent } from '../api'
import { BEHAVIOR_TOGGLES } from '../agentTypes'
import FeedbackStatusBar from './FeedbackStatusBar'
import styles from '../styles/AgentStableModal.module.css'

function behaviorLabels(toggleIds: string[] | undefined): string[] {
  if (!toggleIds || toggleIds.length === 0) return []
  return toggleIds.map(id => BEHAVIOR_TOGGLES.find(t => t.id === id)?.label ?? id)
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onHire: (agent: PublishedAgent) => void
}

function statBadge(agent: PublishedAgent): { label: string; flagged: boolean } {
  const stats = agent.stats
  if (!stats || stats.pulls === 0) return { label: 'not run yet', flagged: false }
  const pct = Math.round((stats.rate ?? 0) * 100)
  return { label: `${pct}% pass rate · ${stats.pulls} checks`, flagged: pct < 70 }
}

// "A place/popup to view the agent stable and/or past success/failure" — the
// roster of *published* agents (backend/src/agent_registry.py) alongside the
// success/failure history backend/src/agent_stats.py aggregates from
// eval_log.json, now that MCP-invoked runs tag their checks with the
// publishing agent's own id (backend/mcp_server.py). Read-only, fetched
// fresh on open — same pattern as SettingsModal's own MCP-server panel.
export default function AgentStableModal({ isOpen, onClose, onHire }: Props) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const [agents, setAgents] = useState<PublishedAgent[] | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [evalLogs, setEvalLogs] = useState<Record<string, EvalResultItem[]>>({})
  const [loadingLog, setLoadingLog] = useState<string | null>(null)
  // Per-agent collapse state for the Self-checks list inside an expanded row —
  // previously hardcoded to always-expanded (collapsed={false}, onToggleCollapse
  // a no-op) so FeedbackStatusBar's own chevron looked clickable but did nothing.
  // Defaults to expanded (matches the old always-shown behaviour) until toggled.
  const [checksCollapsed, setChecksCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!isOpen) return
    closeBtnRef.current?.focus()
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setExpandedId(null)
    setEvalLogs({})
    setChecksCollapsed({})
    listPublishedAgents().then(a => { if (!cancelled) setAgents(a) })
    return () => { cancelled = true }
  }, [isOpen])

  function toggleExpanded(agent: PublishedAgent) {
    if (expandedId === agent.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(agent.id)
    if (!evalLogs[agent.id]) {
      setLoadingLog(agent.id)
      fetchAgentEvalLog(agent.id).then(entries => {
        setEvalLogs(prev => ({ ...prev, [agent.id]: entries }))
        setLoadingLog(null)
      })
    }
  }

  if (!isOpen) return null

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-stable-title"
        onClick={e => e.stopPropagation()}
      >
        <span className={styles.dossierTab} aria-hidden="true">Stable Roster</span>
        <div className={styles.header}>
          <span id="agent-stable-title" className={styles.title}>Agents</span>
          <button ref={closeBtnRef} type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close agents">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.letterhead}>Published Agents &amp; Track Record</p>

          {agents === null ? (
            <p className={styles.hint}>Loading…</p>
          ) : agents.length === 0 ? (
            <p className={styles.hint}>
              No agents published yet — use "Publish as MCP tool" in a chat session to add one to the stable.
            </p>
          ) : (
            <ul className={styles.list}>
              {agents.map(agent => {
                const badge = statBadge(agent)
                const expanded = expandedId === agent.id
                const persona = agent.agent_config?.persona
                const behaviors = behaviorLabels(agent.agent_config?.active_toggles)
                return (
                  <li key={agent.id} className={styles.agentCard}>
                    {/* Not a <button> — the Hire button living inside it would be an
                        invalid button-in-button, same reasoning as Setup.tsx's
                        SectionHeader. Hire's own onClick stops propagation so hiring
                        doesn't also toggle the row's expanded history. */}
                    <div
                      className={styles.agentRow}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleExpanded(agent)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(agent) } }}
                      aria-expanded={expanded}
                    >
                      <span className={styles.agentInfo}>
                        <span className={styles.agentName}>{agent.name}</span>
                        <span className={styles.agentToolName}>{agent.tool_name}</span>
                        {agent.description && <span className={styles.agentDescription}>{agent.description}</span>}
                        {(persona?.traits.length || behaviors.length > 0) && (
                          <span className={styles.traitsPills}>
                            {persona?.traits.map(trait => (
                              <span key={trait} className={styles.traitPill}>{trait}</span>
                            ))}
                            {behaviors.map(label => (
                              <span key={label} className={styles.behaviorPill}>{label}</span>
                            ))}
                          </span>
                        )}
                      </span>
                      <span className={badge.flagged ? styles.statBadgeFlagged : styles.statBadge}>
                        {badge.label}
                      </span>
                      <button
                        type="button"
                        className={styles.hireBtn}
                        onClick={e => { e.stopPropagation(); onHire(agent) }}
                        title={`Hire ${agent.name} — start a fresh chat with this agent`}
                      >
                        Hire
                      </button>
                      <span className={styles.chevron}>{expanded ? '▾' : '▸'}</span>
                    </div>
                    {expanded && (
                      <div className={styles.history}>
                        {(() => {
                          const persona = agent.agent_config?.persona
                          const behaviors = behaviorLabels(agent.agent_config?.active_toggles)
                          if (!persona && behaviors.length === 0) return null
                          return (
                            <div className={styles.traitsSection}>
                              {persona && (
                                <div className={styles.traitsRow}>
                                  <span className={styles.traitsLabel}>Personality</span>
                                  <span className={styles.traitsPills}>
                                    {persona.traits.map(trait => (
                                      <span key={trait} className={styles.traitPill}>{trait}</span>
                                    ))}
                                  </span>
                                  {persona.rationale && (
                                    <p className={styles.personaRationale}>{persona.rationale}</p>
                                  )}
                                </div>
                              )}
                              {behaviors.length > 0 && (
                                <div className={styles.traitsRow}>
                                  <span className={styles.traitsLabel}>Behaviour</span>
                                  <span className={styles.traitsPills}>
                                    {behaviors.map(label => (
                                      <span key={label} className={styles.behaviorPill}>{label}</span>
                                    ))}
                                  </span>
                                </div>
                              )}
                            </div>
                          )
                        })()}
                        {loadingLog === agent.id ? (
                          <p className={styles.hint}>Loading history…</p>
                        ) : (evalLogs[agent.id]?.length ?? 0) === 0 ? (
                          <p className={styles.hint}>No recorded checks for this agent yet.</p>
                        ) : (
                          <FeedbackStatusBar
                            results={evalLogs[agent.id]}
                            collapsed={checksCollapsed[agent.id] ?? false}
                            onToggleCollapse={() =>
                              setChecksCollapsed(prev => ({ ...prev, [agent.id]: !(prev[agent.id] ?? false) }))
                            }
                          />
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.doneBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

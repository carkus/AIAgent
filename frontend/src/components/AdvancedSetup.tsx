import { useEffect, useRef, useState } from 'react'
import { bootstrap, listMcpTools, validateConfig } from '../api'
import type { ConfigValidationIssue, McpServerInfo } from '../api'
import type { AgentConfig, AgentSpec, AgentTemplateId, LlmProvider, ToolDefinition } from '../types'
import { BEHAVIOR_TOGGLES, MAX_FOCUS_CHARS, PERSONALITY_TRAITS, getTemplate, shortFocus } from '../agentTypes'
import { DEFAULT_OLLAMA_MODEL, describeModel, describeModelFallback } from '../modelLabel'
import styles from '../styles/AdvancedSetup.module.css'
// Basic Setup's pill/chip classes, so Focus, Personality and Behavior look
// the same on both screens.
import pills from '../styles/Setup.module.css'
import BehaviorIcon from './BehaviorIcon'

// Same cap as basic Setup's MAX_SPECIALTIES.
const MAX_FOCUS = 5

// Advanced agent creation: the same bootstrap pipeline as Setup.tsx, but the
// user's intent travels as a structured spec (types.ts's AgentSpec) instead of
// being folded into one purpose sentence, and the generated config is shown
// for review/editing before launch. Each field below is labelled with the
// layer that actually enforces it — see backend/src/agent_spec.py.
//
//   define  → build the spec
//   building → stream /bootstrap (spec included)
//   review  → edit system_prompt/tools, re-check via /validate-config, launch

// Advanced Setup always bootstraps a general agent; the job-search template
// is a basic-Setup preset.
const AGENT_TYPE: AgentTemplateId = 'general'

type Step = 'define' | 'building' | 'review'
type Layer = 'prompt' | 'guarded' | 'pinned' | 'code'

const LAYER_TEXT: Record<Layer, string> = {
  prompt: 'prompt — asked, not guaranteed',
  guarded: 'prompt + output guard — screened, not guaranteed',
  pinned: 'pinned — overwritten after bootstrap',
  code: 'enforced in code at runtime',
}

// search_jobs is omitted: agent_stream.py only exposes it to job_search
// agents, and Advanced Setup always builds a general one.
const PRIMITIVES: { name: string; label: string }[] = [
  { name: 'fetch_page', label: 'fetch_page — read a known URL' },
  { name: 'search_image', label: 'search_image — find images' },
  { name: 'generate_image', label: 'generate_image — create images' },
]

interface Props {
  onCancel: () => void
  onDone: (config: AgentConfig) => void
}

function LayerTag({ layer }: { layer: Layer }) {
  return <span className={`${styles.layer} ${styles[`layer_${layer}`]}`}>{LAYER_TEXT[layer]}</span>
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]
}

function optionalInt(value: string): number | null {
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

export default function AdvancedSetup({ onCancel, onDone }: Props) {
  const provider = (localStorage.getItem('aiagent_provider') as LlmProvider) || 'ollama'
  const ollamaModel = localStorage.getItem('aiagent_ollama_model') || DEFAULT_OLLAMA_MODEL

  const [step, setStep] = useState<Step>('define')

  // --- define ---
  const [personaName, setPersonaName] = useState('')
  const [keywords, setKeywords] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const focusInputRef = useRef<HTMLInputElement>(null)
  function addKeyword() {
    const kw = draft.trim()
    setDraft('')
    if (!kw || keywords.length >= MAX_FOCUS || keywords.some(k => k.toLowerCase() === kw.toLowerCase())) return
    setKeywords(prev => [...prev, kw])
  }
  const [selectedTraits, setSelectedTraits] = useState<string[]>([])
  const [activeToggles, setActiveToggles] = useState<string[]>([])
  const [mission, setMission] = useState('')
  const [successCriteria, setSuccessCriteria] = useState('')
  const [outOfScope, setOutOfScope] = useState('')
  const [primitives, setPrimitives] = useState<Set<string>>(
    () => new Set(PRIMITIVES.map(p => p.name)),
  )
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [mcpTools, setMcpTools] = useState<Set<string> | null>(null)
  const [allowGenerated, setAllowGenerated] = useState(true)
  const [allowDelegation, setAllowDelegation] = useState(true)
  const [maxRounds, setMaxRounds] = useState('')
  const [maxCallsPerStep, setMaxCallsPerStep] = useState('')
  const [temperature, setTemperature] = useState('')

  // --- building ---
  const [progress, setProgress] = useState<string[]>([])
  const [buildError, setBuildError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // --- review ---
  const [config, setConfig] = useState<AgentConfig | null>(null)
  const [issues, setIssues] = useState<ConfigValidationIssue[]>([])
  const [validated, setValidated] = useState(false)
  const [validating, setValidating] = useState(false)

  const reachableServers = mcpServers.filter(s => s.reachable)
  const allMcpKeys = reachableServers.flatMap(s => s.tools.map(t => `${s.server_id}/${t.name}`))

  useEffect(() => {
    listMcpTools().then(setMcpServers)
    return () => abortRef.current?.abort()
  }, [])

  const availablePrimitives = PRIMITIVES

  function togglePrimitive(name: string) {
    setPrimitives(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleMcp(key: string) {
    setMcpTools(prev => {
      const next = new Set(prev ?? allMcpKeys)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function buildSpec(): AgentSpec {
    const chosenPrimitives = availablePrimitives.map(p => p.name).filter(n => primitives.has(n))
    const temp = parseFloat(temperature)
    return {
      mission: mission.trim(),
      success_criteria: successCriteria.trim(),
      out_of_scope: outOfScope.trim(),
      persona_name: personaName.trim(),
      // Everything ticked = no restriction (null), so newly-added primitives
      // or MCP servers aren't silently excluded from an "allow all" spec.
      allowed_primitives:
        chosenPrimitives.length === availablePrimitives.length ? null : chosenPrimitives,
      allowed_mcp_tools:
        mcpTools === null || allMcpKeys.every(k => mcpTools.has(k)) ? null : [...mcpTools],
      allow_generated_tools: allowGenerated,
      allow_delegation: allowDelegation,
      max_tool_rounds: optionalInt(maxRounds),
      max_tool_calls_per_step: optionalInt(maxCallsPerStep),
      temperature: Number.isFinite(temp) ? temp : null,
    }
  }

  async function generate() {
    if (keywords.length === 0) return
    const controller = new AbortController()
    abortRef.current = controller
    setProgress([])
    setBuildError(null)
    setStep('building')
    try {
      // No free-text role: as on the basic screen, the agent's role comes
      // from the stackable personality and behavior pills. The purpose is
      // built exactly as Setup.tsx's runBootstrap builds it — the template
      // over the focus topics, then behavior, then personality instructions.
      // Focus is the job: stored as config.keywords (what Chat.tsx
      // auto-starts on and agent_stream.py delegates over).
      const traitPool = PERSONALITY_TRAITS[AGENT_TYPE]
      const traitIds = traitPool.filter(t => selectedTraits.includes(t.id)).map(t => t.id)
      const behaviorInstructions = BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.instruction)
      const traitInstructions = traitPool.filter(t => selectedTraits.includes(t.id)).map(t => t.instruction)
      const purpose = getTemplate(AGENT_TYPE).buildPurpose(keywords, '') +
        (behaviorInstructions.length > 0 ? ` ${behaviorInstructions.join(' ')}` : '') +
        (traitInstructions.length > 0 ? ` ${traitInstructions.join(' ')}` : '')
      const result = await bootstrap(
        purpose,
        provider,
        ollamaModel,
        event => {
          if (event.type === 'status') setProgress(p => [...p, event.message])
          else if (event.type === 'tool') setProgress(p => [...p, `Tool: ${event.name}`])
        },
        AGENT_TYPE,
        controller.signal,
        null,
        buildSpec(),
      )
      setConfig({
        ...result,
        provider,
        ollama_model: ollamaModel,
        template: AGENT_TYPE,
        keywords,
        active_toggles: activeToggles,
        active_traits: traitIds,
      })
      setIssues([])
      setValidated(false)
      setStep('review')
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStep('define')
        return
      }
      setBuildError(err instanceof Error ? err.message : String(err))
    } finally {
      abortRef.current = null
    }
  }

  function editConfig(patch: Partial<AgentConfig>) {
    setConfig(c => (c ? { ...c, ...patch } : c))
    setValidated(false)
  }

  function editTool(index: number, patch: Partial<ToolDefinition>) {
    if (!config) return
    editConfig({ tools: config.tools.map((t, i) => (i === index ? { ...t, ...patch } : t)) })
  }

  function removeTool(index: number) {
    if (!config) return
    editConfig({ tools: config.tools.filter((_, i) => i !== index) })
  }

  async function runValidation(): Promise<AgentConfig | null> {
    if (!config) return null
    setValidating(true)
    try {
      const res = await validateConfig(config)
      // Keep the client-only fields bootstrap never sees.
      const merged = { ...config, ...res.config }
      setConfig(merged)
      setIssues(res.errors)
      setValidated(true)
      return res.errors.some(e => e.severity !== 'note') ? null : merged
    } catch (err) {
      setIssues([{ tool: null, message: err instanceof Error ? err.message : String(err) }])
      setValidated(false)
      return null
    } finally {
      setValidating(false)
    }
  }

  async function launch() {
    // Always launch the server-validated copy, never the raw edited one.
    const checked = await runValidation()
    if (checked) onDone(checked)
  }

  const blocking = issues.filter(i => i.severity !== 'note')
  const notes = issues.filter(i => i.severity === 'note')

  if (step === 'building') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h2 className={styles.title}>Building agent…</h2>
          <div className={styles.scroll}>
            <ul className={styles.progress}>
              {progress.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
            {buildError && <p className={styles.error}>{buildError}</p>}
          </div>

          <div className={styles.actions}>
            {buildError ? (
              <button type="button" className={styles.btn} onClick={() => setStep('define')}>Back</button>
            ) : (
              <button type="button" className={styles.btn} onClick={() => abortRef.current?.abort()}>Cancel</button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (step === 'review' && config) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h2 className={styles.title}>Review agent</h2>
          <div className={styles.scroll}>
            <p className={styles.hint}>
              This is exactly what bootstrap generated. Edit anything, then Validate — the same
              deterministic checks bootstrap runs (compile, undefined names, forbidden calls, your
              spec) run again on your edits before launch.
            </p>

            {config.persona && (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Persona</h3>
                <p><strong>{config.persona.name}</strong> — {config.persona.traits.join(', ')}</p>
                {config.persona.rationale && <p className={styles.hint}>{config.persona.rationale}</p>}
              </section>
            )}

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>System prompt</h3>
              <textarea
                className={`${styles.input} ${styles.code}`}
                rows={12}
                value={config.system_prompt}
                onChange={e => editConfig({ system_prompt: e.target.value })}
              />
            </section>

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Tools ({config.tools.length})</h3>
              {config.tools.length === 0 && <p className={styles.hint}>No generated or MCP tools — the agent will only have its built-in primitives.</p>}
              {config.tools.map((tool, i) => (
                <div key={i} className={styles.tool}>
                  <div className={styles.toolHeader}>
                    <code>{tool.name}</code>
                    <span className={styles.hint}>{tool.source === 'mcp' ? `MCP · ${tool.mcp_server}/${tool.mcp_tool}` : 'generated Python'}</span>
                    <button type="button" className={styles.linkBtn} onClick={() => removeTool(i)}>Remove</button>
                  </div>
                  <p className={styles.hint}>{tool.description}</p>
                  {tool.source !== 'mcp' && (
                    <textarea
                      className={`${styles.input} ${styles.code}`}
                      rows={8}
                      value={tool.implementation ?? ''}
                      onChange={e => editTool(i, { implementation: e.target.value })}
                    />
                  )}
                </div>
              ))}
            </section>

            {notes.length > 0 && (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Spec enforcement</h3>
                <ul className={styles.list}>
                  {notes.map((n, i) => <li key={i}>{n.message}</li>)}
                </ul>
              </section>
            )}

            {blocking.length > 0 && (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Problems</h3>
                <ul className={`${styles.list} ${styles.error}`}>
                  {blocking.map((n, i) => <li key={i}>{n.tool ? `${n.tool}: ` : ''}{n.message}</li>)}
                </ul>
              </section>
            )}
            {validated && blocking.length === 0 && <p className={styles.hint}>Validation passed.</p>}
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={() => setStep('define')}>Back to spec</button>
            <button type="button" className={styles.btn} onClick={generate}>Regenerate</button>
            <button type="button" className={styles.btn} onClick={runValidation} disabled={validating}>
              {validating ? 'Validating…' : 'Validate'}
            </button>
            <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={launch} disabled={validating}>
              Launch
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <form
        className={styles.card}
        onSubmit={e => { e.preventDefault(); generate() }}
      >
        <h2 className={styles.title}>Advanced agent setup</h2>
        <span className={styles.modelLiner} title={`${describeModelFallback(provider)} — change it in Settings`}>
          <span className={styles.modelLinerIcon} aria-hidden="true">🧠</span>
          <span>{describeModel(provider, ollamaModel)}</span>
        </span>

        <div className={styles.scroll}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Focus</h3>
            <p className={styles.hint}>
              The job: the topics this agent works on. Kept apart from the agent itself, as in the
              basic screen's Focus.
            </p>
            <span className={styles.hint}>Topics <LayerTag layer="prompt" /></span>
            <div className={pills.chipArea} onClick={() => focusInputRef.current?.focus()}>
              {keywords.map(kw => (
                <span key={kw} className={pills.chip} title={kw.length > MAX_FOCUS_CHARS ? kw : undefined}>
                  {shortFocus(kw)}
                  <button
                    type="button"
                    className={pills.chipX}
                    onClick={ev => { ev.stopPropagation(); setKeywords(prev => prev.filter(k => k !== kw)) }}
                    aria-label={`Remove ${kw}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                ref={focusInputRef}
                className={pills.chipInput}
                value={draft}
                onChange={e => setDraft(e.target.value.slice(0, MAX_FOCUS_CHARS))}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); addKeyword() }
                  if (e.key === 'Backspace' && !draft && keywords.length > 0) setKeywords(prev => prev.slice(0, -1))
                }}
                onBlur={() => { if (draft.trim()) addKeyword() }}
                placeholder={keywords.length >= MAX_FOCUS ? `Limit of ${MAX_FOCUS} reached` : (keywords.length === 0 ? 'Type a topic, press Enter…' : '+ Add Focus')}
                disabled={keywords.length >= MAX_FOCUS}
                maxLength={MAX_FOCUS_CHARS}
              />
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Identity</h3>
            <label className={styles.field}>
              <span>Persona name <LayerTag layer="pinned" /></span>
              <input className={styles.input} maxLength={40} value={personaName} onChange={e => setPersonaName(e.target.value)} placeholder="Let the model choose" />
            </label>
            <span className={styles.hint}>Personality <LayerTag layer="prompt" /></span>
            <div className={pills.behaviorTogglesRow}>
              {PERSONALITY_TRAITS[AGENT_TYPE].map(t => {
                const active = selectedTraits.includes(t.id)
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={active ? pills.behaviorToggleActive : pills.behaviorToggle}
                    onClick={() => setSelectedTraits(prev => toggleId(prev, t.id))}
                    title={t.instruction}
                    aria-pressed={active}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
            <span className={styles.hint}>Behavior <LayerTag layer="prompt" /></span>
            <div className={pills.behaviorIconRow}>
              {BEHAVIOR_TOGGLES.map(t => {
                const active = activeToggles.includes(t.id)
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={active ? pills.behaviorIconBtnActive : pills.behaviorIconBtn}
                    onClick={() => setActiveToggles(prev => toggleId(prev, t.id))}
                    title={t.description}
                    aria-label={t.label}
                    aria-pressed={active}
                  >
                    <span className={pills.behaviorIconGlyph} aria-hidden="true"><BehaviorIcon id={t.id} /></span>
                    <span className={pills.behaviorIconLabel}>{t.label}</span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Scope</h3>
            <label className={styles.field}>
              <span>Mission <LayerTag layer="prompt" /></span>
              <textarea className={styles.input} rows={2} value={mission} onChange={e => setMission(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>What a good answer looks like <LayerTag layer="prompt" /></span>
              <textarea className={styles.input} rows={2} value={successCriteria} onChange={e => setSuccessCriteria(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>Out of scope — the agent should decline <LayerTag layer="guarded" /></span>
              <textarea className={styles.input} rows={2} value={outOfScope} onChange={e => setOutOfScope(e.target.value)} />
            </label>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Tools <LayerTag layer="code" /></h3>
            <p className={styles.hint}>
              Unticked tools are removed from the tool list the model sees, and any call to them is
              refused at dispatch.
            </p>
            {availablePrimitives.map(p => (
              <label key={p.name} className={styles.check}>
                <input type="checkbox" checked={primitives.has(p.name)} onChange={() => togglePrimitive(p.name)} />
                {p.label}
              </label>
            ))}
            {reachableServers.map(server => (
              <div key={server.server_id} className={styles.mcpGroup}>
                <span className={styles.hint}>MCP · {server.server_id}</span>
                {server.tools.map(t => {
                  const key = `${server.server_id}/${t.name}`
                  return (
                    <label key={key} className={styles.check} title={t.description}>
                      <input type="checkbox" checked={mcpTools === null || mcpTools.has(key)} onChange={() => toggleMcp(key)} />
                      {t.name}
                    </label>
                  )
                })}
              </div>
            ))}
            <label className={styles.check}>
              <input type="checkbox" checked={allowGenerated} onChange={e => setAllowGenerated(e.target.checked)} />
              Allow model-written Python tools
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={allowDelegation} onChange={e => setAllowDelegation(e.target.checked)} />
              Allow delegating to worker agents
            </label>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Limits <LayerTag layer="code" /></h3>
            <div className={styles.row}>
              <label className={styles.field}>
                <span>Max tool rounds (1–25)</span>
                <input className={styles.input} type="number" min={1} max={25} value={maxRounds} onChange={e => setMaxRounds(e.target.value)} placeholder="25" />
              </label>
              <label className={styles.field}>
                <span>Max calls per round (1–20)</span>
                <input className={styles.input} type="number" min={1} max={20} value={maxCallsPerStep} onChange={e => setMaxCallsPerStep(e.target.value)} placeholder="Default" />
              </label>
              <label className={styles.field}>
                <span>Temperature (0–1.5)</span>
                <input className={styles.input} type="number" min={0} max={1.5} step={0.1} value={temperature} onChange={e => setTemperature(e.target.value)} placeholder="Default" />
              </label>
            </div>
          </section>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={onCancel}>Back</button>
          <button type="submit" className={`${styles.btn} ${styles.primary}`} disabled={keywords.length === 0}>
            Generate
          </button>
        </div>
      </form>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { bootstrap, listMcpTools, validateConfig } from '../api'
import type { ConfigValidationIssue, McpServerInfo } from '../api'
import type { AgentConfig, AgentSpec, AgentTemplateId, LlmProvider, ToolDefinition } from '../types'
import { AGENT_TEMPLATES } from '../agentTypes'
import { DEFAULT_OLLAMA_MODEL, describeModel } from '../modelLabel'
import styles from '../styles/AdvancedSetup.module.css'

// Advanced agent creation: the same bootstrap pipeline as Setup.tsx, but the
// user's intent travels as a structured spec (types.ts's AgentSpec) instead of
// being folded into one purpose sentence, and the generated config is shown
// for review/editing before launch. Each field below is labelled with the
// layer that actually enforces it — see backend/src/agent_spec.py.
//
//   define  → build the spec
//   building → stream /bootstrap (spec included)
//   review  → edit system_prompt/tools, re-check via /validate-config, launch

type Step = 'define' | 'building' | 'review'
type Layer = 'prompt' | 'guarded' | 'pinned' | 'code'

const LAYER_TEXT: Record<Layer, string> = {
  prompt: 'prompt — asked, not guaranteed',
  guarded: 'prompt + output guard — screened, not guaranteed',
  pinned: 'pinned — overwritten after bootstrap',
  code: 'enforced in code at runtime',
}

const PRIMITIVES: { name: string; label: string; jobOnly?: boolean }[] = [
  { name: 'fetch_page', label: 'fetch_page — read a known URL' },
  { name: 'search_jobs', label: 'search_jobs — Adzuna listings', jobOnly: true },
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

function optionalInt(value: string): number | null {
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

export default function AdvancedSetup({ onCancel, onDone }: Props) {
  const provider = (localStorage.getItem('aiagent_provider') as LlmProvider) || 'ollama'
  const ollamaModel = localStorage.getItem('aiagent_ollama_model') || DEFAULT_OLLAMA_MODEL

  const [step, setStep] = useState<Step>('define')

  // --- define ---
  const [purpose, setPurpose] = useState('')
  const [agentType, setAgentType] = useState<AgentTemplateId>('general')
  const [location, setLocation] = useState('')
  const [personaName, setPersonaName] = useState('')
  const [traits, setTraits] = useState('')
  const [voice, setVoice] = useState('')
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

  // Primitives that exist for this agent type at all — search_jobs is only
  // ever exposed to job_search agents (agent_stream.py), regardless of spec.
  const availablePrimitives = PRIMITIVES.filter(p => !p.jobOnly || agentType === 'job_search')

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
      voice: voice.trim(),
      persona_name: personaName.trim(),
      persona_traits: traits.split(',').map(t => t.trim()).filter(Boolean),
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
    if (!purpose.trim()) return
    const controller = new AbortController()
    abortRef.current = controller
    setProgress([])
    setBuildError(null)
    setStep('building')
    try {
      const result = await bootstrap(
        purpose.trim(),
        provider,
        ollamaModel,
        event => {
          if (event.type === 'status') setProgress(p => [...p, event.message])
          else if (event.type === 'tool') setProgress(p => [...p, `Tool: ${event.name}`])
        },
        agentType,
        controller.signal,
        null,
        buildSpec(),
      )
      setConfig({
        ...result,
        location: location.trim() || undefined,
        provider,
        ollama_model: ollamaModel,
        template: agentType,
        keywords: [],
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
          <ul className={styles.progress}>
            {progress.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
          {buildError && <p className={styles.error}>{buildError}</p>}
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
        <p className={styles.hint}>
          Each field is tagged with where it takes effect. Model: {describeModel(provider, ollamaModel)} (change it in Settings).
        </p>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Purpose</h3>
          <label className={styles.field}>
            <span>What should this agent do? <LayerTag layer="prompt" /></span>
            <textarea className={styles.input} rows={3} required value={purpose} onChange={e => setPurpose(e.target.value)} />
          </label>
          <div className={styles.row}>
            <label className={styles.field}>
              <span>Agent type <LayerTag layer="code" /></span>
              <select className={styles.input} value={agentType} onChange={e => setAgentType(e.target.value as AgentTemplateId)}>
                {AGENT_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>Location <LayerTag layer="prompt" /></span>
              <input className={styles.input} value={location} onChange={e => setLocation(e.target.value)} />
            </label>
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Identity</h3>
          <div className={styles.row}>
            <label className={styles.field}>
              <span>Persona name <LayerTag layer="pinned" /></span>
              <input className={styles.input} maxLength={40} value={personaName} onChange={e => setPersonaName(e.target.value)} placeholder="Let the model choose" />
            </label>
            <label className={styles.field}>
              <span>Traits, comma-separated (max 5) <LayerTag layer="pinned" /></span>
              <input className={styles.input} value={traits} onChange={e => setTraits(e.target.value)} placeholder="Let the model choose" />
            </label>
          </div>
          <label className={styles.field}>
            <span>Voice <LayerTag layer="prompt" /></span>
            <input className={styles.input} value={voice} onChange={e => setVoice(e.target.value)} placeholder="e.g. plain, direct, no filler" />
          </label>
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

        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={onCancel}>Back</button>
          <button type="submit" className={`${styles.btn} ${styles.primary}`} disabled={!purpose.trim()}>
            Generate
          </button>
        </div>
      </form>
    </div>
  )
}

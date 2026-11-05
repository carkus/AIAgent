// "How this agent was made": a step-by-step account of the bootstrap that
// produced this AgentConfig, read from config.bootstrap_report (what the
// model was grounded on, what it proposed, what the deterministic code checks
// caught and how it was fixed or dropped, rules applied, self-checks, memory)
// plus the config itself (persona, system prompt, final tools and their code).
// The timed waterfall (CaseFile, from bootstrap_trace) sits underneath.
// Built entirely from data that travels with the config; no server state.
import type { AgentConfig, BootstrapIssue } from '../types'
import CaseFile from './CaseFile'
import styles from '../styles/AgentMakingReport.module.css'

interface Props {
  config: AgentConfig
}

const AGENT_TYPE_LABEL: Record<string, string> = {
  research: 'research',
  job_search: 'job search',
  general: 'general',
}

function sourceLabel(source: string | null | undefined): string {
  if (source === 'mcp') return 'vetted MCP tool'
  if (source === 'generated') return 'written by the model'
  return 'tool'
}

function modelName(provider?: string | null, model?: string | null): string {
  if (!provider && !model) return 'the default model'
  if (provider && model) return `${provider} · ${model}`
  return (provider ?? model) as string
}

function checkLabel(name: string | undefined): string {
  return (name ?? 'check').replace(/_/g, ' ')
}

function IssueList({ issues }: { issues: BootstrapIssue[] }) {
  return (
    <ul className={styles.list}>
      {issues.map((it, i) => (
        <li key={i}>
          <code>{it.tool}</code>: {it.message}
        </li>
      ))}
    </ul>
  )
}

export default function AgentMakingReport({ config }: Props) {
  const r = config.bootstrap_report
  const trace = config.bootstrap_trace ?? []
  const tools = config.tools ?? []
  const grounding = r?.grounding ?? []
  const catalog = r?.catalog ?? []
  const checks = r?.code_checks
  const remaining = new Set((checks?.remaining ?? []).map(i => i.tool))
  const fixedIssues = (checks?.issues ?? []).filter(i => !remaining.has(i.tool))
  const dropped = checks?.dropped ?? []
  const mcpDropped = r?.mcp_dropped ?? []
  const proposed = r?.design?.tools ?? []
  const finalNames = new Set(tools.map(t => t.name))
  const repairsNeeded = !!r?.json_fix || (checks?.issues.length ?? 0) > 0 || mcpDropped.length > 0
  const selfChecks = r?.self_checks ?? []

  let step = 0
  const n = () => ++step

  return (
    <section className={styles.report} aria-label="How this agent was made">
      {r ? (
        <ol className={styles.steps}>
          <li className={styles.step}>
            <h4 className={styles.stepTitle}><span className={styles.num}>{n()}</span>The brief</h4>
            <p>
              Asked for a {r.agent_type ? `${AGENT_TYPE_LABEL[r.agent_type] ?? r.agent_type} ` : ''}agent
              {r.has_image ? ', with an attached image to take into account' : ''}:
            </p>
            <blockquote className={styles.quote}>{config.purpose}</blockquote>
          </li>

          <li className={styles.step}>
            <h4 className={styles.stepTitle}><span className={styles.num}>{n()}</span>Grounding</h4>
            {grounding.length > 0 ? (
              <>
                <p>
                  Found {grounding.length} similar past agent{grounding.length === 1 ? '' : 's'} by meaning
                  (embedding search over earlier bootstraps) and showed {grounding.length === 1 ? 'it' : 'them'} to
                  the model as examples of a well-scoped tool set, not something to copy:
                </p>
                <ul className={styles.list}>
                  {grounding.map((g, i) => (
                    <li key={i}>
                      “{g.purpose}”
                      {typeof g.similarity === 'number' && <span className={styles.meta}> · {Math.round(g.similarity * 100)}% match</span>}
                      {g.tools && g.tools.length > 0 && <span className={styles.meta}> · tools: {g.tools.join(', ')}</span>}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>No similar past agent was close enough to use as an example, so it was designed from scratch.</p>
            )}
            <p>
              {catalog.length > 0
                ? <>It was also offered {catalog.length} real, vetted MCP tool{catalog.length === 1 ? '' : 's'} to pick from instead of writing its own: <span className={styles.meta}>{catalog.join(', ')}</span>.</>
                : 'No vetted MCP tools were available, so any tool it needed had to be written.'}
            </p>
          </li>

          <li className={styles.step}>
            <h4 className={styles.stepTitle}><span className={styles.num}>{n()}</span>Design</h4>
            <p>
              {modelName(r.design?.provider ?? r.requested?.provider, r.design?.model ?? r.requested?.model)} wrote the
              whole agent in one call: a persona{r.design?.persona ? ` (${r.design.persona})` : ''}, a system prompt
              {proposed.length > 0 ? ` and ${proposed.length} tool${proposed.length === 1 ? '' : 's'}:` : ', and no tools of its own.'}
            </p>
            {proposed.length > 0 && (
              <ul className={styles.list}>
                {proposed.map((t, i) => (
                  <li key={i}>
                    <code>{t.name}</code> <span className={styles.meta}>· {sourceLabel(t.source)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>

          <li className={styles.step}>
            <h4 className={styles.stepTitle}><span className={styles.num}>{n()}</span>Checks and repairs</h4>
            <p>
              Before anything runs, code checks the result: valid JSON, every tool’s Python compiles, no call to a
              function that won’t exist inside the sandbox, no invented localhost service, no fake “saved” result, and
              every MCP tool matches a real one.
            </p>
            {!repairsNeeded && <p>Everything passed first time.</p>}
            {r.json_fix && (
              <p>
                The reply wasn’t valid JSON ({r.json_fix.error}). It was sent back once with the error,
                and {r.json_fix.fixed ? 'the corrected version parsed.' : 'still failed.'}
              </p>
            )}
            {checks && checks.issues.length > 0 && (
              <>
                <p>Tool code problems found, sent back to the model once to fix:</p>
                <IssueList issues={checks.issues} />
                {fixedIssues.length > 0 && remaining.size === 0 && <p>All of them were fixed on the retry.</p>}
                {dropped.length > 0 && (
                  <p>
                    Still broken after the retry, so dropped rather than shipped:{' '}
                    {dropped.map(d => <code key={d} className={styles.inlineCode}>{d}</code>)}
                  </p>
                )}
              </>
            )}
            {mcpDropped.length > 0 && (
              <p>
                Dropped MCP tool references that don’t exist in the vetted catalog:{' '}
                {mcpDropped.map(d => <code key={d} className={styles.inlineCode}>{d}</code>)}
              </p>
            )}
            {(r.spec_notes ?? []).length > 0 && (
              <>
                <p>Your Advanced Setup rules were then enforced in code:</p>
                <ul className={styles.list}>
                  {r.spec_notes!.map((note, i) => <li key={i}>{note}</li>)}
                </ul>
              </>
            )}
          </li>

          <li className={styles.step}>
            <h4 className={styles.stepTitle}><span className={styles.num}>{n()}</span>The agent</h4>
            {config.persona ? (
              <p>
                <strong>{config.persona.name}</strong>
                {config.persona.traits.length > 0 && <span className={styles.meta}> · {config.persona.traits.join(', ')}</span>}
                {config.persona.rationale && <><br />{config.persona.rationale}</>}
              </p>
            ) : (
              <p>No usable persona came back, so it was given a placeholder name.</p>
            )}
            <details className={styles.details}>
              <summary>System prompt it wrote for itself ({config.system_prompt.length.toLocaleString()} characters)</summary>
              <pre className={styles.pre}>{config.system_prompt}</pre>
            </details>
            {tools.length > 0 ? (
              <ul className={styles.toolList}>
                {tools.map(t => (
                  <li key={t.name}>
                    <code>{t.name}</code>{' '}
                    <span className={styles.meta}>
                      · {t.source === 'mcp' ? `vetted MCP tool (${t.mcp_server}/${t.mcp_tool})` : sourceLabel(t.implementation ? 'generated' : t.source)}
                    </span>
                    <div className={styles.toolDesc}>{t.description}</div>
                    {t.implementation && (
                      <details className={styles.details}>
                        <summary>Code (runs in an isolated sandbox process)</summary>
                        <pre className={styles.pre}>{t.implementation}</pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p>It has no tools of its own.</p>
            )}
            <p className={styles.meta}>
              Built-in tools (page fetch, image search{config.template === 'job_search' ? ', job search' : ''}) and
              delegation to worker agents are added at run time, not designed here.
              {proposed.some(t => t.name && !finalNames.has(t.name)) && ' Tools listed under Design but missing here were removed by the checks above.'}
            </p>
          </li>

          <li className={styles.step}>
            <h4 className={styles.stepTitle}><span className={styles.num}>{n()}</span>Self-checks</h4>
            {selfChecks.length > 0 ? (
              <ul className={styles.list}>
                {selfChecks.map((c, i) => (
                  <li key={i}>
                    <span className={c.passed ? styles.pass : styles.fail}>{c.passed ? 'Passed' : 'Flagged'}</span>{' '}
                    {checkLabel(c.check)}
                    {c.reason && <span className={styles.meta}> · {c.reason}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No self-checks were recorded.</p>
            )}
          </li>

          <li className={styles.step}>
            <h4 className={styles.stepTitle}><span className={styles.num}>{n()}</span>Memory</h4>
            <p>
              {r.memory === 'recorded'
                ? 'Saved as an example for future agents with a similar purpose, so the next one starts grounded.'
                : 'Not saved as an example: its tools were restricted on purpose, and it would teach unrestricted agents the wrong tool set.'}
            </p>
          </li>
        </ol>
      ) : (
        <p className={styles.meta}>This agent was made before step-by-step reports existed. Timings only:</p>
      )}

      {trace.length > 0 && (
        <>
          <h4 className={styles.timingTitle}>Timings</h4>
          <CaseFile spans={trace} />
        </>
      )}
    </section>
  )
}

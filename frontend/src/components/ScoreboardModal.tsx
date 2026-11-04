import { useEffect, useRef, useState } from 'react'
import type { ArmStat } from '../types'
import { fetchModelInfo } from '../api'
import styles from '../styles/ScoreboardModal.module.css'

// Showcase Goal 2: "publish numbers, not claims". eval_harness.py --publish
// writes frontend/public/eval-scoreboard.json (fixed cases, every arm on the
// same inputs, chat-turn tools replayed from tape); this shows it next to
// what the live bandit (bandit.py, via GET /models) would pick from real
// traffic, so the two can be compared honestly.

interface CheckTally { passed: number; total: number }

interface ScoreArm {
  arm: string
  provider: string
  model: string | null
  runs: number
  pass_all: CheckTally
  checks: Record<string, CheckTally>
  median_seconds: number
  mean_tokens_in: number
  mean_tokens_out: number
  cost_per_task: number | null
  fallback_runs: number
  replay: Record<string, number> | null
}

interface ScoreSuite {
  generated_at: string
  cases: number
  repeats: number
  judge: string | null
  arms: ScoreArm[]
}

interface ScoreboardFile {
  updated?: string
  suites: Partial<Record<'bootstrap' | 'chat', ScoreSuite>>
}

const SUITE_LABELS: Record<'chat' | 'bootstrap', string> = {
  chat: 'Chat turns',
  bootstrap: 'Agent design (bootstrap)',
}

interface Props {
  isOpen: boolean
  onClose: () => void
}

function rate(t: CheckTally | undefined): number | null {
  return t && t.total > 0 ? t.passed / t.total : null
}

function pct(t: CheckTally | undefined): string {
  const r = rate(t)
  return r === null ? '—' : `${Math.round(r * 100)}%`
}

// "20261104-232645" → "4 Nov 2026, 23:26"
function stampLabel(stamp: string | undefined): string {
  const m = stamp?.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/)
  if (!m) return stamp ?? ''
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function cost(c: number | null): string {
  if (c === null) return '—'
  if (c === 0) return 'free (local)'
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(3)}`
}

function checkLabel(name: string): string {
  return name.replace(/^case:/, 'case · ').replace(/_/g, ' ')
}

// bandit.py's arms are (provider, model) with Gemini's model filled in by
// llm_client; the harness labels Gemini by provider alone.
function sameArm(a: ScoreArm, provider: string, model: string): boolean {
  if (a.provider !== provider) return false
  return provider === 'gemini' || !a.model || a.model === model
}

export default function ScoreboardModal({ isOpen, onClose }: Props) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const [board, setBoard] = useState<ScoreboardFile | null | 'missing'>(null)
  const [suite, setSuite] = useState<'chat' | 'bootstrap'>('chat')
  const [recommended, setRecommended] = useState<{ provider: string; model: string } | null>(null)
  const [armStats, setArmStats] = useState<ArmStat[]>([])

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
    setBoard(null)
    fetch(`${import.meta.env.BASE_URL}eval-scoreboard.json`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((data: ScoreboardFile) => {
        if (cancelled) return
        setBoard(data)
        if (!data.suites?.chat && data.suites?.bootstrap) setSuite('bootstrap')
      })
      .catch(() => { if (!cancelled) setBoard('missing') })
    fetchModelInfo().then(info => {
      if (cancelled) return
      setRecommended(info.recommended)
      setArmStats(info.armStats)
    })
    return () => { cancelled = true }
  }, [isOpen])

  if (!isOpen) return null

  const current = board && board !== 'missing' ? board.suites?.[suite] : undefined
  const arms = current?.arms ?? []
  const checkNames: string[] = []
  for (const a of arms) for (const name of Object.keys(a.checks)) if (!checkNames.includes(name)) checkNames.push(name)
  const leader = [...arms].sort((a, b) => (rate(b.pass_all) ?? -1) - (rate(a.pass_all) ?? -1))[0]
  const banditArm = recommended ? arms.find(a => sameArm(a, recommended.provider, recommended.model)) : undefined

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scoreboard-title"
        onClick={e => e.stopPropagation()}
      >
        <span className={styles.dossierTab} aria-hidden="true">Field Trials</span>
        <div className={styles.header}>
          <span id="scoreboard-title" className={styles.title}>Scoreboard</span>
          <button ref={closeBtnRef} type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close scoreboard">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.intro}>
            Every model gets the same fixed cases. Chat-turn tools are recorded once and replayed,
            so every model sees the same web pages, listings and tool results.
          </p>

          {board === null && <p className={styles.hint}>Loading…</p>}
          {board === 'missing' && (
            <p className={styles.hint}>
              No published results yet. Run <code>eval_harness.py --publish</code>.
            </p>
          )}

          {board && board !== 'missing' && (
            <>
              <div className={styles.tabs} role="tablist">
                {(['chat', 'bootstrap'] as const).map(id => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={suite === id}
                    className={suite === id ? styles.tabActive : styles.tab}
                    onClick={() => setSuite(id)}
                    disabled={!board.suites?.[id]}
                  >
                    {SUITE_LABELS[id]}
                  </button>
                ))}
              </div>

              {!current && <p className={styles.hint}>This suite hasn’t been published yet.</p>}

              {current && (
                <>
                  <p className={styles.meta}>
                    {current.cases} cases × {current.repeats} runs per model · judged by{' '}
                    {current.judge ?? 'each model itself'} · {stampLabel(current.generated_at)}
                  </p>

                  {(leader || recommended) && (
                    <div className={styles.verdict}>
                      {leader && (
                        <p>
                          <span className={styles.verdictLabel}>Eval leader</span>
                          <strong>{leader.arm}</strong>, which passed every check on {pct(leader.pass_all)} of runs
                        </p>
                      )}
                      {recommended && (
                        <p>
                          <span className={styles.verdictLabel}>Live bandit pick</span>
                          <strong>{recommended.provider === 'gemini' ? 'gemini' : `${recommended.provider}:${recommended.model}`}</strong>
                          {banditArm
                            ? banditArm === leader
                              ? '. It agrees with the eval.'
                              : `. In these trials it passed every check on ${pct(banditArm.pass_all)} of runs.`
                            : '. Not among the models tested here.'}
                        </p>
                      )}
                    </div>
                  )}

                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">Check</th>
                          {arms.map(a => <th key={a.arm} scope="col">{a.arm}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        <tr className={styles.totalRow}>
                          <th scope="row">All deterministic checks</th>
                          {arms.map(a => <td key={a.arm}>{pct(a.pass_all)}</td>)}
                        </tr>
                        {checkNames.map(name => (
                          <tr key={name}>
                            <th scope="row">{checkLabel(name)}</th>
                            {arms.map(a => {
                              const r = rate(a.checks[name])
                              return (
                                <td key={a.arm} className={r !== null && r < 0.7 ? styles.low : undefined}>
                                  {pct(a.checks[name])}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                        <tr className={styles.sectionRow}>
                          <th scope="row">Median time</th>
                          {arms.map(a => <td key={a.arm}>{a.median_seconds.toFixed(1)} s</td>)}
                        </tr>
                        <tr>
                          <th scope="row">Tokens in / out</th>
                          {arms.map(a => <td key={a.arm}>{a.mean_tokens_in.toLocaleString()} / {a.mean_tokens_out.toLocaleString()}</td>)}
                        </tr>
                        <tr>
                          <th scope="row">Cost per task</th>
                          {arms.map(a => <td key={a.arm}>{cost(a.cost_per_task)}</td>)}
                        </tr>
                        {armStats.length > 0 && (
                          <tr>
                            <th scope="row">Live pass rate (bandit)</th>
                            {arms.map(a => {
                              const s = armStats.find(st => sameArm(a, st.provider, st.model))
                              return <td key={a.arm}>{s && s.pulls > 0 && s.rate !== null ? `${Math.round(s.rate * 100)}% of ${s.pulls}` : '—'}</td>
                            })}
                          </tr>
                        )}
                        {suite === 'chat' && (
                          <tr>
                            <th scope="row">Tool calls off tape</th>
                            {arms.map(a => {
                              const r = a.replay ?? {}
                              const total = (r.exact ?? 0) + (r.fuzzy ?? 0) + (r.miss ?? 0)
                              return <td key={a.arm}>{total ? `${r.exact ?? 0} exact · ${r.fuzzy ?? 0} near · ${r.miss ?? 0} missed` : '—'}</td>
                            })}
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {arms.some(a => a.fallback_runs > 0) && (
                    <p className={styles.hint}>
                      Some runs were served by a fallback provider, so those runs don’t reflect the model named in their column.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

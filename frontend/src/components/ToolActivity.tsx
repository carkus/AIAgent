import { useState } from 'react'
import { fetchFile } from '../api'
import type { ToolCall } from '../types'
import styles from '../styles/ToolActivity.module.css'

interface Props {
  toolCalls: ToolCall[]
  live?: boolean
  location?: string
}

// ─── Parsers & helpers ────────────────────────────────────────────────────────

function parseResult(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

function formatSalaryRange(min: number | null, max: number | null): string {
  const fmt = (v: number) => '$' + Math.round(v / 1000) + 'k'
  if (min && max) return `${fmt(min)}–${fmt(max)}`
  if (min) return `${fmt(min)}+`
  if (max) return `up to ${fmt(max)}`
  return ''
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return '' }
}

function isJobObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return typeof o.title === 'string' && (typeof o.company === 'string' || typeof o.employer === 'string')
}

interface JobData {
  totalCount?: number
  returned?: number
  meanSalary?: number
  listings: Record<string, unknown>[]
}

function normaliseJobData(obj: Record<string, unknown>): JobData | null {
  if (Array.isArray(obj.listings) && obj.listings.length > 0 && isJobObject(obj.listings[0])) {
    return {
      totalCount: obj.total_count as number | undefined,
      returned: obj.returned as number | undefined,
      meanSalary: obj.mean_salary as number | undefined,
      listings: obj.listings as Record<string, unknown>[],
    }
  }
  for (const key of ['jobs', 'results', 'data'] as const) {
    const arr = obj[key]
    if (Array.isArray(arr) && arr.length > 0 && isJobObject(arr[0])) {
      return {
        totalCount: (obj.total_count ?? obj.totalCount ?? obj.count) as number | undefined,
        returned: arr.length,
        meanSalary: obj.mean_salary as number | undefined,
        listings: arr as Record<string, unknown>[],
      }
    }
  }
  if (isJobObject(obj)) return { listings: [obj], returned: 1 }
  return null
}

function extractKeyword(inputs: Record<string, unknown>): string | undefined {
  const fromField = (
    inputs.keyword ?? inputs.keywords ?? inputs.query ?? inputs.what ??
    inputs.search_term ?? inputs.search ?? inputs.term ?? inputs.title ??
    inputs.job_title ?? inputs.search_query ?? inputs.skill ?? inputs.q ??
    inputs.tags ?? inputs.tech ?? inputs.technology ?? inputs.role
  )
  if (typeof fromField === 'string') return fromField
  if (Array.isArray(fromField)) return (fromField as string[]).join(' ')
  return Object.values(inputs).find(
    v => typeof v === 'string' && v.length > 1 && v.length < 80
  ) as string | undefined
}

function keywordMatches(job: Record<string, unknown>, keyword: string): boolean {
  const title = ((job.title ?? '') as string).toLowerCase()
  const desc = [job.description, job.snippet, job.summary, job.excerpt]
    .filter(Boolean).join(' ').toLowerCase()
  const kw = keyword.toLowerCase().trim()
  if (title.includes(kw)) return true
  const words = kw.split(/\s+/).filter(w => w.length > 2)
  if (words.length === 0) return title.includes(kw) || desc.includes(kw)
  if (words.some(w => title.includes(w))) return true
  return words.every(w => desc.includes(w))
}

function locationOk(job: Record<string, unknown>, location: string): boolean {
  const loc = ((job.location ?? '') as string).toLowerCase()
  if (!loc) return true
  if (/^(remote|worldwide|global|anywhere)$/.test(loc)) return true
  const parts = location.toLowerCase().split(/[\s,]+/).filter(p => p.length > 2)
  return parts.some(p => loc.includes(p))
}

function extractListingsFromResult(raw: string): Record<string, unknown>[] {
  const data = parseResult(raw)
  if (Array.isArray(data) && data.length > 0 && isJobObject(data[0])) {
    return data as Record<string, unknown>[]
  }
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const jobData = normaliseJobData(data as Record<string, unknown>)
    return jobData?.listings ?? []
  }
  return []
}

function extractMarketData(raw: string): Record<string, unknown> | null {
  const data = parseResult(raw)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>
  if ('total_openings' in obj && 'seniority_mix' in obj) return obj
  if ('salary_stats' in obj) return obj
  return null
}

function isEmptyResult(raw: string): boolean {
  const data = parseResult(raw)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const obj = data as Record<string, unknown>
  return Array.isArray(obj.results) && (obj.results as unknown[]).length === 0
}

function isErrorResult(raw: string): boolean {
  return typeof raw === 'string' && raw.startsWith('Tool execution error')
}

function isBlockedResult(raw: string): boolean {
  const data = parseResult(raw)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const obj = data as Record<string, unknown>
  const code = typeof obj.status_code === 'number' ? obj.status_code
    : typeof obj.status === 'number' ? obj.status : null
  return code !== null && (code === 401 || code === 403 || code === 404 || code === 429)
}

function isWorkerResult(v: unknown): v is Record<string, unknown> & { worker_name: string; response: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return typeof o.worker_name === 'string' && typeof o.response === 'string'
}

function extractSavedFile(raw: string): string | null {
  const data = parseResult(raw)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>
  if (obj.status === 'saved' && obj.filename) return obj.filename as string
  return null
}

// ─── Live view: individual tool pills ─────────────────────────────────────────

function InputSummary({ inputs }: { inputs: Record<string, unknown> }) {
  return (
    <span className={styles.inputPills}>
      {Object.entries(inputs).map(([k, v]) => {
        let display: string
        if (Array.isArray(v)) display = `[${v.length} items]`
        else {
          const s = String(v)
          display = s.length > 60 ? s.slice(0, 60) + '…' : s
        }
        return (
          <span key={k} className={styles.pill}>
            <span className={styles.pillKey}>{k}</span>
            <span className={styles.pillVal}>{display}</span>
          </span>
        )
      })}
    </span>
  )
}

// ─── Job listing card ─────────────────────────────────────────────────────────

// Adzuna doesn't return a structured tech-stack field, so we derive one by
// scanning the listing's own text for recognised technology names. Heuristic,
// not authoritative — "if possible" is the operative word here.
const TECH_KEYWORDS = [
  // Languages
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'C++', 'Golang', 'Go', 'Rust', 'Ruby',
  'PHP', 'Swift', 'Kotlin', 'Scala', 'Elixir', 'Haskell', 'Dart', 'Objective-C',
  // Frontend
  'React', 'Angular', 'Vue', 'Svelte', 'Next.js', 'Redux', 'jQuery', 'Tailwind', 'Bootstrap',
  // Backend / frameworks
  '.NET', 'ASP.NET', 'Node.js', 'Express', 'Django', 'Flask', 'FastAPI', 'Spring Boot', 'Spring',
  'Rails', 'Laravel', 'Symfony', 'NestJS',
  // Data / DB
  'SQL', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'DynamoDB', 'SQLite',
  'Oracle', 'Cassandra', 'GraphQL',
  // Cloud / infra
  'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'CI/CD', 'Ansible', 'Linux',
  // AI/ML
  'TensorFlow', 'PyTorch', 'Pandas', 'NumPy', 'Scikit-learn', 'LangChain', 'OpenAI',
] as const

const TECH_REGEXES = TECH_KEYWORDS.map(
  kw => [kw, new RegExp(`(?<![A-Za-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i')] as const
)

function extractTechStack(job: Record<string, unknown>): string[] {
  const text = [job.title, job.description, job.snippet, job.summary, job.excerpt]
    .filter(v => typeof v === 'string')
    .join(' ')
  if (!text) return []
  const found: string[] = []
  for (const [label, re] of TECH_REGEXES) {
    if (re.test(text)) found.push(label)
  }
  return found.slice(0, 8) // keep the card compact
}

function JobCard({ job }: { job: Record<string, unknown> }) {
  const url = (job.redirect_url ?? job.url ?? job.apply_url ?? job.link) as string | undefined
  const snippet = (job.snippet ?? job.description ?? job.summary ?? job.excerpt) as string | undefined
  const company = (job.company ?? job.employer ?? job.company_name) as string | undefined
  const salaryLabel = formatSalaryRange(job.salary_min as number | null, job.salary_max as number | null)
  const meta = [company, job.location, formatDate(job.created as string)].filter(Boolean).join(' · ')
  const techStack = extractTechStack(job)

  return (
    <div className={styles.jobCard}>
      <div className={styles.jobTitleRow}>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className={styles.jobTitle}>
            {job.title as string}
          </a>
        ) : (
          <span className={styles.jobTitle}>{job.title as string}</span>
        )}
        {salaryLabel && <span className={styles.salaryChip}>{salaryLabel}</span>}
      </div>
      {meta && <p className={styles.jobMeta}>{meta}</p>}
      {techStack.length > 0 && (
        <div className={styles.jobTechRow}>
          {techStack.map(t => <span key={t} className={styles.techChip}>{t}</span>)}
        </div>
      )}
      {snippet && (
        <p className={styles.jobSnippet}>
          {snippet.length > 220 ? snippet.slice(0, 220) + '…' : snippet}
        </p>
      )}
    </div>
  )
}

// ─── Market trend card ────────────────────────────────────────────────────────

function MarketTrendCard({ data }: { data: Record<string, unknown> }) {
  const keyword = data.keyword as string | undefined
  const totalOpenings = data.total_openings as number | undefined
  const topSkills = (data.top_skills as [string, number][] | undefined) ?? []
  const seniorityRaw = (data.seniority_mix as Record<string, number> | undefined) ?? {}
  const topCompanies = (data.top_companies as [string, number][] | undefined) ?? []
  const contractRaw = (data.contract_breakdown as Record<string, number> | undefined) ?? {}

  const seniority = Object.entries(seniorityRaw)
    .filter(([k]) => k !== 'unspecified')
    .sort((a, b) => b[1] - a[1])
  const maxSeniority = Math.max(...seniority.map(([, n]) => n), 1)

  const contracts = Object.entries(contractRaw)
    .filter(([k]) => k !== 'unspecified' && k !== 'unknown')
    .sort((a, b) => b[1] - a[1])

  return (
    <div className={styles.marketCard}>
      {keyword && (
        <p className={styles.marketHeading}>
          {keyword}
          {totalOpenings !== undefined && <span className={styles.marketCount}> · {totalOpenings} openings</span>}
        </p>
      )}

      <div className={styles.marketGrid}>
        {/* Seniority */}
        {seniority.length > 0 && (
          <div className={styles.marketSection}>
            <p className={styles.marketSectionLabel}>Seniority</p>
            {seniority.map(([level, count]) => (
              <div key={level} className={styles.barRow}>
                <span className={styles.barLabel}>{level}</span>
                <meter
                  className={styles.barMeter}
                  value={count}
                  max={maxSeniority}
                />
                <span className={styles.barCount}>{count}</span>
              </div>
            ))}
          </div>
        )}

        {/* Top companies */}
        {topCompanies.length > 0 && (
          <div className={styles.marketSection}>
            <p className={styles.marketSectionLabel}>Top companies</p>
            {topCompanies.slice(0, 8).map(([name, count]) => (
              <div key={name} className={styles.companyRow}>
                <span className={styles.companyName}>{name}</span>
                <span className={styles.companyCount}>{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {topSkills.length > 0 && (
        <div className={styles.skillsRow}>
          <span className={styles.marketSectionLabel}>Skills&thinsp;</span>
          {topSkills.map(([skill]) => (
            <span key={skill} className={styles.skillPill}>{skill}</span>
          ))}
        </div>
      )}

      {contracts.length > 0 && (
        <p className={styles.contractLine}>
          {contracts.map(([type, count]) => (
            <span key={type} className={styles.contractChip}>
              {type.replace(/_/g, ' ')} {count}
            </span>
          ))}
        </p>
      )}

      {/* Salary note */}
      {'salary_stats' in data && Object.keys(data.salary_stats as object).length === 0 && (
        <p className={styles.noResults}>{String(data.note ?? 'No salary data available.')}</p>
      )}
    </div>
  )
}

// ─── Delegated worker result (multi-agent orchestration, first scaffold) ─────

function WorkerResultCard({ data }: { data: Record<string, unknown> }) {
  const name = data.worker_name as string
  const traits = (data.worker_traits as string[] | undefined) ?? []
  const task = data.task as string | undefined
  const response = data.response as string
  const toolsUsed = (data.tools_used as string[] | undefined) ?? []

  return (
    <div className={styles.workerCard}>
      <p className={styles.workerHeading}>
        <span className={styles.workerName}>🤝 {name}</span>
        {traits.length > 0 && (
          <span className={styles.workerTraits}>{traits.join(' · ')}</span>
        )}
      </p>
      {task && <p className={styles.workerTask}>{task}</p>}
      {response && <p className={styles.workerResponse}>{response}</p>}
      {toolsUsed.length > 0 && (
        <p className={styles.workerTools}>
          {toolsUsed.map((t, i) => <span key={i} className={styles.pill}><span className={styles.pillVal}>{t}</span></span>)}
        </p>
      )}
    </div>
  )
}

// ─── Saved file viewer ────────────────────────────────────────────────────────

function SavedFileViewer({ filename }: { filename: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function open() {
    setLoading(true); setErr(null)
    try { setContent(await fetchFile(filename)) }
    catch { setErr('Could not load file.') }
    finally { setLoading(false) }
  }

  return (
    <div>
      <div className={styles.savedFileRow}>
        <span className={styles.savedFileIcon}>📄</span>
        <button type="button" className={styles.savedFileBtn} onClick={open} disabled={loading}>
          {loading ? 'Loading…' : filename}
        </button>
        {err && <span className={styles.savedFileErr}>{err}</span>}
      </div>
      {content !== null && (
        <div className={styles.fileModal} onClick={() => setContent(null)}>
          <div className={styles.fileModalInner} onClick={e => e.stopPropagation()}>
            <div className={styles.fileModalHeader}>
              <span className={styles.fileModalName}>{filename}</span>
              <button type="button" className={styles.fileModalClose} onClick={() => setContent(null)}>×</button>
            </div>
            <pre className={styles.fileModalContent}>{content}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Keyword section (completed view) ────────────────────────────────────────

function KeywordSection({
  keyword, toolCalls, location,
}: {
  keyword: string
  toolCalls: ToolCall[]
  location?: string
}) {
  // Collect all listings across tool calls for this keyword, deduplicated
  const seen = new Set<string>()
  const allListings = toolCalls.flatMap(tc => extractListingsFromResult(tc.result))
  const unique = allListings.filter(job => {
    const key = `${job.title}|${job.company}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })

  // Filter
  const filtered = unique
    .filter(job => keywordMatches(job, keyword))
    .filter(job => !location || locationOk(job, location))
  const hidden = unique.length - filtered.length

  // Market / salary data
  const marketResults = toolCalls
    .map(tc => extractMarketData(tc.result))
    .filter(Boolean) as Record<string, unknown>[]

  // Saved files
  const savedFiles = toolCalls
    .map(tc => extractSavedFile(tc.result))
    .filter(Boolean) as string[]

  const hasStructured = filtered.length > 0 || marketResults.length > 0 || savedFiles.length > 0
  const allEmpty = !hasStructured && toolCalls.every(tc => isEmptyResult(tc.result) || isErrorResult(tc.result) || isBlockedResult(tc.result))
  if (allEmpty) return null

  return (
    <div className={styles.kwSection}>
      <p className={styles.kwHeading}>
        {/^https?:\/\//i.test(keyword) ? (
          <a href={keyword} target="_blank" rel="noreferrer" className={styles.kwLink}>
            {keyword.replace(/^https?:\/\//, '').slice(0, 70)}
            {keyword.replace(/^https?:\/\//, '').length > 70 ? '…' : ''}
          </a>
        ) : (
          keyword.length > 70 ? keyword.slice(0, 70) + '…' : keyword
        )}
        {filtered.length > 0 && (
          <span className={styles.kwCount}>
            {' '}{filtered.length} listing{filtered.length !== 1 ? 's' : ''}
            {hidden > 0 && <span className={styles.filteredNote}> · {hidden} filtered</span>}
          </span>
        )}
      </p>

      {filtered.map((job, i) => <JobCard key={i} job={job} />)}
      {marketResults.map((d, i) => <MarketTrendCard key={i} data={d} />)}
      {savedFiles.map(f => <SavedFileViewer key={f} filename={f} />)}

      {!hasStructured && toolCalls.map((tc, i) => (
        <div key={i} className={styles.rawEntry}>
          {toolCalls.length > 1 && (
            <span className={styles.toolName}>{tc.tool}</span>
          )}
          {tc.source === 'mcp' && <span className={styles.mcpBadge}>🔌 MCP</span>}
          <RawResult result={tc.result} />
        </div>
      ))}
    </div>
  )
}

// ─── Raw result fallback renderer ────────────────────────────────────────────

function RawResult({ result }: { result: string }) {
  const data = parseResult(result)

  // Bare number — treat as HTTP status code
  if (typeof data === 'number') {
    const ok = data >= 200 && data < 300
    return (
      <span className={ok ? styles.httpOk : styles.httpErr}>
        {data}{ok ? ' OK' : ''}
      </span>
    )
  }

  if (typeof data === 'string') {
    if (data.startsWith('Tool execution error')) {
      return <pre className={styles.errorText}>{data}</pre>
    }
    // Bare status-code string ("200", "403")
    if (/^\d{3}$/.test(data.trim())) {
      const code = parseInt(data.trim())
      const ok = code >= 200 && code < 300
      return <span className={ok ? styles.httpOk : styles.httpErr}>{code}{ok ? ' OK' : ''}</span>
    }
    return <pre className={styles.plainResult}>{data}</pre>
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>

  // ── Delegated worker result (delegate_to_worker) ──────────────────────────
  if (isWorkerResult(obj)) return <WorkerResultCard data={obj} />

  // ── Search / web-results pattern ──────────────────────────────────────────
  if (Array.isArray(obj.results)) {
    const results = obj.results as Record<string, unknown>[]
    if (results.length === 0) {
      return (
        <p className={styles.noResults}>
          {obj.query ? `No results for "${obj.query as string}"` : 'No results'}
        </p>
      )
    }
    return (
      <div>
        {results.map((r, i) => (
          <div key={i} className={styles.searchResult}>
            {r.url ? (
              <a href={r.url as string} target="_blank" rel="noreferrer" className={styles.resultTitle}>
                {(r.title ?? r.url) as string}
              </a>
            ) : (
              <span className={styles.resultTitle}>{r.title as string}</span>
            )}
            {Boolean(r.snippet) && <p className={styles.resultSnippet}>{r.snippet as string}</p>}
          </div>
        ))}
      </div>
    )
  }

  // ── Term-frequency / text-analysis pattern ────────────────────────────────
  if (obj.ranked_terms || obj.term_frequencies) {
    const ranked = (obj.ranked_terms as [string, number][] | undefined) ?? []
    const salaries = (obj.salary_mentions as string[] | undefined) ?? []
    const wordCount = obj.word_count as number | undefined
    const active = ranked.filter(([, n]) => n > 0)

    return (
      <div>
        {wordCount !== undefined && (
          <p className={styles.analysisNote}>{wordCount.toLocaleString()} words analysed</p>
        )}
        {active.length > 0 && (
          <div className={styles.termPills}>
            {active.map(([term, count]) => (
              <span key={term} className={styles.termPill}>
                {term}<span className={styles.termCount}>{count}</span>
              </span>
            ))}
          </div>
        )}
        {salaries.length > 0 && (
          <div className={styles.termPills}>
            <span className={styles.analysisNote}>Salaries mentioned&ensp;</span>
            {[...new Set(salaries)].map(s => (
              <span key={s} className={styles.salaryCapsule}>${s}</span>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── String status (saved / error) ─────────────────────────────────────────
  if (typeof obj.status === 'string') {
    const isError = obj.status === 'error' || obj.status === 'no_credentials'
    return (
      <div className={`${styles.statusBox} ${isError ? styles.statusBoxError : styles.statusBoxSuccess}`}>
        <span className={`${styles.statusLabel} ${isError ? styles.statusLabelError : styles.statusLabelSuccess}`}>
          {obj.status}
        </span>
        {Boolean(obj.message) && <p className={styles.statusMessage}>{String(obj.message)}</p>}
      </div>
    )
  }

  // ── Fetch result: {status_code|status (number), url, ...} ───────────────
  const httpCode = typeof obj.status_code === 'number' ? obj.status_code
    : typeof obj.status === 'number' ? obj.status : null
  if (httpCode !== null && typeof obj.url === 'string') {
    const ok = httpCode >= 200 && httpCode < 300
    const displayUrl = obj.url.replace(/^https?:\/\//, '')
    const listingCount = typeof obj.listing_count === 'number' ? obj.listing_count : null
    return (
      <div className={styles.fetchResult}>
        <span className={ok ? styles.httpOk : styles.httpErr}>{httpCode}</span>
        <a href={obj.url} target="_blank" rel="noreferrer" className={styles.fetchUrl}>
          {displayUrl}
        </a>
        {ok && listingCount !== null && (
          <span className={styles.listingCount}>{listingCount.toLocaleString()} listings</span>
        )}
        {Boolean(obj.truncated || obj.char_count) && (
          <span className={styles.truncatedNote}>
            {typeof obj.char_count === 'number' ? `${obj.char_count.toLocaleString()} chars` : 'truncated'}
          </span>
        )}
      </div>
    )
  }

  // ── Generic key-value pills ───────────────────────────────────────────────
  const SKIP_KV = new Set(['content', 'html', 'body', 'text', 'raw'])
  const entries = Object.entries(obj).filter(([k, v]) =>
    !SKIP_KV.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
  )
  if (entries.length > 0) {
    return (
      <div className={styles.kvPills}>
        {entries.map(([k, v]) => {
          const s = String(v)
          const isUrl = /^https?:\/\//i.test(s)
          return (
            <span key={k} className={styles.kvPill}>
              <span className={styles.kvKey}>{k}</span>
              {isUrl ? (
                <a href={s} target="_blank" rel="noreferrer" className={styles.kvValLink}>
                  {s.replace(/^https?:\/\//, '').slice(0, 60)}
                  {s.replace(/^https?:\/\//, '').length > 60 ? '…' : ''}
                </a>
              ) : (
                <span className={styles.kvVal}>{s}</span>
              )}
            </span>
          )
        })}
      </div>
    )
  }

  // ── Last resort: formatted JSON ───────────────────────────────────────────
  return <pre className={styles.plainResult}>{JSON.stringify(data, null, 2)}</pre>
}

// ─── Live: single tool call row ───────────────────────────────────────────────

function LiveToolRow({ tc, location }: { tc: ToolCall; location?: string }) {
  const keyword = extractKeyword(tc.inputs)
  const data = parseResult(tc.result)
  const isPending = tc.result === '…'

  // Job listings
  const listings = extractListingsFromResult(tc.result)
  const filtered = listings
    .filter(j => !keyword || keywordMatches(j, keyword))
    .filter(j => !location || locationOk(j, location))
  const hidden = listings.length - filtered.length

  // Market / saved
  const marketData = typeof data === 'object' && !Array.isArray(data) && data !== null
    ? extractMarketData(tc.result) : null
  const savedFile = typeof data === 'object' && !Array.isArray(data) && data !== null
    ? extractSavedFile(tc.result) : null

  const hasStructured = filtered.length > 0 || !!marketData || !!savedFile

  return (
    <div className={styles.entry}>
      <div className={styles.entryHeader}>
        <span className={styles.toolName}>{tc.tool}</span>
        {tc.source === 'mcp' && <span className={styles.mcpBadge}>🔌 MCP</span>}
        <InputSummary inputs={tc.inputs} />
      </div>
      {isPending && <p className={styles.pending}>Running…</p>}
      {!isPending && filtered.length > 0 && (
        <>
          <p className={styles.jobsSummary}>
            {filtered.length} listing{filtered.length !== 1 ? 's' : ''}
            {hidden > 0 && <span className={styles.filteredNote}> · {hidden} filtered</span>}
          </p>
          {filtered.map((job, i) => <JobCard key={i} job={job} />)}
        </>
      )}
      {!isPending && marketData && <MarketTrendCard data={marketData} />}
      {!isPending && savedFile && <SavedFileViewer filename={savedFile} />}
      {!isPending && !hasStructured && <RawResult result={tc.result} />}
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function ToolActivity({ toolCalls, live = false, location }: Props) {
  if (toolCalls.length === 0) return null

  if (live) {
    return (
      <div className={styles.container}>
        <p className={styles.heading}>
          Running · {toolCalls.length} call{toolCalls.length !== 1 ? 's' : ''}
          <span className={styles.liveDot} />
        </p>
        {toolCalls.map((tc, i) => <LiveToolRow key={i} tc={tc} location={location} />)}
      </div>
    )
  }

  // Completed: group by keyword
  const byKeyword = new Map<string, ToolCall[]>()
  const other: ToolCall[] = []

  for (const tc of toolCalls) {
    const kw = extractKeyword(tc.inputs)
    if (kw) {
      const key = kw.toLowerCase()
      if (!byKeyword.has(key)) byKeyword.set(key, [])
      byKeyword.get(key)!.push(tc)
    } else {
      other.push(tc)
    }
  }

  const savedFromOther = other
    .map(tc => extractSavedFile(tc.result))
    .filter(Boolean) as string[]
  const unsavedOther = other.filter(tc => !extractSavedFile(tc.result) && !isEmptyResult(tc.result) && !isErrorResult(tc.result) && !isBlockedResult(tc.result))

  return (
    <div className={styles.container}>
      <p className={styles.heading}>
        Tool activity · {toolCalls.length} call{toolCalls.length !== 1 ? 's' : ''}
      </p>

      {[...byKeyword.entries()].map(([kw, tcs]) => (
        <KeywordSection key={kw} keyword={kw} toolCalls={tcs} location={location} />
      ))}

      {savedFromOther.map(f => (
        <div key={f} className={styles.kwSection}>
          <SavedFileViewer filename={f} />
        </div>
      ))}

      {unsavedOther.map((tc, i) => <LiveToolRow key={i} tc={tc} location={location} />)}
    </div>
  )
}

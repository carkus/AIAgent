import type { AgentConfig, AgentSpec, AgentTemplateId, ArmStat, BootstrapStreamEvent, EvalResultItem, LlmProvider, RelicSuggestion, SavedChatMessage, StreamEvent } from './types';

const API_URL = import.meta.env.VITE_API_URL ?? '';

/**
 * Streams /bootstrap's NDJSON events (status/tool/done/error) — same framing
 * as runAgent() below — so the caller can show live progress instead of a
 * static "please wait". Resolves with the final AgentConfig on `done`,
 * rejects on `error` or a non-2xx response.
 */
export async function bootstrap(
  purpose: string,
  provider?: LlmProvider,
  ollamaModel?: string | null,
  onProgress?: (event: BootstrapStreamEvent) => void,
  agentType?: AgentTemplateId,
  signal?: AbortSignal,
  image?: string | null,
  spec?: AgentSpec,
): Promise<AgentConfig> {
  const res = await fetch(`${API_URL}/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      purpose,
      provider: provider ?? undefined,
      ollama_model: ollamaModel ?? undefined,
      agentType: agentType ?? undefined,
      image: image ?? undefined,
      spec: spec ?? undefined,
    }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Bootstrap failed');
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let config: AgentConfig | null = null;
  let errorMessage: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: BootstrapStreamEvent;
        try {
          event = JSON.parse(trimmed) as BootstrapStreamEvent;
        } catch {
          continue; // ignore malformed lines
        }
        onProgress?.(event);
        if (event.type === 'done') config = event.config;
        else if (event.type === 'error') errorMessage = event.message;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (errorMessage) throw new Error(errorMessage);
  if (!config) throw new Error('Bootstrap stream ended without a result');
  return config;
}

export interface AgentBrief {
  type: 'brief' | 'question';
  text: string;
  warning?: string | null;
  // Media the model offers for this commission (brief.py); built only on click.
  relics?: RelicSuggestion[];
}

// The commission and the agent on board, sent with a Brief-sourced relic so
// relic.py builds a case briefing rather than restating the brief text.
export interface RelicCase {
  agentType: string;
  keywords: string[];
  location: string;
  traits: string[];
  behaviors: string[];
  warning?: string | null;
}

/** Builds a relic offered by the Setup Brief, before the agent has run. */
export async function buildBriefRelic(
  suggestion: RelicSuggestion,
  brief: string,
  relicCase: RelicCase,
  agentName: string,
  provider?: LlmProvider,
  ollamaModel?: string | null,
): Promise<string> {
  const res = await fetch(`${API_URL}/relic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: suggestion.kind,
      reason: suggestion.reason,
      answer: brief,
      case: relicCase,
      agentName,
      agentConfig: { provider: provider ?? undefined, ollama_model: ollamaModel ?? undefined },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Failed to build relic');
  }
  const data = await res.json();
  return data.content;
}

/**
 * AI-drafted Setup screen "Brief" (backend/src/brief.py) — usually a short
 * paragraph interpreting the chosen specialties, occasionally a single
 * clarifying question when the pool is too ambiguous/sparse to interpret
 * confidently. `warning` is independent of that choice — it flags a
 * commissioning-time problem (too many specialties for the delegation cap,
 * unrelated domains, advice-as-fact requests, a location-dependent
 * specialty with no location) and can accompany either a brief or a
 * question. Pass `priorQuestion`/`priorAnswer` after the user answers a
 * question to get the model to write the brief using that guidance.
 * `behaviors`/`traits` are the active Behavior toggle / Personality trait
 * LABELS (e.g. "Max Delegation", "Meticulous") — the brief should actually
 * account for and mention them, not just the specialty keywords, since they
 * change what the agent will do just as much as a specialty does. Throws
 * on any failure — callers should fall back to the deterministic template
 * brief rather than surfacing this as a user-facing error.
 */
export async function fetchAgentBrief(
  agentType: AgentTemplateId | undefined,
  keywords: string[],
  location: string,
  agentName: string,
  provider?: LlmProvider,
  ollamaModel?: string | null,
  priorQuestion?: string | null,
  priorAnswer?: string | null,
  maxDelegations?: number | null,
  behaviors?: string[],
  traits?: string[],
): Promise<AgentBrief> {
  const res = await fetch(`${API_URL}/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentType,
      keywords,
      location,
      agentName,
      provider: provider ?? undefined,
      ollama_model: ollamaModel ?? undefined,
      priorQuestion: priorQuestion ?? undefined,
      priorAnswer: priorAnswer ?? undefined,
      maxDelegations: maxDelegations ?? undefined,
      behaviors: behaviors && behaviors.length > 0 ? behaviors : undefined,
      traits: traits && traits.length > 0 ? traits : undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Failed to generate brief');
  }
  return res.json();
}

/**
 * In-character "Previously…" recap of a resumed saved chat
 * (backend/src/recap.py), shown in AgentBriefingModal. Throws on any
 * failure — the caller falls back to the plain mission briefing.
 */
export async function fetchChatRecap(
  messages: SavedChatMessage[],
  agentConfig: AgentConfig,
  agentName: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${API_URL}/recap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Images are dropped — the recap only needs the text of the story so far.
    body: JSON.stringify({
      messages: messages.map(m => ({ role: m.role, content: m.content, displayContent: m.displayContent })),
      agentConfig,
      agentName,
    }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Failed to generate recap');
  }
  const data = await res.json();
  return data.text;
}

/**
 * Builds an output relic (backend/src/relic.py) from a finished answer, when
 * the user accepts one of the agent's suggestions or picks a kind from the
 * Export menu (reason empty). Returns the relic's text content; the caller
 * previews it and builds the downloaded file from it.
 */
export async function buildRelic(
  suggestion: RelicSuggestion,
  question: string,
  answer: string,
  workers: { name: string; task: string; response: string }[],
  agentConfig: AgentConfig,
  agentName: string,
): Promise<string> {
  const res = await fetch(`${API_URL}/relic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: suggestion.kind, reason: suggestion.reason, question, answer, workers, agentConfig, agentName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Failed to build relic');
  }
  const data = await res.json();
  return data.content;
}

/**
 * Names of models currently pulled in the developer's local Ollama install,
 * plus a UCB1 bandit recommendation (backend/src/bandit.py) computed from
 * eval_checks.py's recorded pass/fail history per (provider, model) arm.
 * `recommended`/`armStats` are informational only — the picker in
 * SettingsModal stays fully manual, this just badges the data-backed pick.
 */
export async function fetchModelInfo(): Promise<{
  models: string[]
  recommended: { provider: string; model: string } | null
  armStats: ArmStat[]
}> {
  try {
    const res = await fetch(`${API_URL}/models`);
    if (!res.ok) return { models: [], recommended: null, armStats: [] };
    const data = await res.json();
    return {
      models: Array.isArray(data.models) ? data.models : [],
      recommended: data.recommended ?? null,
      armStats: Array.isArray(data.arm_stats) ? data.arm_stats : [],
    };
  } catch {
    return { models: [], recommended: null, armStats: [] };
  }
}

export async function fetchFile(filename: string): Promise<string> {
  const res = await fetch(`${API_URL}/file/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error('File not found');
  const data = await res.json();
  return data.content as string;
}

export interface SavedSearch {
  id: string;
  name: string;
  keywords: string[];
  agentType?: AgentTemplateId | null;
}

/** Saved searches now live server-side (see backend/src/saved_searches.py) —
 * localStorage was scoped per dev-server port/origin, so a port change made
 * every prior save silently vanish. [] on any failure so a backend hiccup
 * degrades to "no saved searches" rather than breaking the Setup screen. */
export async function listSavedSearches(): Promise<SavedSearch[]> {
  try {
    const res = await fetch(`${API_URL}/saved-searches`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.searches) ? data.searches : [];
  } catch {
    return [];
  }
}

export async function createSavedSearch(
  name: string,
  keywords: string[],
  agentType: AgentTemplateId | null,
): Promise<SavedSearch> {
  const res = await fetch(`${API_URL}/saved-searches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, keywords, agentType }),
  });
  if (!res.ok) throw new Error('Failed to save search');
  return res.json();
}

export async function deleteSavedSearch(id: string): Promise<void> {
  await fetch(`${API_URL}/saved-searches/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface AgentDraft {
  id: string;
  agentName: string;
  agentType?: AgentTemplateId | null;
  keywords: string[];
  location: string;
  traits: string[];
  behaviorToggles?: string[];
  savedAt: number;
}

/** Saved agent profiles — the pre-bootstrap draft (name, type, location,
 * specialties + a flavor trait set) captured by Setup's "Save Agent" button
 * (see backend/src/agent_drafts.py). Distinct from a saved search (keywords
 * only) and from a saved chat (a fully bootstrapped agent with real
 * conversation history). [] on any failure, same degrade-quietly shape as
 * listSavedSearches(). */
export async function listAgentDrafts(): Promise<AgentDraft[]> {
  try {
    const res = await fetch(`${API_URL}/agent-drafts`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.drafts) ? data.drafts : [];
  } catch {
    return [];
  }
}

export async function createAgentDraft(
  agentName: string,
  agentType: AgentTemplateId | null,
  keywords: string[],
  location: string,
  traits: string[],
  behaviorToggles: string[] = [],
): Promise<AgentDraft> {
  const res = await fetch(`${API_URL}/agent-drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName, agentType, keywords, location, traits, behaviorToggles }),
  });
  if (!res.ok) throw new Error('Failed to save agent profile');
  return res.json();
}

/** Edits a saved profile in place (same id). Throws on failure, including a
 * 404 when the profile was deleted elsewhere; the caller then creates one. */
export async function updateAgentDraft(
  id: string,
  agentName: string,
  agentType: AgentTemplateId | null,
  keywords: string[],
  location: string,
  traits: string[],
  behaviorToggles: string[] = [],
): Promise<AgentDraft> {
  const res = await fetch(`${API_URL}/agent-drafts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName, agentType, keywords, location, traits, behaviorToggles }),
  });
  if (!res.ok) throw new Error('Failed to update agent profile');
  return res.json();
}

export async function deleteAgentDraft(id: string): Promise<void> {
  await fetch(`${API_URL}/agent-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface PublishedAgent {
  id: string;
  tool_name: string;
  name: string;
  description: string;
  agent_config: AgentConfig;
  created_at: number;
  // Success/failure history aggregated from eval_log.json (backend/src/agent_stats.py),
  // attributed via the agent_id every MCP-invoked run now carries. Absent pulls
  // means the agent has never been called over MCP since attribution was added.
  stats?: { pulls: number; successes: number; rate: number | null };
}

/** Published agents — server-side registry (backend/src/agent_registry.py)
 * backing the MCP server (backend/mcp_server.py), which exposes each one as
 * an MCP tool other MCP clients (Claude Desktop, Claude Code, another
 * AIAgent instance) can call. [] on any failure, same degrade-quietly shape
 * as listSavedSearches(). */
export async function listPublishedAgents(): Promise<PublishedAgent[]> {
  try {
    const res = await fetch(`${API_URL}/agents`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.agents) ? data.agents : [];
  } catch {
    return [];
  }
}

export async function publishAgent(
  name: string,
  description: string,
  agentConfig: AgentConfig,
): Promise<PublishedAgent> {
  const res = await fetch(`${API_URL}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, agent_config: agentConfig }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Failed to publish agent');
  }
  return res.json();
}

export async function unpublishAgent(id: string): Promise<void> {
  await fetch(`${API_URL}/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Recent eval_checks.py history for one published agent (backend/src/agent_stats.py),
 * newest first. [] on any failure, same degrade-quietly shape as listPublishedAgents. */
export async function fetchAgentEvalLog(agentId: string): Promise<EvalResultItem[]> {
  try {
    const res = await fetch(`${API_URL}/agents/${encodeURIComponent(agentId)}/eval-log`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

export interface McpServerInfo {
  server_id: string;
  description: string;
  reachable: boolean;
  tools: { name: string; description: string }[];
}

/** Read-only visibility into the vetted MCP server directory a bootstrap can
 * pick tools from (backend/src/mcp_registry.py) — every entry the platform
 * trusts, reachable or not, so an installed-but-not-running server reads
 * differently from one that was never vetted. [] on any failure, same
 * degrade-quietly shape as listSavedSearches(). */
export async function listMcpTools(): Promise<McpServerInfo[]> {
  try {
    const res = await fetch(`${API_URL}/mcp-tools`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.servers) ? data.servers : [];
  } catch {
    return [];
  }
}

export async function runAgent(
  messages: { role: string; content: string; image?: string }[],
  agentConfig: AgentConfig,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, agent_config: agentConfig }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Agent call failed');
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onEvent(JSON.parse(trimmed) as StreamEvent);
        } catch {
          // ignore malformed lines
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

export interface ConfigValidationIssue {
  tool: string | null;
  message: string;
  // 'note' = informational (e.g. the spec dropped a tool); anything else blocks launch
  severity?: 'note';
}

/** Review-step check for a hand-edited AgentConfig — runs bootstrap's
 * deterministic validators (compile, AST undefined-name, forbidden calls,
 * spec enforcement) without an LLM call. Returns the server's normalized
 * config (MCP schemas re-resolved, spec re-applied), which is what should
 * actually be launched. */
export async function validateConfig(
  agentConfig: AgentConfig,
): Promise<{ config: AgentConfig; errors: ConfigValidationIssue[] }> {
  const res = await fetch(`${API_URL}/validate-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_config: agentConfig }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Validation failed');
  }
  return res.json();
}

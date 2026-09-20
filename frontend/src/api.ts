import type { AgentConfig, AgentTemplateId, BootstrapStreamEvent, LlmProvider, StreamEvent } from './types';

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
): Promise<AgentConfig> {
  const res = await fetch(`${API_URL}/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      purpose,
      provider: provider ?? undefined,
      ollama_model: ollamaModel ?? undefined,
      agentType: agentType ?? undefined,
    }),
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
 * question to get the model to write the brief using that guidance. Throws
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
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Failed to generate brief');
  }
  return res.json();
}

/** Names of models currently pulled in the developer's local Ollama install. [] if unreachable. */
export async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${API_URL}/models`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.models) ? data.models : [];
  } catch {
    return [];
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
): Promise<AgentDraft> {
  const res = await fetch(`${API_URL}/agent-drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName, agentType, keywords, location, traits }),
  });
  if (!res.ok) throw new Error('Failed to save agent profile');
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
  messages: { role: string; content: string }[],
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

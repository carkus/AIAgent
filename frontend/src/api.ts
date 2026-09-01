import type { AgentConfig, BootstrapStreamEvent, LlmProvider, StreamEvent } from './types';

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
): Promise<AgentConfig> {
  const res = await fetch(`${API_URL}/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      purpose,
      provider: provider ?? undefined,
      ollama_model: ollamaModel ?? undefined,
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

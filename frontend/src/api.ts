import type { AgentConfig, StreamEvent } from './types';

const API_URL = import.meta.env.VITE_API_URL ?? '';

export async function bootstrap(purpose: string): Promise<AgentConfig> {
  const res = await fetch(`${API_URL}/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Bootstrap failed');
  }
  return res.json();
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
): Promise<void> {
  const res = await fetch(`${API_URL}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, agent_config: agentConfig }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Agent call failed');
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

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
}

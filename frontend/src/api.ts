import type { AgentConfig, AgentResponse, Message } from './types';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

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

export async function runAgent(
  messages: Message[],
  agentConfig: AgentConfig,
): Promise<AgentResponse> {
  const res = await fetch(`${API_URL}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, agent_config: agentConfig }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Agent call failed');
  }
  return res.json();
}

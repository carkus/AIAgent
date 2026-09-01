export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  implementation: string;
}

// undefined/null = default cascade (Gemini, falling back to local Ollama on error)
export type LlmProvider = 'gemini' | 'ollama' | null;

export interface AgentConfig {
  purpose: string;
  system_prompt: string;
  tools: ToolDefinition[];
  keywords?: string[];
  location?: string;
  provider?: LlmProvider;
  // Which locally-pulled Ollama model to use; ignored unless provider === 'ollama'.
  // undefined/null = the backend's OLLAMA_MODEL default.
  ollama_model?: string | null;
}

export interface ToolCall {
  tool: string;
  inputs: Record<string, unknown>;
  result: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// Stream events emitted by the agent loop
export type StreamEvent =
  | { type: 'tool_start'; tool: string; inputs: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: string }
  | {
      type: 'done';
      response: string;
      tool_calls: ToolCall[];
      duration_seconds: number;
      usage: { input_tokens: number; output_tokens: number };
      rate_limits: {
        tokens_limit: string | null;
        tokens_remaining: string | null;
        tokens_reset: string | null;
        requests_limit: string | null;
        requests_remaining: string | null;
      };
    }
  | { type: 'error'; message: string }

export interface ModelAttempt {
  provider: string
  model: string
}

// Stream events emitted by /bootstrap (backend/src/bootstrap.py:generate_agent_config_stream)
export type BootstrapStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'tool'; name: string }
  | { type: 'model'; used: ModelAttempt | null; failed: ModelAttempt[] }
  | { type: 'done'; config: AgentConfig }
  | { type: 'error'; message: string }

// A persisted snapshot of one finished/in-progress turn, for saved chats.
// Mirrors Chat.tsx's local ChatMessage minus the transient `liveToolCalls`
// field (only meaningful while a response is still streaming in).
export interface SavedChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  durationSeconds?: number;
  usage?: { input_tokens: number; output_tokens: number };
  rateLimits?: {
    tokens_remaining: string | null;
    tokens_limit: string | null;
    requests_remaining: string | null;
    tokens_reset: string | null;
  };
}

// A whole saved conversation: everything needed to drop straight back into
// Chat.tsx without re-running bootstrap. Persisted client-side (localStorage)
// since the backend is stateless — see chatStorage.ts.
export interface SavedChat {
  id: string;
  agentName: string;
  agentConfig: AgentConfig;
  messages: SavedChatMessage[];
  savedAt: number;
}

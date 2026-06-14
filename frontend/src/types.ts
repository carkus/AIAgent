export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  implementation: string;
}

export interface AgentConfig {
  purpose: string;
  system_prompt: string;
  tools: ToolDefinition[];
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

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

export interface AgentResponse {
  response: string;
  tool_calls: ToolCall[];
  duration_seconds: number;
}

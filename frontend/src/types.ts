export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  // Generated tools carry a Python implementation; MCP-backed tools (CLAUDE.md
  // MCP priority 6) carry source/mcp_server/mcp_tool instead — bootstrap
  // picked a real vetted tool rather than writing one, so there's no
  // implementation to run client-side or otherwise.
  implementation?: string;
  source?: 'generated' | 'mcp';
  mcp_server?: string;
  mcp_tool?: string;
}

// undefined/null = default cascade (Gemini, falling back to local Ollama on error)
export type LlmProvider = 'gemini' | 'ollama' | null;

// Which purpose template Setup.tsx used to build `purpose` — lets the Setup
// screen restore its "Agent type" dropdown when repopulating from a saved
// chat. Older saved chats predate this field, so treat missing as 'research'.
export type AgentTemplateId = 'research' | 'job_search' | 'general';

// The agent's own answer to "what's your name and personality?" — invented by
// the bootstrap call from the purpose text, same as system_prompt/tools are.
// Optional: older saved chats and malformed bootstrap responses predate/omit
// this, so callers fall back to the client-side random surname (surnames.ts).
export interface AgentPersona {
  name: string;
  traits: string[];
  rationale: string;
}

// Adzuna-backed search_jobs() defaults, set once on the Settings screen and
// used to fill in whatever the model's own tool call leaves unspecified —
// see backend/src/agent_stream.py's search_jobs call site. All optional;
// undefined = the backend's own hardcoded fallback ("au", 20, no radius).
export interface SearchDefaults {
  country?: string;
  results_per_page?: number;
  radius_km?: number;
}

export interface AgentConfig {
  purpose: string;
  system_prompt: string;
  tools: ToolDefinition[];
  persona?: AgentPersona;
  keywords?: string[];
  location?: string;
  provider?: LlmProvider;
  // Which locally-pulled Ollama model to use; ignored unless provider === 'ollama'.
  // undefined/null = the backend's OLLAMA_MODEL default.
  ollama_model?: string | null;
  template?: AgentTemplateId;
  // Settings-screen overrides — undefined/null on older saved chats/drafts,
  // which fall back to the backend's own defaults (agent_stream.py).
  max_delegations?: number | null;
  search_defaults?: SearchDefaults;
  // Behavior toggle ids active at bootstrap time (Setup.tsx's BEHAVIOR_TOGGLES) —
  // already baked into `purpose` as compounded instructions; kept here too,
  // undefined/[] on older saved chats/drafts, purely so a resumed chat or a
  // reloaded draft can show/restore which toggles were on.
  active_toggles?: string[];
  // Personality trait ids selected at bootstrap time (Setup.tsx's
  // PERSONALITY_TRAITS) — same shape as active_toggles above: already baked
  // into `purpose` as compounded instructions, kept here purely so a resumed
  // chat can restore which traits were selected. undefined/[] on older saved
  // chats predating this field.
  active_traits?: string[];
}

export interface ToolCall {
  tool: string;
  inputs: Record<string, unknown>;
  result: string;
  // 'primitive' (fetch_page/search_jobs/delegate_to_worker), 'generated'
  // (Claude-written Python), or 'mcp' (a real vetted MCP server call —
  // CLAUDE.md MCP priority 6). Optional: absent on saved chats from before
  // this field existed.
  source?: 'primitive' | 'generated' | 'mcp';
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  // Base64 data URL of a user-attached diagram image, sent alongside content
  // for the backend to fold into a multimodal request (agent_stream.py).
  // Optional/undefined on every message that isn't a diagram upload.
  image?: string;
}

// Stream events emitted by the agent loop
export type StreamEvent =
  // The agent's own step-by-step plan for this turn (agent_stream.py's
  // ```mermaid-plan fence, extracted from its first response only) — emitted
  // at most once, before any tool_start, distinct from a ```mermaid diagram
  // the agent may separately embed in its final answer text.
  | { type: 'plan'; diagram: string; summary: string | null }
  | { type: 'tool_start'; tool: string; inputs: Record<string, unknown>; source?: ToolCall['source']; call_index: number }
  | { type: 'tool_result'; tool: string; result: string; source?: ToolCall['source']; call_index: number }
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
  // Same base64 data URL as Message.image — undefined on every saved chat
  // predating the diagram-upload feature, or on any turn with no attachment.
  image?: string;
  toolCalls?: ToolCall[];
  planDiagram?: string;
  planSummary?: string;
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

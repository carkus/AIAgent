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

// Advanced Setup's structured spec (AdvancedSetup.tsx), mirrored by
// backend/src/agent_spec.py's normalize(). Each field is routed to the layer
// that can enforce it: mission/success/out_of_scope/voice go into the
// bootstrap prompt and are restated every turn; persona pins overwrite what
// bootstrap invents; the tool allow-lists and limits are enforced in code by
// agent_stream.py. For the allow-lists, null/undefined = no restriction and
// [] = nothing allowed.
export interface AgentSpec {
  mission?: string;
  success_criteria?: string;
  out_of_scope?: string;
  voice?: string;
  persona_name?: string;
  persona_traits?: string[];
  allowed_primitives?: string[] | null;
  // "server_id/tool_name" pairs from GET /mcp-tools
  allowed_mcp_tools?: string[] | null;
  allow_generated_tools?: boolean;
  allow_delegation?: boolean;
  max_tool_rounds?: number | null;
  max_tool_calls_per_step?: number | null;
  temperature?: number | null;
}

export interface AgentConfig {
  purpose: string;
  system_prompt: string;
  tools: ToolDefinition[];
  // Stable identity assigned by bootstrap.py, independent of name/description —
  // lets agent_registry.publish() recognize a re-publish of the same agent and
  // update its existing MCP-tool entry in place instead of duplicating it.
  // Absent on configs bootstrapped before this field existed.
  agent_config_id?: string;
  persona?: AgentPersona;
  // In-character welcome written by the bootstrap call, shown once in a popup
  // when a freshly bootstrapped agent opens (AgentBriefingModal.tsx). Absent on
  // older saved chats / malformed bootstraps — the modal falls back to a
  // templated rundown of the agent's tools.
  intro?: string;
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
  // Behavior toggle ids active at bootstrap time (agentTypes.ts's BEHAVIOR_TOGGLES) —
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
  // The agent's full settings. Advanced Setup edits all of it; basic Setup
  // sends agentTypes.ts's DEFAULT_AGENT_SPEC. Absent on agents bootstrapped
  // before basic Setup sent one, which the backend treats the same as the
  // default.
  spec?: AgentSpec;
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

// The user's optional rating of one assistant result (Chat.tsx's
// ResultRating). Rides along on that message in the history sent every
// turn, so agent_stream.py's _job_continuity_note can steer later turns of
// the same job by it; it is never stored server-side or used across jobs.
export interface ResultFeedback {
  rating: 'up' | 'down';
  note?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  feedback?: ResultFeedback;
  // Base64 data URL of a user-attached image, sent alongside content
  // for the backend to fold into a multimodal request (agent_stream.py).
  // Optional/undefined on every message that isn't an image upload.
  image?: string;
}

// One self-evaluation check result (backend/src/eval_checks.py), reused
// verbatim across all four session stages — bootstrap, chat response, tool
// call, and worker delegation — so the frontend needs only one shape and one
// rendering component (FeedbackStatusBar) regardless of which stage produced
// it. `target_id` is the tool call's `call_index` for a tool_call check, or
// the worker's persona name for a worker_delegation/bootstrap check; null
// for the top-level bootstrap and chat_response checks.
// One (provider, model) arm's UCB1 stats from backend/src/bandit.py, computed
// over eval_log.json's accumulated pass/fail history for that arm. `score` is
// null for a not-yet-tried arm (infinite in the backend's own math, sanitized
// to null since JSON has no Infinity) — it's still the must-explore pick.
export interface ArmStat {
  provider: string
  model: string
  pulls: number
  successes: number
  rate: number | null
  score: number | null
}

export interface EvalResultItem {
  check: string
  target: 'bootstrap' | 'chat_response' | 'tool_call' | 'worker_delegation'
  target_id: string | null
  passed: boolean
  reason: string
  method: 'deterministic' | 'llm_judge'
  severity?: 'info' | 'warning'
  // Which provider/model produced the thing being checked — carried so a
  // recorded pass/fail can be attributed back to the arm that produced it
  // (e.g. a future bandit over provider/tool choice, using `passed` as reward).
  provider?: string | null
  model?: string | null
  // Which published agent (backend/src/agent_registry.py) produced this
  // check, when the run was invoked over MCP (backend/mcp_server.py) rather
  // than an interactive chat/bootstrap session — null for the latter.
  agent_id?: string | null
}

// Stream events emitted by the agent loop
export type StreamEvent =
  // The agent's own step-by-step plan for this turn (agent_stream.py's
  // ```mermaid-plan fence, extracted from its first response only) — emitted
  // at most once, before any tool_start, distinct from a ```mermaid diagram
  // the agent may separately embed in its final answer text.
  | { type: 'plan'; diagram: string; summary: string | null }
  // What the agent loop is doing between visible tool calls — the model
  // "thinking", reviewing tool results before its next move, retrying a
  // weak reply, or running its own post-answer self-check — so the chat UI
  // has something better than a bare "Working…" spinner to show during
  // those gaps. Same shape as bootstrap's pre-existing 'status' event
  // (BootstrapStreamEvent below); superseded by the next 'status' or
  // 'tool_start' event, whichever comes first.
  // elapsed_seconds/tokens_so_far are real, already-computed backend values
  // (not synthetic) — how long this turn has run and the running token count
  // across every LLM call so far this turn — surfaced so the chat UI can show
  // more than the bare message string during a long gap between tool calls.
  | { type: 'status'; message: string; elapsed_seconds?: number; tokens_so_far?: { input_tokens: number; output_tokens: number } }
  // Which provider/model actually served the agent loop's LLM call this
  // iteration (and which were tried and failed first) — same shape and
  // purpose as bootstrap's pre-existing 'model' event below, just not
  // wired into the chat loop until now. Only emitted when it differs from
  // the last one seen this turn, so a long tool-heavy turn on a stable
  // provider doesn't repeat the same line every iteration.
  | { type: 'model'; used: ModelAttempt | null; failed: ModelAttempt[] }
  | { type: 'tool_start'; tool: string; inputs: Record<string, unknown>; source?: ToolCall['source']; call_index: number }
  | { type: 'tool_result'; tool: string; result: string; source?: ToolCall['source']; call_index: number }
  | ({ type: 'eval_result' } & EvalResultItem)
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
      // Output relics the agent offers for this answer (agent_stream.py's
      // rule 7b). Built only if the user clicks one (POST /relic).
      relic_suggestions?: RelicSuggestion[];
    }
  | { type: 'error'; message: string }

export type RelicKind = 'csv' | 'diagram' | 'chart' | 'markdown' | 'pdf' | 'docx' | 'slides' | 'json'

// A relic the user has built (POST /relic), kept on its answer so it can be
// previewed and downloaded again without another LLM call. `content` is the
// text relic.py returned; the file itself is built from it on download.
export interface Relic {
  kind: RelicKind
  content: string
  createdAt: string
}

export interface RelicSuggestion {
  kind: RelicKind
  reason: string
}

export interface ModelAttempt {
  provider: string
  model: string
}

// Stream events emitted by /bootstrap (backend/src/bootstrap.py:generate_agent_config_stream)
export type BootstrapStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'tool'; name: string }
  | { type: 'model'; used: ModelAttempt | null; failed: ModelAttempt[] }
  | ({ type: 'eval_result' } & EvalResultItem)
  | { type: 'done'; config: AgentConfig }
  | { type: 'error'; message: string }

// A persisted snapshot of one finished/in-progress turn, for saved chats.
// Mirrors Chat.tsx's local ChatMessage minus the transient `liveToolCalls`
// field (only meaningful while a response is still streaming in).
export interface SavedChatMessage {
  role: 'user' | 'assistant';
  content: string;
  feedback?: ResultFeedback;
  // What the bubble shows in place of `content`, when they differ (e.g. the
  // auto-fired initial search's real instruction vs. the agent's original
  // setup purpose). Undefined on every ordinary typed message.
  displayContent?: string;
  // Same base64 data URL as Message.image — undefined on every saved chat
  // predating the image-upload feature, or on any turn with no attachment.
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
  relicSuggestions?: RelicSuggestion[];
  relics?: Relic[];
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

import type { LlmProvider, ModelAttempt } from './types'

// Mirrors backend/src/llm_client.py's cascade: Gemini first (cloud, cheap),
// falling back to local Ollama on any provider error — unless the agent's
// own provider choice pins it to just one link in that chain. Kept as the
// single source of truth for both Setup.tsx (before an agent is bootstrapped)
// and Chat.tsx (while running it), so the two screens never describe the
// same choice differently.
export const GEMINI_MODEL_NAME = 'gemini-3.6-flash'
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:7b'

export function describeModel(provider: LlmProvider | undefined, ollamaModel?: string | null): string {
  if (provider === 'ollama') return `Ollama: ${ollamaModel ?? DEFAULT_OLLAMA_MODEL}`
  return `Gemini (${GEMINI_MODEL_NAME})`
}

// Heuristic from the model tag's own parameter-count suffix (e.g. "0.5b",
// "1.5b", "7b") — models at or below 3B params are unreliable for bootstrap's
// large structured-JSON output (AgentConfig + tool schemas), per this
// project's own findings (AIAgent/CLAUDE.md's model-picker notes). Returns
// false for tags with no parseable size (e.g. "latest") rather than guessing.
export function isTinyOllamaModel(model: string | null | undefined): boolean {
  if (!model) return false
  const match = model.toLowerCase().match(/(\d+(?:\.\d+)?)b(?!\w)/)
  if (!match) return false
  return parseFloat(match[1]) <= 3
}

// Ollama has no tag metadata flagging a model as "reasoning" (long
// chain-of-thought before the final answer) — this is name-pattern matching
// against the known reasoning-model families available to pull, not a real
// capability check. These models are frequently much slower per turn than a
// same-size instruct model because they spend tokens thinking before ever
// producing the JSON/tool-call output this app's bootstrap and agent loop
// need, and can be slow enough locally to look hung.
const REASONING_MODEL_PATTERNS = [/deepseek-r1/, /\bqwq\b/, /\bqwen3\b/, /\bo1\b/, /\br1\b/]

export function isReasoningOllamaModel(model: string | null | undefined): boolean {
  if (!model) return false
  const lower = model.toLowerCase()
  return REASONING_MODEL_PATTERNS.some(p => p.test(lower))
}

export function describeModelFallback(provider: LlmProvider | undefined): string {
  if (provider === 'ollama') return 'Pinned to local Ollama — no cloud fallback for this agent'
  if (provider === 'gemini') return 'Pinned to cloud Gemini — no local fallback for this agent'
  return `Auto cascade: Gemini first, falls back to local Ollama (${DEFAULT_OLLAMA_MODEL}) if Gemini is unavailable`
}

// Formats a real, in-flight `{"type": "model", ...}` stream event (which
// provider/model actually served a call, and which were tried and failed
// first) — distinct from describeModel/describeModelFallback above, which
// only describe the agent's own static, pre-run provider *choice*. Shared by
// Setup.tsx (bootstrap) and Chat.tsx (the agent loop) so both screens
// describe a live cascade fallback identically.
export interface ModelInfo {
  used: ModelAttempt | null
  failed: ModelAttempt[]
}

export function formatModelInfo({ used, failed }: ModelInfo): string {
  const failedNames = failed.map(f => `${f.provider}:${f.model}`)
  if (used) {
    const usedName = `${used.provider}:${used.model}`
    return failedNames.length > 0
      ? `Model: ${usedName} (fell back from ${failedNames.join(', ')})`
      : `Model: ${usedName}`
  }
  return failedNames.length > 0
    ? `Model attempt failed: ${failedNames.join(', ')}`
    : 'Model: unknown'
}

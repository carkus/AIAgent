// Display names for tool calls whose real (wire) name reads badly in the UI.
// Only the label changes; tc.tool / node.tool keep the real name for logic.
const DISPLAY_NAMES: Record<string, string> = {
  delegate_to_worker: 'delegated: worker assigned',
}

export function toolDisplayName(tool: string): string {
  return DISPLAY_NAMES[tool] ?? tool
}

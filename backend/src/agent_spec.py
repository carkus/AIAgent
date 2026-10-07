"""Structured agent spec from the Advanced Setup screen (AdvancedSetup.tsx).

The basic Setup screen folds every choice into one `purpose` sentence, which
bootstrap then *interprets* — pure prompt engineering, with nothing stopping
the model from ignoring part of it. A spec is the same intent kept as data,
so each field can be routed to the layer that can actually guarantee it:

  - Prompt layer (soft)      — mission / success criteria / out-of-scope /
                               voice: rendered as tagged sections into the
                               bootstrap prompt (`bootstrap_prompt_block`) and
                               restated every turn (`runtime_scope_note`).
  - Post-generation (hard)   — pinned persona name/traits overwrite whatever
                               bootstrap invented; disallowed tools are
                               dropped from the generated config
                               (`enforce_on_config`).
  - Runtime (hard)           — primitive/MCP/generated tool allow-lists,
                               delegation, tool-round and per-step call caps,
                               temperature: read by agent_stream.py and
                               enforced in code on every turn, regardless of
                               what the system prompt says.

AgentConfig (spec included) round-trips through the browser, so `normalize`
is re-run at every trust boundary (/bootstrap, /validate-config, /agent)
rather than trusting a previously-normalized copy.
"""

PRIMITIVE_NAMES = ("fetch_page", "search_jobs", "search_image", "generate_image")

_MAX_TOOL_ROUNDS = 25
_MAX_CALLS_PER_STEP = 20
_MAX_TEXT = 2000


def _text(value) -> str:
    return value.strip()[:_MAX_TEXT] if isinstance(value, str) else ""


def _int_in(value, lo: int, hi: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(lo, min(hi, int(value)))


def _str_list(value) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return [v.strip() for v in value if isinstance(v, str) and v.strip()]


def normalize(raw) -> dict | None:
    """Coerce an untrusted spec dict into a known shape. None means "no spec"
    — every caller treats that as the pre-existing, unconstrained behaviour.

    `allowed_primitives`/`allowed_mcp_tools` use None for "no restriction"
    and [] for "none allowed" — the distinction matters, so it's kept."""
    if not isinstance(raw, dict):
        return None
    primitives = _str_list(raw.get("allowed_primitives"))
    if primitives is not None:
        primitives = [p for p in primitives if p in PRIMITIVE_NAMES]
    temperature = raw.get("temperature")
    if isinstance(temperature, bool) or not isinstance(temperature, (int, float)):
        temperature = None
    else:
        temperature = max(0.0, min(1.5, float(temperature)))
    return {
        "mission": _text(raw.get("mission")),
        "success_criteria": _text(raw.get("success_criteria")),
        "out_of_scope": _text(raw.get("out_of_scope")),
        "voice": _text(raw.get("voice")),
        "persona_name": _text(raw.get("persona_name"))[:40],
        "persona_traits": (_str_list(raw.get("persona_traits")) or [])[:5],
        "allowed_primitives": primitives,
        "allowed_mcp_tools": _str_list(raw.get("allowed_mcp_tools")),
        "allow_generated_tools": raw.get("allow_generated_tools") is not False,
        "allow_delegation": raw.get("allow_delegation") is not False,
        "max_tool_rounds": _int_in(raw.get("max_tool_rounds"), 1, _MAX_TOOL_ROUNDS),
        "max_tool_calls_per_step": _int_in(raw.get("max_tool_calls_per_step"), 1, _MAX_CALLS_PER_STEP),
        "temperature": temperature,
    }


def restricts_tools(spec: dict | None) -> bool:
    return bool(spec) and (
        spec["allowed_primitives"] is not None
        or spec["allowed_mcp_tools"] is not None
        or not spec["allow_generated_tools"]
    )


def primitive_allowed(name: str, spec: dict | None) -> bool:
    return not spec or spec["allowed_primitives"] is None or name in spec["allowed_primitives"]


def filter_mcp_catalog(catalog: list[dict], spec: dict | None) -> list[dict]:
    """Only advertise allowed MCP tools to bootstrap — the model can't pick a
    tool it never sees, which is cheaper than dropping its pick afterwards."""
    if not spec or spec["allowed_mcp_tools"] is None:
        return catalog
    allowed = set(spec["allowed_mcp_tools"])
    return [c for c in catalog if f'{c["server_id"]}/{c["tool_name"]}' in allowed]


def tool_def_allowed(tool: dict, spec: dict | None) -> bool:
    if not spec:
        return True
    if tool.get("source") == "mcp":
        allowed = spec["allowed_mcp_tools"]
        return allowed is None or f'{tool.get("mcp_server")}/{tool.get("mcp_tool")}' in allowed
    return spec["allow_generated_tools"]


def bootstrap_prompt_block(spec: dict | None) -> str:
    """Tagged sections, not prose appended to `purpose` — keeps each
    requirement separately addressable so the model can't blur them into
    one vague instruction."""
    if not spec:
        return ""
    sections = []
    for key, tag in (
        ("mission", "mission"),
        ("success_criteria", "success_criteria"),
        ("out_of_scope", "out_of_scope"),
        ("voice", "voice"),
    ):
        if spec[key]:
            sections.append(f"<{tag}>\n{spec[key]}\n</{tag}>")
    constraints = []
    if spec["persona_name"]:
        constraints.append(f'persona.name MUST be exactly "{spec["persona_name"]}".')
    if spec["persona_traits"]:
        constraints.append(f"persona.traits MUST be exactly {spec['persona_traits']}.")
    if spec["out_of_scope"]:
        constraints.append(
            "The system_prompt MUST tell the agent to decline anything in <out_of_scope> "
            "and briefly say why."
        )
    if spec["success_criteria"]:
        constraints.append(
            "The system_prompt MUST describe what a successful answer looks like, "
            "using <success_criteria>."
        )
    if spec["allowed_primitives"] is not None:
        disabled = [p for p in PRIMITIVE_NAMES if p not in spec["allowed_primitives"]]
        if disabled:
            constraints.append(
                f"These primitive tools are DISABLED for this agent — never mention or "
                f"instruct their use: {', '.join(disabled)}."
            )
    if not spec["allow_generated_tools"]:
        constraints.append(
            'Do NOT write any tool with an `implementation` (no generated tools at all, '
            'not even save_output). Only `"source": "mcp"` tools are allowed, or an empty '
            'tools array.'
        )
    if not spec["allow_delegation"]:
        constraints.append("This agent cannot delegate to workers — don't mention delegation.")
    if constraints:
        sections.append("<hard_constraints>\n" + "\n".join(f"- {c}" for c in constraints) + "\n</hard_constraints>")
    if not sections:
        return ""
    return (
        "\nThe user also gave a structured specification. It takes precedence over "
        "anything implied by the purpose text above:\n\n" + "\n\n".join(sections) + "\n"
    )


def enforce_on_config(config: dict, spec: dict | None) -> list[str]:
    """Code-level guarantees applied after bootstrap — the prompt asked
    nicely, this makes it true. Returns human-readable notes for anything
    that had to be overridden, so the UI can show where the model drifted."""
    if not spec:
        return []
    notes = []
    kept, dropped = [], []
    for tool in config.get("tools", []):
        (kept if isinstance(tool, dict) and tool_def_allowed(tool, spec) else dropped).append(tool)
    if dropped:
        config["tools"] = kept
        names = ", ".join(str(t.get("name")) for t in dropped if isinstance(t, dict))
        notes.append(f"Dropped tool(s) not allowed by your spec: {names}")

    if spec["persona_name"] or spec["persona_traits"]:
        persona = config.get("persona") or {"name": "", "traits": [], "rationale": ""}
        if spec["persona_name"] and persona.get("name") != spec["persona_name"]:
            if persona.get("name"):
                notes.append(f'Persona name pinned to "{spec["persona_name"]}" (model chose "{persona["name"]}")')
            persona["name"] = spec["persona_name"]
        if spec["persona_traits"] and persona.get("traits") != spec["persona_traits"]:
            persona["traits"] = list(spec["persona_traits"])
            notes.append("Persona traits pinned to your selection")
        if persona.get("name"):
            config["persona"] = persona
    config["spec"] = spec
    return notes


def runtime_scope_note(spec: dict | None) -> str:
    """Re-stated every turn from the spec itself, not from bootstrap's
    paraphrase — same reasoning as agent_stream.py's _location_note: the
    generated system_prompt may have softened or dropped it."""
    if not spec:
        return ""
    parts = []
    if spec["mission"]:
        parts.append(f"Mission: {spec['mission']}")
    if spec["success_criteria"]:
        parts.append(f"A good answer: {spec['success_criteria']}")
    if spec["out_of_scope"]:
        parts.append(
            f"Out of scope (decline briefly and say why): {spec['out_of_scope']}"
        )
    if spec["voice"]:
        parts.append(f"Voice: {spec['voice']}")
    if not parts:
        return ""
    return "\n\nOperator specification (authoritative):\n" + "\n".join(f"- {p}" for p in parts) + "\n"

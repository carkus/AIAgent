"""
Tool record/replay for the chat-turn eval suite (eval_harness.py --suite chat).

A chat turn calls the outside world — web pages, job listings, MCP servers,
generated tool code, delegated workers — and those answers change from one
run to the next. Scoring two models on different tool results isn't a fair
comparison, so each case keeps a *tape*: every tool call made while
recording, with its result. On replay, each call is answered from the tape
instead of the live tool, so every arm sees the same world.

Matching a replayed call to the tape, in order:
  1. exact   — same tool key and the same inputs (canonical JSON)
  2. fuzzy   — same tool key, different inputs: the first tape entry for that
               tool not yet used this run. Models phrase queries differently;
               the recorded answer is still a fair stand-in, and the report
               counts how often this happened.
  3. miss    — no tape entry for that tool. In record mode the live tool runs
               and the result is added to the tape; in replay mode the call
               gets an error result (and the report counts it), so a model that
               reaches for a tool nobody recorded is visible rather than
               silently given live data.

Tool keys: the primitive's name (fetch_page, search_jobs, search_image,
generate_image), "mcp:<server>/<tool>", "exec:<sha of implementation>" for a
generated tool, and "delegate_to_worker" for a whole delegated worker (its
task + context are the inputs). A worker is replayed as one unit; its own
inner tool calls are never taped (they run in pool threads, see _taping).

Patches are module-attribute swaps in this process only, the same approach
eval_harness.py already uses for eval_log/bootstrap_memory.
"""
import copy
import hashlib
import json
import threading

import agent_stream
import mcp_client
import orchestrator


def _canon(inputs) -> str:
    try:
        return json.dumps(inputs, sort_keys=True, default=str)
    except Exception:
        return str(inputs)


def _taping() -> bool:
    """Only the main agent's own calls are taped. A recorded worker runs in a
    ThreadPoolExecutor thread; its inner calls go live and aren't taped,
    because on replay the whole worker comes off the tape as one call."""
    return threading.current_thread() is threading.main_thread()


class ToolTape:
    def __init__(self, entries: list | None, record: bool):
        self.entries = list(entries or [])
        self.record = record
        self.reset_stats()

    def reset_stats(self):
        self.used: set[int] = set()
        self.stats = {"exact": 0, "fuzzy": 0, "miss": 0, "live": 0}

    def call(self, key: str, inputs: dict, live):
        if not _taping():
            return live()
        canon = _canon(inputs)
        for i, e in enumerate(self.entries):
            if e["tool"] == key and e["inputs_canon"] == canon:
                self.used.add(i)
                self.stats["exact"] += 1
                return copy.deepcopy(e["result"])
        if self.record:
            result = live()
            self.entries.append({"tool": key, "inputs": inputs, "inputs_canon": canon, "result": _storable(result)})
            self.used.add(len(self.entries) - 1)
            self.stats["live"] += 1
            return result
        for i, e in enumerate(self.entries):
            if e["tool"] == key and i not in self.used:
                self.used.add(i)
                self.stats["fuzzy"] += 1
                return copy.deepcopy(e["result"])
        self.stats["miss"] += 1
        return {"error": f"eval replay: no recorded response for {key}. Answer with what you already have."}

    def lookup_worker(self, inputs: dict):
        """A delegated worker, replayed whole: exact task match first, then
        (replay only) any unused recorded worker."""
        canon = _canon(inputs)
        workers = [i for i, e in enumerate(self.entries) if e["tool"] == "delegate_to_worker"]
        pick = next((i for i in workers if self.entries[i]["inputs_canon"] == canon and i not in self.used), None)
        kind = "exact"
        if pick is None and not self.record:
            pick = next((i for i in workers if i not in self.used), None)
            kind = "fuzzy"
        if pick is None:
            if not self.record:
                self.stats["miss"] += 1
            return None
        self.used.add(pick)
        self.stats[kind] += 1
        return copy.deepcopy(self.entries[pick]["result"])

    def add_worker(self, inputs: dict, result):
        self.entries.append({"tool": "delegate_to_worker", "inputs": inputs, "inputs_canon": _canon(inputs),
                             "result": _storable(result)})
        self.used.add(len(self.entries) - 1)
        self.stats["live"] += 1


def _storable(result):
    """Recorded results must be JSON. A worker's result also carries its own
    trace spans and self-check results from the recording arm, which would be
    misattributed to whichever arm replays it, so those are dropped."""
    if isinstance(result, dict):
        result = {k: v for k, v in result.items() if k not in ("trace", "eval_results")}
    try:
        return json.loads(json.dumps(result, default=str))
    except Exception:
        return str(result)


_originals: dict = {}
_worker_lock = threading.Lock()


def install(tape_ref: dict):
    """Swap every tool entry point agent_stream uses for a taped version.
    `tape_ref["tape"]` is read on each call, so the harness can point it at
    a different case's tape without re-patching."""
    if _originals:
        return
    _originals.update(
        fetch_page=agent_stream.fetch_page,
        search_jobs=agent_stream.search_jobs,
        search_image=agent_stream.search_image,
        generate_image=agent_stream.generate_image,
        execute_tool=agent_stream.execute_tool,
        call_tool=mcp_client.call_tool,
        run_worker=orchestrator.run_worker,
    )
    o = _originals

    def tape() -> ToolTape:
        return tape_ref["tape"]

    agent_stream.fetch_page = lambda url: tape().call("fetch_page", {"url": url}, lambda: o["fetch_page"](url))
    agent_stream.search_jobs = lambda **kw: tape().call("search_jobs", kw, lambda: o["search_jobs"](**kw))
    agent_stream.search_image = lambda q: tape().call("search_image", {"query": q}, lambda: o["search_image"](q))
    agent_stream.generate_image = lambda p: tape().call("generate_image", {"prompt": p}, lambda: o["generate_image"](p))

    def execute_tool(implementation, inputs):
        key = "exec:" + hashlib.sha1((implementation or "").encode("utf-8")).hexdigest()[:10]
        return tape().call(key, inputs, lambda: o["execute_tool"](implementation, inputs))
    agent_stream.execute_tool = execute_tool

    def call_tool(server_id, tool_name, inputs):
        return tape().call(f"mcp:{server_id}/{tool_name}", inputs,
                           lambda: o["call_tool"](server_id, tool_name, inputs))
    mcp_client.call_tool = call_tool

    # Submitted to a thread pool by agent_stream, so _taping() would say no;
    # the tape lookup for a whole worker is done here, keyed explicitly.
    def run_worker(**kw):
        t = tape()
        inputs = {"task": kw.get("task", ""), "context": kw.get("context", "")}
        with _worker_lock:
            hit = t.lookup_worker(inputs)
        if hit is not None:
            return hit
        if not t.record:
            return {"error": "eval replay: no recorded worker for this task."}
        result = o["run_worker"](**kw)
        with _worker_lock:
            t.add_worker(inputs, result)
        return result
    orchestrator.run_worker = run_worker



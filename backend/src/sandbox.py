"""
Per-call process isolation for generated tool code (Showcase Goal 3,
Limitation #2). tools.execute_tool() hands every generated `implementation`
to run(), which executes it in a fresh, short-lived child process
(sandbox_runner.py) instead of exec() inside the gunicorn worker.

What each layer guarantees:

  Hard (enforced by the OS, holds even if the tool escapes Python-level rules)
    - Secrets: the child's environment is rebuilt from a small allowlist
      (PATH, locale, temp vars), so GEMINI_API_KEY and friends simply aren't
      in it. In production the .env file is root-owned mode 600 (read by
      systemd, not the service user), and this module marks the parent
      process non-dumpable on Linux so the child can't read the parent's
      /proc/<pid>/environ either.
    - Time: a wall-clock timeout kills the child (TOOL_SANDBOX_TIMEOUT_SECONDS).
    - Linux only: CPU-seconds, address-space and file-size rlimits; and, for
      tools that don't use the network, a fresh network namespace with no
      interfaces, when the kernel allows unprivileged user namespaces.
    - Blast radius: a crash, infinite loop or memory blow-up takes down a
      throwaway process, not a worker thread serving 15 other agents.

  Soft (Python-level, can be escaped by determined code)
    - import allowlist; open()/os confined to TEMP_DIR; sockets blocked for
      non-network tools when the network namespace isn't available.

Network is granted when the code visibly uses an HTTP client (uses_network),
which is the tool "declaring" it: the declaration is the code itself, so the
model doesn't need to learn a new schema field and can't claim one thing
while doing another.

Not covered: filesystem reads outside TEMP_DIR by code that escapes the soft
layer (same uid as the service), and network egress for network tools (they
can reach any host). A container or separate uid would close both; see
CLAUDE.md, Showcase Goal 3.

Cost: one Python process start per generated-tool call (~100-300 ms).
"""
import ast
import json
import logging
import os
import subprocess
import sys
import tempfile

logger = logging.getLogger(__name__)

_RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sandbox_runner.py")
TIMEOUT_SECONDS = float(os.environ.get("TOOL_SANDBOX_TIMEOUT_SECONDS", "30"))
CPU_SECONDS = int(os.environ.get("TOOL_SANDBOX_CPU_SECONDS", "15"))
MEMORY_MB = int(os.environ.get("TOOL_SANDBOX_MEMORY_MB", "512"))
FILE_MB = int(os.environ.get("TOOL_SANDBOX_FILE_MB", "20"))
_MAX_REPLY_BYTES = 4 * 1024 * 1024

# Environment the child keeps. Everything else, including every API key, is
# dropped. Windows needs SYSTEMROOT for sockets/crypto to initialise.
_ENV_KEEP = ("PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "PYTHONIOENCODING")


def _make_parent_non_dumpable() -> None:
    """prctl(PR_SET_DUMPABLE, 0): same-uid processes (i.e. an escaped tool)
    can no longer read this process's /proc/<pid>/environ or memory."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes
        PR_SET_DUMPABLE = 4
        ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
    except Exception as e:  # never block startup over a hardening step
        logger.warning("sandbox: could not mark process non-dumpable: %s", e)


_make_parent_non_dumpable()

_NETWORK_NAMES = {"requests", "socket", "http", "bs4"}


def uses_network(implementation: str) -> bool:
    """True when the code imports or references an HTTP client: requests,
    urllib.request, http.client, socket. Unparseable code counts as network,
    so a syntax quirk can't silently strip a working tool's network."""
    try:
        tree = ast.parse(implementation or "")
    except SyntaxError:
        return True
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in _NETWORK_NAMES:
            return True
        if isinstance(node, ast.Attribute) and node.attr in ("request", "urlopen") \
                and isinstance(node.value, ast.Name) and node.value.id == "urllib":
            return True
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            if any(n.split(".")[0] in _NETWORK_NAMES or n.startswith("urllib.request") for n in names):
                return True
    return False


def _child_env(temp_dir: str) -> dict:
    env = {k: os.environ[k] for k in _ENV_KEEP if k in os.environ}
    env.update(TMP=temp_dir, TEMP=temp_dir, TMPDIR=temp_dir, PYTHONIOENCODING="utf-8")
    return env


def run(implementation: str, inputs: dict, http_timeout: float = 20.0) -> dict:
    """Run one implementation. Returns {"ok", "result"|"error", "isolation",
    "network"}; never raises."""
    temp_dir = tempfile.gettempdir()  # shared with save_output / GET /file/<name>
    network = uses_network(implementation)
    job = {
        "implementation": implementation,
        "inputs": inputs,
        "network": network,
        "temp_dir": temp_dir,
        "http_timeout": http_timeout,
        "cpu_seconds": CPU_SECONDS,
        "memory_mb": MEMORY_MB,
        "file_mb": FILE_MB,
    }
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            [sys.executable, "-I", _RUNNER],
            input=json.dumps(job, default=str) + "\n",
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=TIMEOUT_SECONDS, env=_child_env(temp_dir), cwd=temp_dir,
            creationflags=flags,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "network": network, "isolation": [],
                "error": f"Tool timed out after {TIMEOUT_SECONDS:.0f}s and was stopped."}
    except Exception as e:
        return {"ok": False, "network": network, "isolation": [], "error": f"Sandbox failed to start: {e}"}

    reply_line = (proc.stdout or "")[-_MAX_REPLY_BYTES:].strip().splitlines()
    try:
        reply = json.loads(reply_line[-1]) if reply_line else None
    except json.JSONDecodeError:
        reply = None
    if not isinstance(reply, dict):
        # Killed by an rlimit (SIGXCPU/SIGKILL on memory) or crashed hard.
        tail = (proc.stderr or "").strip()[-600:]
        return {"ok": False, "network": network, "isolation": [],
                "error": f"Tool process exited with code {proc.returncode} before replying"
                         + (f" (likely a CPU or memory limit)." if proc.returncode and proc.returncode < 0 else ".")
                         + (f"\n{tail}" if tail else "")}
    reply["network"] = network
    return reply

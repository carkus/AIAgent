"""
Child side of sandbox.py: runs ONE generated tool implementation, then exits.

Started as `python -I sandbox_runner.py` with a scrubbed environment (no API
keys), its own working directory, and the job as one JSON line on stdin:
  {"implementation", "inputs", "network", "temp_dir", "http_timeout",
   "cpu_seconds", "memory_mb", "file_mb"}
It answers with one JSON line on stdout:
  {"ok": true, "result": ..., "isolation": [...]} or
  {"ok": false, "error": "<traceback>", "isolation": [...]}

Self-contained on purpose: -I keeps this file's directory off sys.path, so it
can't import (or be tricked into importing) the backend's own modules.

Layers applied here, in order, before the generated code is even compiled:
  1. rlimits (Linux): CPU seconds, address space, max file size. Hard.
  2. network namespace (Linux, when unprivileged user namespaces are
     allowed) for tools that don't use the network: no interfaces at all. Hard.
  3. socket block for the same tools when (2) isn't available. Soft.
  4. restricted namespace: import allowlist, open()/os confined to temp_dir.
     Soft: in-process Python restrictions can be escaped by determined code
     (e.g. via object introspection). The hard layers above, and the absence
     of any secret in this process, are what bound the damage if they are.
"""
import builtins
import json
import os
import sys
import traceback

_PROTO = sys.stdout
_isolation: list[str] = []


def _apply_rlimits(job: dict) -> None:
    try:
        import resource
    except ImportError:
        return  # Windows dev: only the parent's wall-clock timeout applies
    cpu = int(job.get("cpu_seconds") or 10)
    mem = int(job.get("memory_mb") or 512) * 1024 * 1024
    fsz = int(job.get("file_mb") or 20) * 1024 * 1024
    for name, value in (("RLIMIT_CPU", cpu), ("RLIMIT_AS", mem), ("RLIMIT_FSIZE", fsz)):
        try:
            resource.setrlimit(getattr(resource, name), (value, value))
            _isolation.append(name.lower())
        except (ValueError, OSError):
            pass


def _drop_network() -> None:
    """New user+network namespace: the process keeps running as itself but
    sees only a downed loopback, so no connection can leave the box."""
    if not sys.platform.startswith("linux"):
        return
    CLONE_NEWUSER, CLONE_NEWNET = 0x10000000, 0x40000000
    try:
        if hasattr(os, "unshare"):
            os.unshare(CLONE_NEWUSER | CLONE_NEWNET)
        else:
            import ctypes
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.unshare(CLONE_NEWUSER | CLONE_NEWNET) != 0:
                raise OSError(ctypes.get_errno(), "unshare failed")
        _isolation.append("netns")
    except Exception:
        pass  # e.g. Ubuntu's AppArmor userns restriction; the socket block still applies


def _block_sockets() -> None:
    import socket

    def refuse(*_a, **_k):
        raise PermissionError("network access is disabled for this tool (it doesn't use an HTTP client)")

    class _NoSocket(socket.socket):
        def __init__(self, *a, **k):
            refuse()

    socket.socket = _NoSocket
    socket.create_connection = refuse
    socket.getaddrinfo = refuse
    _isolation.append("socket_block")


# Modules generated tools commonly import. Anything else (subprocess, shutil,
# ctypes, importlib, socket, pathlib, io, sys, ...) fails with ImportError.
_ALLOWED_IMPORTS = {
    "json", "re", "math", "datetime", "collections", "urllib", "csv", "statistics",
    "random", "string", "itertools", "functools", "time", "hashlib", "base64",
    "textwrap", "html", "decimal", "fractions", "uuid", "typing", "dataclasses",
    "copy", "operator", "calendar", "zoneinfo", "difflib", "unicodedata", "bisect",
    "heapq", "enum", "numbers", "pprint", "xml", "email", "requests", "bs4",
}
_NETWORK_IMPORTS = {"requests", "bs4"}

# Builtins and top-level names a tool's code can use. bootstrap.py's static
# undefined-name check imports these, so there is one list, not two to sync.
SAFE_BUILTIN_NAMES = (
    "print", "len", "range", "enumerate", "zip", "map", "filter",
    "sorted", "reversed", "list", "dict", "set", "frozenset", "tuple", "str", "bytes",
    "int", "float", "bool", "type", "isinstance", "issubclass", "hasattr", "getattr", "setattr",
    "min", "max", "sum", "abs", "round", "repr", "format", "divmod", "pow", "chr", "ord",
    "any", "all", "next", "iter", "hash", "id", "slice", "callable", "object", "super",
    "staticmethod", "classmethod", "property", "__build_class__", "open", "__import__",
    "Exception", "ValueError", "KeyError", "TypeError", "IOError", "OSError",
    "StopIteration", "RuntimeError", "IndexError", "AttributeError", "ZeroDivisionError",
    "PermissionError", "FileNotFoundError", "ImportError", "NameError", "NotImplementedError",
)
INJECTED_NAMES = (
    "inputs", "input_data", "input", "requests", "json", "os", "re", "math",
    "datetime", "collections", "urllib", "TEMP_DIR", "result",
)


def _confined(temp_dir: str):
    root = os.path.realpath(temp_dir)

    def check(path) -> str:
        if isinstance(path, int):
            raise PermissionError("file descriptors are not available to tools")
        full = os.path.realpath(os.path.join(root, os.fspath(path)))
        if os.path.commonpath([full, root]) != root:
            raise PermissionError(f"tools may only use files inside TEMP_DIR, not {path!r}")
        return full
    return check


class _OsProxy:
    """The parts of `os` generated tools actually use, with every path
    confined to TEMP_DIR. No system/exec/spawn/kill/fork."""

    def __init__(self, check):
        self._check = check
        self.path = os.path
        self.sep, self.linesep, self.name, self.curdir = os.sep, os.linesep, os.name, os.curdir
        self.environ = dict(os.environ)  # already scrubbed by the parent
        self.getenv = self.environ.get
        self.urandom = os.urandom

    def getcwd(self):
        return os.getcwd()

    def listdir(self, path="."):
        return os.listdir(self._check(path))

    def makedirs(self, path, mode=0o777, exist_ok=False):
        return os.makedirs(self._check(path), mode, exist_ok)

    def mkdir(self, path, mode=0o777):
        return os.mkdir(self._check(path), mode)

    def remove(self, path):
        return os.remove(self._check(path))

    unlink = remove

    def replace(self, src, dst):
        return os.replace(self._check(src), self._check(dst))

    rename = replace

    def stat(self, path):
        return os.stat(self._check(path))

    def walk(self, top=".", **kw):
        return os.walk(self._check(top), **kw)


def _namespace(job: dict) -> dict:
    import collections
    import datetime
    import math
    import re
    import urllib.parse

    temp_dir = job["temp_dir"]
    check = _confined(temp_dir)
    network = bool(job.get("network"))
    real_import = builtins.__import__
    real_open = builtins.open

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        top = name.split(".")[0]
        if level != 0 or top not in _ALLOWED_IMPORTS or (top in _NETWORK_IMPORTS and not network):
            raise ImportError(f"import of {name!r} is not allowed in a tool")
        return real_import(name, globals, locals, fromlist, level)

    def guarded_open(file, mode="r", *a, **k):
        return real_open(check(file), mode, *a, **k)

    safe = {n: getattr(builtins, n) for n in SAFE_BUILTIN_NAMES if hasattr(builtins, n)}
    safe["__import__"] = guarded_import
    safe["open"] = guarded_open
    safe["__name__"] = "tool"

    class AttrDict(dict):
        def __getattr__(self, name):
            try:
                return self[name]
            except KeyError:
                raise AttributeError(name)

        def __setattr__(self, name, value):
            self[name] = value

    inputs = AttrDict(job.get("inputs") or {})
    ns = {
        "__builtins__": safe,
        "__name__": "tool",
        "inputs": inputs, "input_data": inputs, "input": inputs,
        **inputs,
        "json": json, "os": _OsProxy(check), "re": re, "math": math,
        "datetime": datetime, "collections": collections, "urllib": urllib,
        "TEMP_DIR": temp_dir,
        "result": None,
    }
    if network:
        import requests
        timeout = float(job.get("http_timeout") or 20)

        class TimeoutRequests:
            """requests with a default timeout on the HTTP-verb functions."""
            def __getattr__(self, name):
                attr = getattr(requests, name)
                if name in ("get", "post", "put", "patch", "delete", "head", "options", "request") and callable(attr):
                    def wrapped(*a, **k):
                        k.setdefault("timeout", timeout)
                        return attr(*a, **k)
                    return wrapped
                return attr
        ns["requests"] = TimeoutRequests()
    return ns


def _reply(payload: dict) -> None:
    payload["isolation"] = _isolation
    _PROTO.write(json.dumps(payload, default=str) + "\n")
    _PROTO.flush()


def main() -> None:
    job = json.loads(sys.stdin.readline())
    _apply_rlimits(job)
    if not job.get("network"):
        _drop_network()
        if "netns" not in _isolation:
            _block_sockets()
    os.chdir(job["temp_dir"])
    sys.stdout = sys.stderr  # tool print()s must not corrupt the reply line
    try:
        ns = _namespace(job)
        exec(compile(job["implementation"], "<tool>", "exec"), ns)
        result = ns.get("result", "No result returned.")
        try:
            json.dumps(result)
        except (TypeError, ValueError):
            result = str(result)
        _reply({"ok": True, "result": result})
    except BaseException as e:
        tb = e.__traceback__.tb_next if e.__traceback__ else None  # drop this runner's frame
        _reply({"ok": False, "error": "".join(traceback.format_exception(type(e), e, tb, limit=8))})


if __name__ == "__main__":
    main()

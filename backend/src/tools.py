import traceback
import builtins


# Allowlist of safe builtins for tool execution.
# open is included so save_output tools can write to /tmp.
# __import__ is included so tool code can import standard-library modules;
# requests, json, and os are pre-injected and don't need importing.
_SAFE_BUILTINS = {
    name: getattr(builtins, name)
    for name in (
        "print", "len", "range", "enumerate", "zip", "map", "filter",
        "sorted", "reversed", "list", "dict", "set", "tuple", "str",
        "int", "float", "bool", "type", "isinstance", "hasattr", "getattr",
        "min", "max", "sum", "abs", "round", "repr", "format",
        "any", "all", "next", "iter", "hash", "id",
        "open", "__import__", "dir", "vars", "globals", "locals", "callable",
        "Exception", "ValueError", "KeyError", "TypeError", "IOError",
        "StopIteration", "RuntimeError", "IndexError", "AttributeError",
    )
}


def execute_tool(implementation: str, inputs: dict) -> object:
    """Execute a Claude-generated tool implementation in a restricted namespace.

    The implementation string must assign its result to `result`.
    inputs are injected both as the `inputs` dict AND as top-level names,
    so generated code can use either inputs['query'] or just query directly.
    """
    import requests
    import json
    import os
    import tempfile

    namespace = {
        "__builtins__": _SAFE_BUILTINS,
        "inputs": inputs,
        **inputs,           # bare names: query, location, filename, etc.
        "requests": requests,
        "json": json,
        "os": os,
        "TEMP_DIR": tempfile.gettempdir(),  # platform-correct temp dir
        "result": None,
    }

    try:
        exec(compile(implementation, "<tool>", "exec"), namespace)
        return namespace.get("result", "No result returned.")
    except Exception:
        return f"Tool execution error:\n{traceback.format_exc()}"

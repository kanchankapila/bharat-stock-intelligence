"""One-off repair: dedupe duplicated top-level classes in a test module.

A retried append landed the same new test classes five times. Python silently
shadows a re-defined class, so the earlier copies' assertions never ran -- the
suite would have reported green while exercising only the last definition.
Keeps the LAST body of each method (latest edit wins) but preserves uniquely
named methods from earlier duplicates, and keeps first-occurrence class order.
"""
import ast
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
lines = src.splitlines(keepends=True)

tree = ast.parse(src)
# Top-level classes only, in source order.
cls_nodes = [n for n in tree.body if isinstance(n, ast.ClassDef)]
assert cls_nodes, "no top-level classes found"

def block(node):
    start = node.lineno - 1
    end = node.end_lineno
    return lines[start:end]

preamble = lines[: cls_nodes[0].lineno - 1]

# name -> {"idx": first position, "methods": {method_name: source lines}}
order = []
merged = {}
for node in cls_nodes:
    if node.name not in merged:
        merged[node.name] = {"idx": len(order), "methods": {}, "doc": None}
        order.append(node.name)
    entry = merged[node.name]
    for m in node.body:
        # decorators: ast.lineno points at the def, decorators start earlier
        start = min([m.lineno] + [d.lineno for d in getattr(m, "decorator_list", [])])
        # staticmethod/@property helpers live on the class body, not as methods
        key = getattr(m, "name", None) or f"__nonmethod_{start}"
        if key in entry["methods"]:
            continue  # later duplicate already recorded
        entry["methods"][key] = lines[start - 1 : m.end_lineno]

out = list(preamble)
for pos, name in enumerate(order):
    entry = merged[name]
    src_lines = [f"class {name}:\n"]
    seen = set()
    for key, body in entry["methods"].items():
        if key in seen:
            continue
        seen.add(key)
        src_lines.append("\n")
        src_lines.extend(body)
    out.append("".join(src_lines))
    out.append("\n")

# Keep exactly one trailing newline per class block; collapse triple blanks.
text = "".join(out)
while "\n\n\n\n" in text:
    text = text.replace("\n\n\n\n", "\n\n\n")
open(path, "w", encoding="utf-8").write(text)
print(f"deduped {len(cls_nodes)} class definitions -> {len(order)} classes")

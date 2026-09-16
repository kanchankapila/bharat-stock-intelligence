#!/usr/bin/env python3
"""Fix the audit_new_modules.py by removing corrupted TESTS block."""
import os

path = os.path.join(os.path.dirname(__file__), "audit_new_modules.py")
with open(path) as f:
    lines = f.readlines()

# Lines 41-43 contain the corrupted TESTS definition
# They are (1-indexed):
# 41: "TESTS = [\n"
# 42: "    \"src.server.tests.test_transaction_costs\",\n"
# 43: "    \"src.server.tests.test_dynamic_exit\",\n"
new_lines = []
for i, line in enumerate(lines, start=1):
    if i in (41, 42, 43):
        continue
    new_lines.append(line)

with open(path, "w") as f:
    f.writelines(new_lines)

print("Fixed: removed lines 41-43")
print(f"New line count: {len(new_lines)}")

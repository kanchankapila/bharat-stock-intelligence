"""Test fixture for pythonRunnerMemoryCeiling.test.ts: allocate N MB, then optionally import a module.

argv[2] == '__one_block__' allocates the N MB as ONE block instead of 50MB steps.
argv[2] == '__raise__' raises MemoryError without allocating (a MemoryError the ceiling did not cause).
"""
import sys

mb = int(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else None
if mode == "__raise__":
    raise MemoryError("synthetic: not caused by the job ceiling")
if mode == "__one_block__":
    blocks = bytearray(mb * 1024 * 1024)
else:
    blocks = [bytearray(50 * 1024 * 1024) for _ in range(max(1, mb // 50))]
    if mode:
        __import__(mode)
print(f"allocated {mb}")

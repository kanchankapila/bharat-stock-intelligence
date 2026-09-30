"""dl-trainer CUDA OOM (2026-09-27..30): pinned host memory accumulated across a multi-hour run.

_train_one_fold / _predict_batch called .pin_memory() on WHOLE datasets -- each 2.4GB training
chunk and every walk-forward fold (a different, growing size each time). PyTorch's caching host
allocator keeps freed pinned blocks (measured on this box: pinning then freeing 100..500MB left
private bytes 1,620 -> 2,521MB until torch._C._host_emptyCache()), and page-locked memory cannot
be paged out, so ~2.8h into each run the host could not satisfy any CUDA allocation -- even
torch.cuda.empty_cache() raised "CUDA error: out of memory". The retry's release only emptied the
DEVICE cache, so attempt 2 died at BiLSTMModel().to(DEVICE) on a few MB.
"""
import ast
import inspect
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import dl_engine


def test_dl_engine_never_pins_host_memory():
    tree = ast.parse(inspect.getsource(dl_engine))
    funcs = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]
    assert any(f.name == "_train_one_fold" for f in funcs), "scan found no training loop"
    calls = [n.lineno for n in ast.walk(tree)
             if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
             and n.func.attr == "pin_memory"]
    assert calls == [], f"pin_memory() at dl_engine.py lines {calls}: whole-dataset pinning leaks page-locked host memory"


def test_release_cuda_memory_empties_the_host_pinned_cache(monkeypatch):
    if dl_engine.torch is None:
        return
    calls = []
    monkeypatch.setattr(dl_engine.torch._C, "_host_emptyCache", lambda: calls.append("host"), raising=False)
    monkeypatch.setattr(dl_engine.torch.cuda, "empty_cache", lambda: calls.append("device"))
    monkeypatch.setattr(dl_engine, "DEVICE", dl_engine.torch.device("cuda"))
    dl_engine.release_cuda_memory()
    assert "host" in calls and "device" in calls

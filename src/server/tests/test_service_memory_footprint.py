"""The long-running pm2 Python services must not hold torch for nothing (2026-11-06).

Measured on the 23GB host that day: alphaquant-api 2,661MB, ml-api 2,332MB and chatbot 2,860MB
private, each with torch and the cu128 CUDA/cuDNN DLLs mapped, while only ~16MB of each was in
RAM -- idle commit pushed to the page file, with the box paging ~7,300 pages/s. `import torch`
alone costs ~830MB of private commit here even with CUDA hidden. None of the three services
needs torch on its routine path:

  * alphaquant-api got it from nlp_engine's module-level `from transformers import pipeline`
    (via scoring_engine), but FinBERT only runs when screener_master meets a NEW screener.
  * ml-api imported dl_engine at module level for /api/train-dl and /api/infer-dl, which no
    TypeScript caller uses (DL runs as runPython subprocesses).
  * both had an eager `import torch` "to avoid WinError 1114"; a late `import torch` and
    `import dl_engine` after each service's full import set were re-tested on torch 2.9.1 and
    load cleanly.

Each check runs in a clean interpreter: what matters is sys.modules after a real import.
"""
import ast
import subprocess
import sys
import types
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
REPO = SERVER_DIR.parents[1]


def _torch_after(code: str, cwd: Path) -> str:
    out = subprocess.run(
        [sys.executable, "-c", code + "\nimport sys\nprint('TORCH=' + str('torch' in sys.modules))"],
        cwd=cwd, capture_output=True, text=True, timeout=300,
        env={**__import__("os").environ, "CUDA_VISIBLE_DEVICES": "-1", "USE_FINBERT": "true"},
    )
    assert out.returncode == 0, out.stderr[-3000:]
    return out.stdout


def test_nlp_engine_and_finbert_construction_do_not_load_torch():
    out = _torch_after("import nlp_engine\nnlp_engine.NLPScreenerInference()", SERVER_DIR)
    assert "TORCH=False" in out


def test_scoring_engine_import_does_not_load_torch():
    assert "TORCH=False" in _torch_after("import scoring_engine", SERVER_DIR)


def test_ml_api_import_does_not_load_torch():
    assert "TORCH=False" in _torch_after("import python_api", SERVER_DIR)


def _module_level_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in tree.body:
        for sub in ast.walk(node) if isinstance(node, ast.Try) else [node]:
            if isinstance(sub, ast.Import):
                names.update(a.name.split(".")[0] for a in sub.names)
            elif isinstance(sub, ast.ImportFrom) and sub.module:
                names.add(sub.module.split(".")[0])
    return names


def test_service_entrypoints_have_no_eager_torch_import():
    # main.py is checked by AST rather than imported: importing it attaches a rotating file
    # handler under logs/, and a test must not write into the production log directory.
    for entry in (REPO / "backend-python" / "main.py", SERVER_DIR / "python_api.py"):
        found = _module_level_imports(entry)
        assert found, f"scan found no imports in {entry} -- the scan is broken"
        assert "torch" not in found, f"{entry.name} imports torch at module level"
        assert "dl_engine" not in found, f"{entry.name} imports dl_engine at module level"


class _FakePipeline:
    def __init__(self):
        self.calls = 0

    def __call__(self, task, model, device):
        self.calls += 1
        return lambda text: [{"label": "positive", "score": 0.91}]


def test_finbert_loads_once_on_first_predict(monkeypatch):
    import nlp_engine

    fake = _FakePipeline()
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace(pipeline=fake))
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: False)))
    monkeypatch.setenv("USE_FINBERT", "true")

    fb = nlp_engine.FinBERTInference()
    assert fake.calls == 0, "FinBERT model loaded at construction"
    first = fb.predict("profit beats estimates")
    second = fb.predict("revenue grows")
    assert fake.calls == 1
    assert first["available"] is True and first["sentiment"] == "bullish"
    assert second["available"] is True


def test_finbert_disabled_never_loads(monkeypatch):
    import nlp_engine

    fake = _FakePipeline()
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace(pipeline=fake))
    monkeypatch.setenv("USE_FINBERT", "false")
    res = nlp_engine.FinBERTInference().predict("profit beats estimates")
    assert fake.calls == 0
    assert res["available"] is False


def test_finbert_unavailable_transformers_falls_back(monkeypatch):
    import nlp_engine

    monkeypatch.setitem(sys.modules, "transformers", None)  # import raises ImportError
    monkeypatch.setenv("USE_FINBERT", "true")
    fb = nlp_engine.FinBERTInference()
    assert fb.predict("x")["available"] is False
    assert fb.predict("y")["available"] is False

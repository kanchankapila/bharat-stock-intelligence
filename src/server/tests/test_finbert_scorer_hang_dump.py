"""finbert_scorer must dump its stacks before ml-daily-ops kills it (queues.ts: 180_000 ms).

Two runs on 2026-11-06 stalled before "Model loaded" and were killed with no stderr, so the
stall location was unknowable. The dump has to be armed BEFORE the model load and fire inside
the runner's budget, or the next stall is just as silent.
"""
import faulthandler
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import finbert_scorer  # noqa: E402

RUNNER_BUDGET_S = 180


def test_stack_dump_armed_before_model_load_and_inside_budget(monkeypatch):
    armed = []
    monkeypatch.setattr(faulthandler, "dump_traceback_later",
                        lambda timeout, **kw: armed.append((timeout, kw)))

    def load_model():
        assert armed, "stack dump must be armed before the model load starts"
        raise RuntimeError("stop after load")

    monkeypatch.setattr(finbert_scorer, "load_model", load_model)
    with pytest.raises(RuntimeError, match="stop after load"):
        finbert_scorer.run(dry_run=True)

    timeout, kw = armed[0]
    assert timeout < RUNNER_BUDGET_S
    assert kw.get("exit") is False


def test_news_sentiment_arms_stack_dump_inside_its_runner_budget():
    # newsSentimentService.ts runs finbert_news_sentiment.py with a 420_000 ms budget; the dump
    # must be armed at module entry (before FinBERT loads) and fire inside it.
    import ast, re
    root = os.path.join(os.path.dirname(__file__), "..")
    ts = open(os.path.join(root, "newsSentimentService.ts"), encoding="utf-8").read()
    budget_s = int(re.search(r"finbert_news_sentiment\.py'[^)]*?(\d[\d_]*)\)", ts).group(1).replace("_", "")) / 1000
    tree = ast.parse(open(os.path.join(root, "finbert_news_sentiment.py"), encoding="utf-8").read())
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
             and getattr(n.func, "attr", None) == "dump_traceback_later"]
    assert calls, "finbert_news_sentiment.py must arm faulthandler.dump_traceback_later"
    assert calls[0].args[0].value < budget_s

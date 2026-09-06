"""Measure whether dl_engine's walk-forward validation is inflated by seeding from a
model that already trained on the validation symbols (AF-20260906-02).

The suspicion, from reading `train_lstm`:

    model = BiLSTMModel(); ...train over sequences from EVERY symbol...
    val_symbols = symbols[:min(50, len(symbols))]          # <- a subset of what it trained on
    metrics = walk_forward_validate(model, X_val, ...)     # <- seeded from the trained model

and inside each fold:

    model_copy.load_state_dict(model.state_dict())         # <- already saw the test period
    _train_one_fold(model_copy, X_tr, ...); predict(X_te)

The expanding window separates each fold's train slice from its own test slice, but nothing
separates either from the initial full-universe fit. If that matters, every roc_auc in
dl_model_config.json -- the number `_promote_lstm_version` gates on -- is inflated, and the
gate has been comparing one inflated number against another.

THE MEASUREMENT (deliberately cheap -- no full retrain):
  Arm A "seeded"  : walk_forward_validate seeded from the ACTIVE champion checkpoint. That
                    checkpoint was trained on these symbols, so this reproduces the suspected
                    condition exactly.
  Arm B "fresh"   : identical data, identical folds, identical epochs -- seeded from a
                    randomly-initialised model, which is what an honest walk-forward means.

Both arms train the same number of epochs per fold on the same slices, so the ONLY difference
is whether the starting weights had already seen the test period. A large A-B gap in roc_auc is
the leak; a small one means the seeding does not matter much and the gate's numbers stand.

This does not change any behaviour. measurement.md requires measuring before altering a
promotion gate, and this is that measurement.

Usage:
  python scripts/measure_dl_walkforward_leak.py [--symbols 50] [--folds 2000] [--seeds 2]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "server"))

import numpy as np  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", type=int, default=50, help="validation symbols (train_lstm uses 50)")
    ap.add_argument("--folds", type=int, default=2000, help="fold_size passed to walk_forward_validate")
    ap.add_argument("--seeds", type=int, default=2, help="repeats of the FRESH arm, to size run-to-run noise")
    args = ap.parse_args()

    import torch
    import dl_engine as dl

    cfg = dl._load_config()
    version = cfg.get("lstm_version", 1)
    ckpt = dl.MODEL_DIR / f"lstm_v{version}.pt"
    if not ckpt.exists():
        print(f"FAIL: active checkpoint {ckpt} is missing; cannot run the seeded arm.")
        return 2

    state = torch.load(ckpt, map_location=dl.DEVICE, weights_only=True)
    width = dl._checkpoint_input_width(state)
    print(f"[LEAK] active champion v{version}, input width {width}")

    # Exactly train_lstm's selection: the FIRST N symbols, which is the population the
    # champion also trained on.
    symbols = dl.get_training_symbols() if hasattr(dl, "get_training_symbols") else None
    if symbols is None:
        from db_compat import query_all
        symbols = [r["symbol"] for r in query_all(
            "SELECT DISTINCT symbol FROM feature_store WHERE timeframe='D' ORDER BY symbol")]
    val_symbols = symbols[:args.symbols]
    print(f"[LEAK] loading {len(val_symbols)} validation symbols")

    Xs, y5s, y15s, yr5s = [], [], [], []
    for sym in val_symbols:
        try:
            X, y5, y15, yr5, _ = dl.load_symbol_sequences(sym, n_features=width)
            if len(X) > 0:
                Xs.append(X); y5s.append(y5); y15s.append(y15); yr5s.append(yr5)
        except Exception as e:
            print(f"  skip {sym}: {e}")
    if not Xs:
        print("FAIL: no validation sequences loaded.")
        return 2

    X = np.concatenate(Xs); y5 = np.concatenate(y5s)
    y15 = np.concatenate(y15s); yr5 = np.concatenate(yr5s)
    print(f"[LEAK] {len(X)} sequences, width {X.shape[-1]}")

    def seeded_model():
        m = dl.BiLSTMModel(n_features=width).to(dl.DEVICE)
        m.load_state_dict(state)
        return m

    def fresh_model():
        return dl.BiLSTMModel(n_features=width).to(dl.DEVICE)

    print("\n[LEAK] ARM A -- seeded from the trained champion (reproduces current behaviour)")
    a = dl.walk_forward_validate(seeded_model(), X, y5, y15, yr5, fold_size=args.folds)
    print(f"       roc_auc={a.get('roc_auc')}  dir_acc={a.get('directional_accuracy')} "
          f"folds={a.get('n_folds')} saturated={a.get('frac_saturated')}")

    fresh_aucs = []
    for i in range(args.seeds):
        torch.manual_seed(1234 + i)
        print(f"\n[LEAK] ARM B -- fresh init, repeat {i + 1}/{args.seeds}")
        b = dl.walk_forward_validate(fresh_model(), X, y5, y15, yr5, fold_size=args.folds)
        print(f"       roc_auc={b.get('roc_auc')}  dir_acc={b.get('directional_accuracy')} "
              f"folds={b.get('n_folds')} saturated={b.get('frac_saturated')}")
        if b.get("roc_auc") is not None and b["roc_auc"] == b["roc_auc"]:
            fresh_aucs.append(b["roc_auc"])

    print("\n" + "=" * 72)
    a_auc = a.get("roc_auc")
    if not fresh_aucs or a_auc is None or a_auc != a_auc:
        print("VERDICT: inconclusive -- an arm produced no usable roc_auc.")
        return 1
    mean_fresh = float(np.mean(fresh_aucs))
    spread = (max(fresh_aucs) - min(fresh_aucs)) if len(fresh_aucs) > 1 else float("nan")
    delta = a_auc - mean_fresh
    print(f"seeded roc_auc      : {a_auc:.4f}")
    print(f"fresh  roc_auc mean : {mean_fresh:.4f}   (n={len(fresh_aucs)}, spread={spread:.4f})")
    print(f"delta (seeded-fresh): {delta:+.4f}")
    # The comparison must clear the FRESH arm's own run-to-run spread, or the delta is seed
    # noise -- the same trap ml-model-bugs.md records for the regime-HMM promotion gate, where
    # a champion/challenger verdict turned out to be decided by EM seed luck.
    if len(fresh_aucs) > 1 and spread == spread and abs(delta) <= spread:
        print("VERDICT: delta is within the fresh arm's own seed spread -- NOT evidence of a leak.")
    elif delta > 0.02:
        print("VERDICT: seeded arm is materially higher -- consistent with the suspected leak. "
              "Every recorded lstm_metrics roc_auc is then inflated and the promotion gate has "
              "been comparing inflated against inflated.")
    else:
        print("VERDICT: no material inflation from seeding; the gate's numbers stand on this test.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

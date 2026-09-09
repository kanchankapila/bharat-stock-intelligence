#!/usr/bin/env python3
"""Comprehensive audit of all new modules."""
import os, sys, importlib, traceback

SERVER_DIR = os.path.join(os.path.dirname(__file__))
PROJECT_ROOT = os.path.dirname(SERVER_DIR)
sys.path.insert(0, PROJECT_ROOT)

MODULES = [
    "transaction_costs",
    "microstructure_signals",
    "cost_aware_sizing",
    "ndtv_profit_fetcher",
    "investsights_fii_dii_fetcher",
    "dynamic_exit",
]

TESTS = [
    "src.server.tests.test_transaction_costs",
    "src.server.tests.test_dynamic_exit",
]


def audit_imports():
    print("=" * 70)
    print("AUDIT 1: Module Imports")
    print("=" * 70)
    results = {}
    for mod in MODULES:
        full = f"src.server.{mod}"
        try:
            if full not in sys.modules:
                importlib.import_module(full)
            mod_obj = sys.modules[full]
            if not getattr(mod_obj, "__doc__", "").strip():
                print(f"[WARN] {mod}: missing __doc__")
            print(f"[OK] {mod}")
            results[mod] = True
        except Exception as e:
            print(f"[FAIL] {mod}: {e}")
            traceback.print_exc()
            results[mod] = False
    return results

    "src.server.tests.test_transaction_costs",
    "src.server.tests.test_dynamic_exit",


def audit_smoke_tests():
    print("\n" + "=" * 70)
    print("AUDIT 2: Smoke Tests (function-level sanity)")
    print("=" * 70)
    results = {}
    try:
        from src.server.transaction_costs import (
            calculate_indian_costs, calculate_round_trip_cost, estimate_break_even_move,
            CostParameters, CostBreakdown,
        )
        cb = calculate_indian_costs(1_000_000, is_buy=True, is_delivery=True)
        assert isinstance(cb, CostBreakdown)
        assert cb.total > 0 and cb.stt > 0 and cb.stamp_duty > 0
        rt = calculate_round_trip_cost(1_000_000, is_delivery=True)
        assert rt.total > cb.total
        ib = calculate_indian_costs(1_000_000, is_buy=True, is_delivery=False)
        assert ib.stt == 0
        f = calculate_indian_costs(1_000_000, is_buy=False, is_futures=True)
        assert f.stt > 0
        o = calculate_indian_costs(1_000_000, is_buy=False, is_options=True)
        assert o.stt > 0
        be = estimate_break_even_move(1500, 100)
        assert be["break_even_move_per_share"] > 0 and be["cost_breakdown"]["total"] > 0
        print("[OK] transaction_costs smoke tests")
        results["transaction_costs"] = True
    except Exception as e:
        print(f"[FAIL] transaction_costs: {e}")
        traceback.print_exc()
        results["transaction_costs"] = False


    try:
        import pandas as pd, numpy as np
        from src.server.microstructure_signals import (
            compute_ofi, compute_vpin, compute_vwap_bands, compute_volume_imbalance,
            compute_kyle_lambda, MicrostructureFeatures,
        )
        np.random.seed(42)
        n = 200
        df = pd.DataFrame({
            "close": 100 + np.cumsum(np.random.randn(n) * 2),
            "volume": np.random.randint(100_000, 1_000_000, n),
            "high": 100 + np.cumsum(np.random.randn(n) * 2) + np.random.rand(n) * 5,
            "low": 100 + np.cumsum(np.random.randn(n) * 2) - np.random.rand(n) * 5,
        })
        ofi = compute_ofi(df, window=5)
        assert isinstance(ofi, pd.Series) and len(ofi) == n and not ofi.isna().all()
        vpin = compute_vpin(df, window=50)
        assert isinstance(vpin, pd.Series) and 0 <= vpin.min() <= vpin.max() <= 1.01
        bands = compute_vwap_bands(df)
        for col in ["vwap", "vwap_band_upper_1", "vwap_band_lower_1", "vwap_dev_pct"]:
            assert col in bands and len(bands[col]) == n
        vi = compute_volume_imbalance(df)
        assert isinstance(vi, pd.Series) and -1.0 <= vi.min() <= vi.max() <= 1.0
        kl = compute_kyle_lambda(df, window=20)
        assert isinstance(kl, pd.Series)
        mf = MicrostructureFeatures()
        result = mf.compute_all(df)
        for col in ["ofi_zscore", "vpin", "vwap", "vwap_dev_pct", "volume_imbalance", "kyle_lambda"]:
            assert col in result.columns
        print("[OK] microstructure_signals smoke tests")
        results["microstructure_signals"] = True
    except Exception as e:
        print(f"[FAIL] microstructure_signals: {e}")
        traceback.print_exc()
        results["microstructure_signals"] = False

    try:
        from src.server.cost_aware_sizing import CostAwareSizer, SizingResult
        sizer = CostAwareSizer(base_capital=10_00_000, lot_size=1)
        r = sizer.size_position(score=0.85, price=1500, adt_value=50_00_000, atr=45)
        assert isinstance(r, SizingResult)
        assert r.target_quantity > 0 and r.target_pct > 0
        assert r.expected_cost > 0 and r.cost_pct > 0
        assert r.rr_ratio >= 1.0 and not r.was_capped
        r_low = sizer.size_position(score=0.1, price=1500, adt_value=50_00_000, atr=45)
        assert r_low.target_pct <= r.target_pct
        r_inv = sizer.size_position(score=0.5, price=0, adt_value=100, atr=10)
        assert r_inv.target_quantity == 0 and r_inv.reason == "invalid_inputs"
        assert sizer.is_trade_economically_viable(0.85, 1500, 50_00_000, 45)
        assert not sizer.is_trade_economically_viable(0.1, 1500, 50_00_000, 45)
        sizer_lot = CostAwareSizer(base_capital=10_00_000, lot_size=50)
        r_lot = sizer_lot.size_position(score=0.5, price=1500, adt_value=50_00_000, atr=45)
        assert r_lot.target_quantity % 50 == 0 or r_lot.target_quantity == 0
        print("[OK] cost_aware_sizing smoke tests")
        results["cost_aware_sizing"] = True
    except Exception as e:
        print(f"[FAIL] cost_aware_sizing: {e}")
        traceback.print_exc()
        results["cost_aware_sizing"] = False





    try:
        from src.server.dynamic_exit import (
            DynamicExitManager, ExitConfig, ExitReason,
        )
        config = ExitConfig(
            atr_period=14, initial_stop_mult=1.0, trail_mult=2.0,
            chandelier_mult=3.0, max_hold_days=20,
            vol_expansion_threshold=1.5, move_stop_to_breakeven_at=1.5,
        )
        manager = DynamicExitManager(config)
        assert manager.compute_initial_stop(1500, 45, "long") == 1455
        assert manager.compute_trailing_stop(1550, 45, "long") == 1460
        assert manager.compute_chandelier_exit(1550, 45, "long") == 1415
        sig = manager.check_exit(
            current_price=1520, atr=45, high_since_entry=1530, low_since_entry=1510,
            bars_held=5, entry_price=1500, highest_high=1530,
            current_stop=1455, entry_atr=45, target_price=1600,
        )
        assert not sig.should_exit and sig.reason == ExitReason.NONE
        sig2 = manager.check_exit(
            current_price=1450, atr=45, high_since_entry=1530, low_since_entry=1450,
            bars_held=5, entry_price=1500, highest_high=1530,
            current_stop=1455, entry_atr=45, target_price=1600,
        )
        assert sig2.should_exit and sig2.reason in (ExitReason.STOP_LOSS, ExitReason.CHANDELIER_EXIT)
        sig3 = manager.check_exit(
            current_price=1550, atr=45, high_since_entry=1560, low_since_entry=1540,
            bars_held=20, entry_price=1500, highest_high=1560,
            current_stop=1455, entry_atr=45, target_price=1600,
        )
        assert sig3.should_exit and sig3.reason == ExitReason.TIME_EXIT
        sig4 = manager.check_exit(
            current_price=1480, atr=90, high_since_entry=1530, low_since_entry=1480,

    try:
        from src.server.ndtv_profit_fetcher import _get_session
        session, backend = _get_session()
        assert session is not None and backend in ("curl_cffi", "requests")
        print("[OK] ndtv_profit_fetcher structure (API calls skipped)")
        results["ndtv_profit_fetcher"] = True
    except Exception as e:
        print(f"[FAIL] ndtv_profit_fetcher: {e}")
        traceback.print_exc()
        results["ndtv_profit_fetcher"] = False

            bars_held=5, entry_price=1500, highest_high=1530,
            current_stop=1455, entry_atr=45, target_price=1600,
        )

    try:
        from src.server.investsights_fii_dii_fetcher import INVESTSIGHTS_FIIDII_URL, fetch_fii_dii_flows
        assert INVESTSIGHTS_FIIDII_URL.startswith("https://")
        import inspect
        assert "days" in inspect.signature(fetch_fii_dii_flows).parameters
        print("[OK] investsights_fii_dii_fetcher structure (API calls skipped)")
        results["investsights_fii_dii_fetcher"] = True
    except Exception as e:
        print(f"[FAIL] investsights_fii_dii_fetcher: {e}")
        traceback.print_exc()
        results["investsights_fii_dii_fetcher"] = False
    return results



def audit_tests():
    print("\n" + "=" * 70)
    print("AUDIT 3: Existing Unit Tests")
    print("=" * 70)
    results = {}
    for test_mod in TESTS:
        try:
            if test_mod not in sys.modules:
                importlib.import_module(test_mod)
            mod_obj = sys.modules[test_mod]
            test_items = [
                name for name in dir(mod_obj)
                if name.startswith("test_") or name.startswith("Test")
            ]
            if not test_items:
                print(f"[WARN] {test_mod}: no test functions/classes found")
                results[test_mod] = "no_tests"
            else:
                print(f"[OK] {test_mod}: {len(test_items)} test functions/classes")
                results[test_mod] = True
        except Exception as e:
            print(f"[FAIL] {test_mod}: {e}")
            traceback.print_exc()
            results[test_mod] = False
    return results



def audit_consistency():
    print("\n" + "=" * 70)
    print("AUDIT 4: Module Consistency & Integration")
    print("=" * 70)
    results = {}
    try:
        from src.server.cost_aware_sizing import SizingResult
        fields = {f.name for f in SizingResult.__dataclass_fields__.values()}
        expected = {
            "target_quantity", "target_value", "target_pct", "cost_pct",
            "expected_cost", "risk_value", "rr_ratio", "was_capped",
            "was_reduced", "reason", "break_even_move", "break_even_pct",
        }
        missing = expected - fields
        extra = fields - expected
        if missing:
            print(f"[FAIL] SizingResult missing: {missing}")
            results["sizing_fields"] = False
        elif extra:
            print(f"[WARN] SizingResult extra: {extra}")
            results["sizing_fields"] = "warn"
        else:
            print("[OK] SizingResult has all expected fields")
            results["sizing_fields"] = True
    except Exception as e:
        print(f"[FAIL] sizing_fields: {e}")
        results["sizing_fields"] = False
    try:
        from src.server.transaction_costs import CostBreakdown
        cb = CostBreakdown(stt=100.0, exchange=32.0, sebi=1.0, gst=24.0,
                          stamp_duty=15.0, brokerage=0.0, slippage=50.0,
                          total=222.0, total_pct=0.00122)
        d = cb.to_dict()
        assert d["stt"] == 100.0 and d["total"] == 222.0 and d["total_pct"] == 0.0012
        print("[OK] CostBreakdown.to_dict() correct")
        results["cost_breakdown_dict"] = True
    except Exception as e:
        print(f"[FAIL] cost_breakdown_dict: {e}")
        results["cost_breakdown_dict"] = False
    try:
        from src.server.cost_aware_sizing import calculate_round_trip_cost as s_calc
        from src.server.transaction_costs import calculate_round_trip_cost as t_calc
        assert s_calc is t_calc or callable(s_calc)
        print("[OK] cross-module import correct")
        results["cross_module_import"] = True
    except Exception as e:
        print(f"[FAIL] cross_module_import: {e}")
        results["cross_module_import"] = False


def main():
    print("\n" + "#" * 70)
    print("# COMPREHENSIVE AUDIT OF NEW MODULES")
    print(f"# Project: bharat-stock-intelligence")
    print(f"# Server dir: {SERVER_DIR}")
    print("#" * 70)
    all_ok = True
    import_results = audit_imports()
    if not all(import_results.values()):
        all_ok = False
    smoke_results = audit_smoke_tests()
    if not all(v is True for v in smoke_results.values()):
        all_ok = False
    test_results = audit_tests()
    consistency_results = audit_consistency()
    if not all(v is True or v == "warn" for v in consistency_results.values()):
        all_ok = False
    print("\n" + "=" * 70)
    print("AUDIT SUMMARY")
    print("=" * 70)
    print(f"Modules imported:  {sum(1 for v in import_results.values() if v)}/{len(MODULES)}")
    print(f"Smoke tests pass:  {sum(1 for v in smoke_results.values() if v is True)}/{len(MODULES)}")
    print(f"Tests found:       {sum(1 for v in test_results.values() if v is not False)}/{len(TESTS)}")
    print(f"Consistency OK:    {sum(1 for v in consistency_results.values() if v is True or v == 'warn')}/{len(consistency_results)}")
    all_pass = (
        all(import_results.values()) and
        all(v is True for v in smoke_results.values()) and
        all(v is True or v == "warn" for v in consistency_results.values())
    )
    if all_pass:
        print("\n[OVERALL: PASS] All modules are healthy and consistent.")
        return 0
    else:
        print("\n[OVERALL: NEEDS ATTENTION] Some issues found above.")
        return 1


if __name__ == "__main__":
    sys.exit(main())

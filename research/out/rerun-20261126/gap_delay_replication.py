"""Read-only: grade the shadow arm's own code over the in-sample window; it should match opportunities.txt O2."""
import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "src", "server"))
import gap_up_delay_shadow as G  # noqa: E402
from db_compat import connect  # noqa: E402

con = connect()
con.execute("SET statement_timeout = '60s'")
p = dict(G.PROTOCOL, start_date="2026-08-01")
days, pending = G.grade(con, p, set())
con.rollback()
con.close()
graded = [x for x in days if x["status"] == "graded"]
sized = [x for x in days if x["reason"] not in ("no_buy_names", "no_preopen")]
print("all sized days", len(sized), "gap-up", sum(x["n_up"] for x in sized), "other", sum(x["n_other"] for x in sized))
for x in days:
    if x["reason"] == "too_few_others" or (x["status"] == "graded" and x["n_other"] < 15):
        print(" thin", x["d"], x["reason"], x["n_up"], x["n_other"], x["drops"])
s = G.summarise(days, dict(p, verdict_graded_days=10_000))
print("days", len(days), "with a result", len(graded), "pending", len(pending), s["days_without_d"])
print("gap-up names", sum(x["n_up"] for x in graded), "other", sum(x["n_other"] for x in graded),
      "locked", sum(x["locked_up"] for x in graded))
print(f"D {s['mean_D']:+.3f}% t {s['t']:+.2f} halves {s['halves'][0]:+.3f}/{s['halves'][1]:+.3f} "
      f"gap-up saving {s['mean_gap_up_save']:+.3f}% always-delay {s['mean_always_delay_save']:+.3f}%")
print("study O2: graded 51, gap-up 470, other 5495, D +0.325% t +1.37 halves +0.516/+0.142")

"""
Automated Onboarding Script for all 74 Python fetchers to BaseFetcher / Ingress Governor.
"""

import glob
import os
import py_compile
import re

FETCHERS_DIR = "src/server"

DOMAIN_MAP = {
    "nse": "nseindia.com",
    "mc": "moneycontrol.com",
    "moneycontrol": "moneycontrol.com",
    "trendlyne": "trendlyne.com",
    "marketsmojo": "marketsmojo.com",
    "investsights": "investsights.in",
    "mf": "amfiindia.com",
    "nt": "niftytrader.in",
    "tickertape": "tickertape.in",
    "stockedge": "stockedge.com",
}

def detect_domain(filename: str) -> str:
    base = os.path.basename(filename).lower()
    for prefix, dom in DOMAIN_MAP.items():
        if prefix in base:
            return dom
    return "general"

def onboard_fetcher(filepath: str):
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    if "BaseFetcher" in content or "governed_fetcher" in content:
        return False  # Already onboarded

    domain = detect_domain(filepath)
    fname_clean = os.path.basename(filepath).replace(".py", "").title().replace("_", "")
    schema_name = f"{fname_clean}Schema"
    fetcher_class = f"{fname_clean}BaseFetcher"

    header_injection = f"\nfrom pydantic import BaseModel\nfrom base_fetcher import BaseFetcher, governed_fetcher\n\nclass {schema_name}(BaseModel):\n    symbol: str | None = None\n    date: str | None = None\n\nclass {fetcher_class}(BaseFetcher[{schema_name}]):\n    fetcher_name = '{fname_clean}'\n    domain = '{domain}'\n    schema = {schema_name}\n    min_interval_sec = 0.5\n"

    # Insert imports right after docstring or top comments
    lines = content.splitlines()
    insert_idx = 0
    in_docstring = False
    for i, line in enumerate(lines[:40]):
        stripped = line.strip()
        if stripped.startswith('"""') or stripped.startswith("'''"):
            if in_docstring:
                insert_idx = i + 1
                break
            else:
                in_docstring = True
                if stripped.count('"""') >= 2 or stripped.count("'''") >= 2:
                    insert_idx = i + 1
                    break
        elif not in_docstring and (stripped.startswith("import ") or stripped.startswith("from ")):
            insert_idx = i
            break

    if insert_idx == 0:
        insert_idx = len(lines)

    lines.insert(insert_idx, header_injection)
    new_content = "\n".join(lines)

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(new_content)

    py_compile.compile(filepath, doraise=True)
    return True

def main():
    fetchers = glob.glob(os.path.join(FETCHERS_DIR, "*fetcher*.py"))
    count = 0
    for f in fetchers:
        if f.endswith("base_fetcher.py"):
            continue
        if onboard_fetcher(f):
            count += 1
            print(f"Onboarded: {os.path.basename(f)}")
    print(f"\nSuccessfully onboarded {count} fetchers to BaseFetcher / Ingress Governor!")

if __name__ == "__main__":
    main()

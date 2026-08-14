---
description: Sweep every multi-writer table for enum-case collisions, provider-missing-from-PK, derived-key upserts, and provenance columns caught in ON CONFLICT DO UPDATE — the collision family that has independently bitten this repo 4+ times
---

# Cross-Writer Collision Audit

Read the "Writes & keys" section of `.claude/rules/recurring-bugs.md` and the "Composite
primary keys for provider-issued ids" section of `.claude/rules/data-sources.md` in full
first. Every example below was found by hand, one incident at a time, over several sessions:
`signal_source` carrying both `technical` and `TECHNICAL` from two producers; `screener_catalog`
keyed `(screener_id, source)` with three writers picking three different casings for `source`
(`trendlyne`/`Trendlyne`, `moneycontrol`/`MoneyControl`, `etnow`/`ETnow`) so 1,707/2,539 rows
duplicated and 212 disagreed on `signal_bias`; `signal_generated_at` sitting in three writers'
`ON CONFLICT DO UPDATE SET` and turning a generation timestamp into a last-seen timestamp on
29,433 rows; `trendlyne_screeners` upserting on a name-derived slug instead of the provider's own
`screenpk`, silently discarding the old pk on every reassignment. This audit is the repeatable
sweep none of those incidents had — do not wait for a fifth occurrence to justify running it.

## 1. Enumerate every table with more than one writer

Grep for the write surface, not a remembered list — the same "hand-enumerated allowlist only
guards what someone remembered" lesson applies here as in `/data-coverage-audit`:

```bash
# candidate INSERT/UPSERT targets across both languages
grep -rEho "(INSERT INTO|ON CONFLICT)\s+\(?\s*([a-z_]+)" src/server --include=*.ts --include=*.py \
  | grep -oE '[a-z_]+$' | sort | uniq -c | sort -rn
```

For each table name that appears in more than one distinct source file's write path, record
every writer file + the exact `ON CONFLICT` / upsert-key clause it uses.

## 2. Four fixed probes, run against every multi-writer table found

**a. Enum/label case collision.** Any `varchar`/`text` column read with `IN`/`NOT IN`/`=` that
holds a small fixed vocabulary (`source`, `signal_source`, `sentiment`, `bias`, `status`,
`category`) written by more than one producer:

```sql
SELECT column_name FROM information_schema.columns WHERE table_name = '<table>';
-- for each candidate enum-ish column:
SELECT DISTINCT <col> FROM <table>;  -- do two spellings of the same value coexist?
SELECT <group_col>, COUNT(DISTINCT <label_col>) c
FROM <table> GROUP BY <group_col> HAVING COUNT(DISTINCT <label_col>) > 1;
```

**b. Provider-issued id missing from the primary key.** Any table storing a `scan_id`/
`screener_id`/`screenpk`/rating id issued independently by more than one external provider:
confirm the PK is `(source, provider_id)`, not `provider_id` alone. If it's the latter, check
for cross-provider range overlap — this has been a *confirmed* collision, not theoretical, three
separate times (`screener_master`, `screener_reliability`, `screener_performance_v2`).

**c. Upsert keyed on a derived value instead of the provider's own id.** Any `ON CONFLICT(<col>)`
where `<col>` is computed from a name/label (`.lower().replace(' ', '-')`, a slug, a hash) rather
than an id the provider issued. Check whether the provider is known to reassign ids to the same
logical entity (Trendlyne does, for `screenpk`) — if the derived key stays stable across a
reassignment, the old id silently vanishes with no error. Low severity if content isn't lost
(current fetch still wins), but flag it: anything keying a lookup on a *specific historical id*
rather than the current name/slug will silently miss.

**d. A "generated_at"/"created_at"-shaped column present in an `ON CONFLICT DO UPDATE SET` list.**
Grep each writer's upsert for `excluded.<timestamp_col>` where the column name implies a fixed
generation moment rather than a rolling last-seen time:

```sql
SELECT COUNT(*) FROM <table> WHERE <generated_col> > created_at;  -- logically impossible if the name means what it says
```

Any non-zero count is proof the column has been walked forward by re-runs, independent of NULL
rate — this is the "the tell is not a NULL" class, and no schema constraint catches it.

## 3. Report

One row per confirmed collision: table, the two (or more) writers involved, which of the four
probes it tripped, and the measured blast radius (row count / % affected — not just "this could
happen"). For (a)/(c)/(d), state the fix shape from the precedent already in this repo (harmonize
by shared logical key per `fix_screener_catalog_source_casing.py`'s approach, not a bare rename)
rather than proposing a novel one. Do not fix in the same pass unless asked — a merge/backfill
here has repeatedly turned out to need a dry-run review first (`fix_screener_catalog_source_casing.py`
was reviewed dry-run before `--apply`).

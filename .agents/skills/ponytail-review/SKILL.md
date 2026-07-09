---
name: ponytail-review
description: >
  Code review focused exclusively on over-engineering. Finds what to delete:
  reinvented standard library, unneeded dependencies, speculative abstractions,
  dead flexibility. One line per finding: location, what to cut, what replaces
  it. Use when the user says "review for over-engineering", "what can we
  delete", "is this over-engineered", "simplify review", or invokes
  /ponytail-review. Complements correctness-focused review, this one only
  hunts complexity.
---

Review diffs for unnecessary complexity. One line per finding: location, what
to cut, what replaces it. The diff's best outcome is getting shorter.

## Format

`L<line>: <tag> <what>. <replacement>.`, or `<file>:L<line>: ...` for
multi-file diffs.

Tags:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## Examples

❌ "This EmailValidator class might be more complex than strictly necessary given our requirements..."
✅ `L14: yagni EmailValidator class. Replace with regex check inside register().`

❌ "Consider whether lodash is needed here..."
✅ `L3: stdlib lodash.groupBy. Replace with Object.groupBy (Node 21+ / ES2024).`

❌ "We could probably remove the feature flag since it's always true..."
✅ `L88: delete USE_NEW_CHECKOUT flag and dead else branch.`

## Rules

- No compliments, no nits, no "consider"s. Only cut candidates.
- If the diff is minimal already, output one line: `Clean diff, no cut candidates.`
- Never flag needed security checks, error boundaries, data validation, or accessibility attributes.

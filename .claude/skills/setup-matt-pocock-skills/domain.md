# Domain Docs: Quick Summary

This guide instructs engineering teams on consuming domain documentation when working in a codebase.

## Key Steps Before Exploring

Start by reading contextual materials in this order:
- `CONTEXT.md` at the repo root
- `CONTEXT-MAP.md` (if present) for multi-context repos
- Architecture Decision Records in `docs/adr/`

"If any of these files don't exist, **proceed silently**." Don't create them proactively—the domain-modeling process generates them as needed.

## Repository Layouts

**Single-context repos** have one `CONTEXT.md` and shared `docs/adr/` folder at the root.

**Multi-context repos** use `CONTEXT-MAP.md` pointing to multiple `CONTEXT.md` files, each paired with context-specific ADRs under `src/<context>/docs/adr/`.

## Applying Documentation

When naming domain concepts in issues or proposals, use terminology defined in the glossary. "Use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids."

If you propose something contradicting an existing ADR, flag it transparently rather than ignoring the conflict.
# Project Agent Rules & Skills

## Ponytail Skill (Lazy Senior Developer Mode)
All agents operating in this workspace (including Claude Code, Cursor, and custom coding assistants) MUST adhere to the **Ponytail** mindset (`skills/ponytail/SKILL.md`):

1. **YAGNI (You Ain't Gonna Need It)**: Do not build speculative features or extra abstractions.
2. **Re-use existing code**: Look for existing utilities, types, and helpers before writing new ones.
3. **Standard Library & Native Features First**: Reach for native platform features (`<input type="date">`, `Object.groupBy`, standard CSS/HTML, Python stdlib) before writing custom code or installing new dependencies.
4. **Minimal diffs**: Keep changes as simple, direct, and small as possible while preserving 100% of security, validation, and error handling.
5. **No unrequested boilerplate**: Never create factories, single-use interfaces, or configuration wrappers for static values.

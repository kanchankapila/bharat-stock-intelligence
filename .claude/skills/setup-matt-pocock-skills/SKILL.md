---
name: setup-matt-pocock-skills
description: Configure issue tracker, triage labels, and domain documentation layout
---

# Setup Matt Pocock's Skills Overview

This is a prompt-driven configuration skill designed to scaffold per-repo settings for engineering workflows. Here's what it does:

## Core Purpose

The skill configures three essential areas that other engineering skills depend on:

1. **Issue tracker location** — where work items live (GitHub Issues, GitLab, local markdown, or custom systems)
2. **Triage label vocabulary** — standardized label names for issue classification
3. **Domain documentation layout** — how context files and architectural decision records are organized

## Process Flow

The skill follows a five-step methodology:

**Exploration** examines the repo's current state by checking git remotes, existing documentation files, workspace configuration, and prior agent setup.

**Presentation** summarizes findings and asks targeted questions, leading with recommended defaults so users can accept quickly.

**Confirmation** shows draft outputs for review and editing before any files are written.

**Writing** creates or updates the configuration files and integrates settings into `CLAUDE.md` or `AGENTS.md`.

**Completion** notifies users which downstream skills can now use these settings.

## Key Design Choices

- Defaults favor GitHub since the skills were originally built for it
- Single-context (root-level `CONTEXT.md`) is presumed unless monorepo signals exist
- The triage label section only runs if the triage skill is actually installed
- Users can edit configuration files directly afterward without re-running the skill

The skill emphasizes exploration over assumptions and preserves existing user customizations.
# Local Markdown Issue Tracker System

This repository uses a decentralized issue tracking approach with markdown files stored in `.scratch/`.

## Key Structure

**Directory organization:**
- Features grouped under `.scratch/<feature-slug>/`
- Specifications in `spec.md`
- Individual tickets numbered sequentially in `issues/` subdirectory

**File conventions:**
- Tickets follow the pattern `NN-<slug>.md` (e.g., `01-authentication.md`)
- Status tracked via `Status:` metadata field
- Discussion appends below a `## Comments` heading

## Core Operations

**Publishing to tracker:** Create new files under the appropriate feature directory, establishing the folder structure as needed.

**Retrieving tickets:** Access files via their direct paths; users typically provide the path or ticket number.

**Wayfinding system** (for `/wayfinder` command):
- Central map file at `.scratch/<effort>/map.md` documents decisions and context
- Child tickets contain individual questions with `Type:` (research/prototype/grilling/task) and `Status:` fields
- "Blocked by: NN, NN" notation indicates dependencies
- Frontier scanning identifies open, unblocked, unclaimed tickets by lowest number
- Resolution workflow: claim → work → append answer under `## Answer` heading → update map

This lightweight system prioritizes transparency and async collaboration through version-controllable markdown.
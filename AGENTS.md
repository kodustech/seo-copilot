# Agent rules — seo-copilot / Kodus Growth

## Before building product features

**STOP and ask the user** before implementing anything that:

- Adds a new product surface (button, page, MCP tool, split/flow)
- Encodes a **specific business case** as a first-class feature (e.g. “Brasil vs Global”, “LinkedIn only”, one ICP)
- Invents a mini rules-engine, wizard, or multi-step system when a **simple primitive** would do

Default process:

1. Restate the job in one sentence (what human action, how often).
2. Propose the **smallest horizontal primitive** (move, merge, filter, export).
3. **Ask**: “Is this the shape you want, or only this one use case?”
4. Implement only after they confirm.

Do **not** ship “helpful” over-specific features unprompted. Specificity belongs in agent prompts, columns, or one-off moves — not hardcoded product IA.

## Product shape (Convert / research lists)

Horizontal primitives we want:

| Primitive | Meaning |
|---|---|
| **List** | Named set of companies |
| **Move** | Rows go from list A → list B (people stay on the row) |
| **Merge people** | Never silent-wipe contacts; snapshot before writes |
| **Filter / select** | UI selection or agent picks `row_ids` |

**Not** a product feature unless explicitly requested as a reusable system:

- “Split Brasil / Global” button
- Generic multi-rule split engines in the UI
- One-off market classifiers baked into nav

If the user needs Brasil vs World once: **select or agent picks rows → Move to list “X — Brasil”**. Language is a use of Move, not a product module.

## Agent / MCP behavior

- Prefer **asking for confirmation** on destructive or bulk ops (move many, replace people, delete sequence).
- Prefer **merge** over replace for people.
- Prefer **move by `row_ids`** over inventing classification UIs.
- When unsure between two designs, **ask** — do not pick the cleverer one alone.

## Tone with the user

- Be direct. Admit when a design was wrong.
- Don’t pile features to look complete.
- Prefer “here’s the 1 action you need” over “here’s a framework”.

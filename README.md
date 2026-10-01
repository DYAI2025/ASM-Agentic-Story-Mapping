# ASM-Agentic-Story-Mapping

ASM is a human-friendly, agent-readable story mapping product. Humans define
product intent and approve meaning; agents later assist with structuring and
critique.

This repository currently holds the **walking skeleton**: an editor over a
canonical product file, with local persistence and a visual story map. The
first map is ASM itself.

![The ASM story map](docs/screenshots/asm-story-map.png)

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
```

The app reads and writes `product/asm.product.yaml`. Set `ASM_PRODUCT_FILE`
to work on a different file.

## What is in the skeleton

- **Canonical model** (`src/domain/schema.ts`): Product, Goal, Persona, Need,
  NarrativeStep, WCBC (worst case / best case branch), Decision with rationale,
  and a revision that is either `proposed` or `approved`.
- **Canonical file** (`product/asm.product.yaml`): the ASM map, seeded as
  `proposed`.
- **Story map UI**: product goal, persona filter, horizontal main narrative,
  WCBC branches under each step, decisions, and editable cards.
- **Import / export** of the canonical file as YAML or JSON.
- **Deterministic validation**: schema, unique ids, resolvable references,
  gapless narrative sequence, approval record consistency.

## Rules the code enforces

- **Canonical != Derived.** The story map view (`src/domain/projection.ts`) is
  computed from the canonical document and never stored.
- **Position is not meaning.** Narrative order is the explicit `sequence`
  field and relations are ids. `layout` holds visual hints only; changing it
  never changes ids, relations or order, and never reopens an approved
  revision.
- **Approval is explicit.** Only the approve action, with a named human, turns
  `proposed` into `approved`. Saving never approves. A semantic edit to an
  approved revision opens the next `proposed` revision.
- **Nothing invalid is written.** A save or import that fails validation leaves
  the file untouched and reports each issue with its path.

## Layout

```
product/asm.product.yaml   canonical product file
src/domain/                pure domain logic (schema, validation, operations,
                           serialisation, projection) — no React, no I/O
src/server/store.ts        file-backed persistence
src/app/                   Next.js pages and API routes
src/ui/StoryMapEditor.tsx  the story map editor
tests/domain/              unit tests (Vitest)
tests/e2e/                 browser tests (Playwright)
```

## Checks

```bash
npm run typecheck
npm run validate           # validate product/asm.product.yaml
npm test                   # unit tests
npx playwright install chromium   # once
npm run test:e2e           # builds, starts the app on :3311, runs browser tests
```

The browser tests work on a scratch copy in `.e2e-tmp/`, not on the canonical
file.

## Not in this slice

LLM integration, Jira/Confluence integration, prioritisation, coding agents,
an evidence engine, authentication, and any database. Cards can be edited,
reordered and nudged visually; adding and deleting cards is done in the file.

# ASM-Agentic-Story-Mapping

ASM is a human-friendly, agent-readable story mapping product. Humans define
product intent and approve meaning; agents later assist with structuring and
critique.

This repository holds an editor over a canonical product file, with local
persistence and a visual story map, plus the first agentic step: paste a
discussion and get a proposal for the map that a human reviews. The first map
is ASM itself.

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

## From discussion to map

```
pasted text (untrusted) -> Narrative Builder -> MapPatch
  -> schema + reference validation -> readable diff + preview on the map
  -> Accept / Edit / Reject -> next proposed revision
```

In the **Workshop input** panel, paste a discussion, notes or a transcript and
press *Structure discussion*. You get a list of proposed changes, each with the
quoted source line, a rationale and a confidence, and the map shows what it
would look like. Accept all or some of it, edit the wording first, or reject it.

![Reviewing a proposal](docs/screenshots/asm-proposal-review.png)

A proposal can change the goal, add personas, needs and narrative steps, assign
personas to steps, suggest an order, and raise unresolved questions. It cannot
approve, decide or delete anything: the patch format has no way to say so.
Unresolved questions become *open* decisions.

### Providers

`src/agent/provider.ts` defines a small `AgentProvider` interface. The domain
code does not know which provider produced a proposal.

| `ASM_AGENT_PROVIDER` | What it is |
|---|---|
| `fake` (default) | No model. A deterministic parser for explicit markers (`Persona:`, `Need (…):`, `Step:`, `Assign:`, `Move:`, `Goal:`, `Question:`), documented in `src/agent/fake-provider.ts`. All tests use it. |
| `anthropic` | Claude through the Anthropic API. Needs `ANTHROPIC_API_KEY` in the environment; optional `ASM_AGENT_MODEL`. |

Copy `.env.example` to `.env.local` to configure. No credentials belong in the
repository.

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
- **An agent proposes, a human decides.** Building a proposal never writes the
  canonical file. Only an accepted patch does, and it always yields the next
  `proposed` revision; approving stays a separate human action.
- **Agent output is untrusted.** It must match a closed schema, every quoted
  snippet must occur in the pasted text, and every reference must resolve.
  Ids of new items are derived from their text, not chosen by the agent.
- **Pasted text is data.** It is passed to a model inside a delimited block,
  never as instructions. Whatever a model answers, only the closed schema and
  the human's acceptance decide what changes.
- **Sources are kept.** Each accepted change is recorded under `provenance`
  with its snippet, rationale, provider and revision. Confidence is advisory
  and has no effect on behaviour.
- **A proposal is bound to its map.** If the map's meaning changed since the
  proposal was made, accepting it is refused.
- **Nothing invalid is written.** A save or import that fails validation leaves
  the file untouched and reports each issue with its path.

## Layout

```
product/asm.product.yaml   canonical product file
src/domain/                pure domain logic (schema, validation, operations,
                           serialisation, projection) — no React, no I/O
src/domain/map-patch.ts    agent output schema, MapPatch, resolve, apply, diff
src/agent/                 AgentProvider, fake and Anthropic providers, prompt
src/server/store.ts        file-backed persistence
src/app/                   Next.js pages and API routes
src/ui/StoryMapEditor.tsx  the story map editor
src/ui/WorkshopPanel.tsx   paste, review, accept / edit / reject
tests/domain/, tests/agent/  unit tests (Vitest)
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

Automatic WCBC generation, slice selection, Jira/Confluence integration,
prioritisation, coding agents, an evidence engine, authentication, and any
database. Cards can be edited,
reordered and nudged visually; adding and deleting cards is done in the file.

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

## Starting a product

If the product file does not exist, the app opens on a start screen instead of
the map. Point `ASM_PRODUCT_FILE` at a path that does not exist yet to start a
new product; the default file in this repository is ASM's own map.

```bash
ASM_PRODUCT_FILE=./product/my.product.yaml npm run dev
```

```
name + own words -> proposal against a blank draft -> preview -> accept
  -> the file is created as proposed revision 1
```

- There is no second way to build a map. The start screen runs the same
  proposal mechanism as *Workshop input* (`resolveProposal`, `applyMapPatch`)
  against a blank draft: a document with a name and nothing else
  (`src/domain/bootstrap.ts`). The draft has no goal, does not validate and is
  never saved.
- Nothing is written until the human accepts. Rejecting leaves no file.
- `POST /api/bootstrap/accept` is the only route that creates a product file,
  and it only creates: the document is written to a temporary file and linked
  into place, which fails where a file exists, so the request is refused (409)
  and the file is untouched. Both bootstrap routes refuse while a product
  exists. Editor save (`PUT /api/product`) and import refuse while none
  exists (`no_product`, 404 like every other route that needs a product):
  they change a product, they do not start one. To
  bring an existing product file, put it at the configured path.
- A proposal that does not say what the product is for is refused
  (`goal_required`). The accepted goal also becomes the product's summary line.
- The result is always proposed. Approval stays the separate human action.
- With the `fake` provider (the default, no model) the text has to use one
  line per item (`Goal:`, `Persona:`, `Actor:`, `Need (name):`, `Step:`);
  the format is a collapsed note under the field. Free text without such lines needs the
  `anthropic` provider, which has only been tested against a stubbed client.

### Clear input and start over

Two different actions, so that throwing away a draft is never confused with
throwing away the map.

- **Clear input** (workshop panel, start screen) empties the text field and
  drops a proposal under review. Both only ever existed in the browser; the
  product file and the work state are not involved and stay byte-identical.
- **Start over…** (editor toolbar) asks first, inline, with no undo. Confirmed,
  `POST /api/product/reset` with `{ "confirm": "start over" }` removes the
  product file and its work state (`resetProduct` in `src/server/store.ts`);
  the page then reloads and, with no product, shows the start screen. No server
  restart. Cancel, or a request without those words (400), changes nothing.
- Order and failure: the work state goes first, the product last, and the store
  re-checks that neither file is there before it answers `ok`. The start screen
  can only appear once the product file is gone, so a reset that fails half-way
  (500, `reset_failed`) leaves the old map on screen with the reason; it never
  leaves a stored people check or selection behind that a later product could
  pick up as stale state. The two files are not removed atomically; the order
  is what makes it fail closed.
- The repository's own map is not a user workspace: with no `ASM_PRODUCT_FILE`,
  or one that resolves to `product/asm.product.yaml`, the reset is refused
  (409, `seed_protected`) and nothing is touched. Start over works on the
  workspace path you set.

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

### Context bundle: pasted text and text files

What a proposal is built from is a *context bundle* (`src/domain/context.ts`):
the pasted text, if any, plus `.txt` and `.md` files added next to it, at most
8 sources and 60 000 characters in all. Each source has a transient id
(`src-1`, `src-2`, …) and a label (`Pasted text` or the file name), is listed
before sending and can be removed. The bundle is input state, never part of the
product: nothing of it is stored except, for every accepted item, the id and
label of the source its quote came from (`provenance[].sourceId`,
`sourceLabel`; both optional, so older maps load unchanged).

- A file is read in the browser as UTF-8 text. Another type, undecodable
  bytes, an empty file or one over the limit is reported by name and not added.
  The server validates the bundle again before any provider sees it (empty,
  binary, type, size, shape) and refuses with 422; nothing is written.
- The provider receives every source in its own delimited block, headed by its
  id, and has to say for each item which source it quotes (`sourceId`). With one
  source the attribution is implied; with several it is required
  (`source_required`). The quote is checked against that one source: a snippet
  that only exists in another source, or across the boundary between two, is
  refused (`snippet_not_in_source`, `unknown_source`).
- The routes accept `{ context: { sources: [...] } }` and still accept
  `{ transcript: "…" }` as a one-source bundle.
- The primary copy asks for what the user already has: meeting notes, a
  transcript, a product description, requirements or rough thoughts. The marker
  format of the `fake` provider is a collapsed note under the field while that
  provider is active; it is not the instruction.
- The product name is the map's identity (ids and the proposal's fingerprint
  derive from it), so it has to exist before a proposal is built. The button is
  not disabled for it: asking without a name says so in one sentence and moves
  the focus to the name field; the text stays.

### Providers

`src/agent/provider.ts` defines a small `AgentProvider` interface. The domain
code does not know which provider produced a proposal.

| `ASM_AGENT_PROVIDER` | What it is |
|---|---|
| `fake` (default) | No model. A deterministic parser for explicit markers (`Persona:`, `Need (…):`, `Step:`, `Assign:`, `Move:`, `Goal:`, `Question:`), documented in `src/agent/fake-provider.ts`. All tests use it. |
| `anthropic` | Claude through the Anthropic API. Needs `ANTHROPIC_API_KEY` in the environment; optional `ASM_AGENT_MODEL`. |

Copy `.env.example` to `.env.local` to configure. No credentials belong in the
repository.

## The guide

A panel above the toolbar walks a first-time user through the same flow the
expert UI offers. It is a projection (`deriveGuide` in `src/domain/guide.ts`):
it reads the product document and the work state and keeps no progress of its
own.

| Step | Done when |
|---|---|
| Say what you want to build | a product exists and validates (`validateProduct`). On the start screen, before any product exists, this is the current step. |
| Name who is involved and what they need | there is at least one persona and no persona is without a need, or the revision is approved without that |
| Lay out the ideal path | `reviewNarrative` reports no missing or single-step main path, or the revision is approved without one |
| Check the story and approve it | the revision is `approved`: by the approve action, or because an imported file records an approval |
| Confirm who else matters | a people check stands for this map (`resolvePersonaCheck`), or a selection made under one does |
| Compare first slices and pick one | the stored selection resolves against the current map (`resolveSelection`) |
| Export the work order | `buildExecutionBrief` returns a work order |

- The last four steps read what the real gates read. The first three are the
  guide's own reading order: no gate requires a need or a second step, so once
  a human has approved a map without them the guide follows the approval. Such
  a step is labelled "not complete on the map; approved as it is", and the readable-map
  marker stays off.
- If no slice can be derived from an approved map (`proposeSlices` refuses),
  the slice step shows that reason and its button leads to the input, not to
  an empty comparison. The approval step says the same beforehand, and the
  work order step shows why the export gate refuses a selected slice.
- A step is done only when every step before it is done. The current step is
  the earliest one the state has not reached, so a change to the map leads back
  to it.
- The guide's button opens or focuses the part of the UI where the step is
  done. It never writes: approving, selecting and accepting stay where they
  were, behind the same gates.
- An earlier selection or confirmation that no longer matches the map is shown
  as stale on its step, with the way back. The toolbar shows the same as
  badges and a one-line summary, so it is visible with the guide hidden. Nothing is deleted or selected again.
- Three markers appear when their state is reached: a readable map (step 3),
  an approved story with the approver's name (step 4), a work order (step 7).
- *Hide guide* / *Show guide* is a per-browser preference in `localStorage`
  (`asm.guide`). It is not product or work state.

## People: roles and persona

Every entry in `personas` is an actor. The map can say two independent things
about one (`src/domain/actors.ts`):

- `roles`: how the actor relates to the value chain. One or more of
  `customer`, `user`, `beneficiary`, `operator`, `seller`, `stakeholder`,
  `delivery_participant`, `system`.
- `persona`: whether the actor's needs and behaviour are modelled in the
  narrative. `false` means involved, but not modelled.

```yaml
personas:
  - id: persona-developer
    name: Developer
    description: Turns the approved narrative into a first delivery slice.
    roles: [user, delivery_participant]   # optional
    persona: true                          # optional
```

- A role never decides `persona`. A delivery participant is a persona only if
  the map says so; the same developer can be a persona of one product and not
  of another.
- Both fields are optional and nothing adds them on its own. A map written
  before they existed is read as before: no `roles` means no role is stated
  (shown as "Role not stated", never guessed), no `persona` means the entry is
  a persona, as it always was. Such a map keeps its fingerprint. A file that
  uses the fields cannot be read by an older version of this code; remove the
  two fields to go back.
- A persona without a need is a review finding (`persona_without_need`) and is
  shown on the card as unresolved. ASM does not create the need.
- An actor marked `persona: false` owns no need and takes part in no step:
  validation refuses a file that says otherwise (`need_of_non_persona`,
  `step_of_non_persona`). Whoever has a need or a step on the map is a persona
  by that fact. Such an actor can still be the one a worst case escalates to.
- So everyone a slice candidate lists, and everyone under PERSONAS in a work
  order, is a persona; slice rules and work order contract are unchanged.
- The order roles are written in carries no meaning; they are exported in the
  order of the list above.
- In the UI, *Roles and persona…* on a card edits both. A changed answer is a
  change of meaning: it reopens an approved revision like any other edit.
  Saving without a change writes nothing.
- A worst case may still escalate to an actor who is not a persona; a work
  order then names that actor in the branch (`toPersonaId`) without listing
  them under personas.
- Marking someone on a step or with a need as not a persona is refused with
  the reason. The editor cannot take a person off a step yet; that needs an
  edit of the product file.

## Before slicing: who else matters

After approval and before any slice can be selected, a named human confirms
that they considered who else is relevant for the goal (`confirmPersonaCheck`
in `src/domain/work-state.ts`, `POST /api/people-check`, the *Who else
matters?* block in the slice drawer).

- It says what a human did. It does not say the people on the map are
  complete, and ASM never says so: no agent output, review output or proposal
  has a field for it.
- It is work state (`asm.work-state.json`, key `personaCheck`), never part of
  the product file, bound to product, revision and map fingerprint.
- After any change of meaning it is stale. A stale confirmation is kept and
  shown as stale, not as never made; only a human confirming again replaces it.
- `selectSlice` refuses without a current one, so no work order can exist
  without it. A selection records under whose confirmation it was made; a
  selection without that record (a work-state file from before this gate) is
  stale.
- Boundary of this gate: it holds for every route and for the UI. The
  work-state file itself is trusted as a record, like the product file: a
  complete-looking confirmation or selection written into it by hand is taken
  as one. A record with a field the schema does not know is refused as a
  whole. Confirming again replaces the earlier confirmation; there is no
  history of confirmations.
- Slice candidates can still be looked at on a proposed map or before the
  confirmation; selecting and exporting cannot happen.

## From approved narrative to work order

```
approved narrative -> review (fixed checks + agent findings)
  -> who else matters (human) -> 2-3 slice candidates, or one with the reason
  -> a human selects one -> work order (JSON + Markdown)
```

**Review mode** opens the findings inbox.

- *Fixed checks* (`reviewNarrative` in `src/domain/review.ts`) run on every
  render: a step without a persona, a step that serves no need and has no
  decided decision as rationale, a main path without a start and an end, needs
  and personas no step uses, and a worst case that does not reference where it
  leads (`outcome`: recovery at a step, escalation to a persona, or
  termination). Duplicate ids and references to ids that do not exist are
  rejected earlier, by validation.
- *Agent review* runs on request. It may propose a missing transition, a
  missing worst case, conflicting descriptions, implementation wording, or a
  missing product question. Every finding names ids that are on the map or is
  an explicit `NEW_PROPOSAL`; anything else is rejected. WCBC suggestions are
  listed separately. Nothing is ticked for you. Accepting findings goes through
  the same accept path as a discussion proposal and yields the next *proposed*
  revision.

![Findings inbox and WCBC suggestions](docs/screenshots/loop-04-agent-findings-and-wcbc-suggestions.png)

**Slices** opens the slice drawer with two or three candidates
(`proposeSlices` in `src/domain/slices.ts`). They are three fixed readings of
the map: the steps of the persona who takes part in most steps, the steps that
serve the needs of the last step, and the steps shared between personas. Each
candidate lists its step, persona and need ids, why now, assumptions,
unresolved questions, suggested acceptance criteria and what is out of scope,
and the comparison table shows counts taken from the map. There is no score and
no ranking. A map whose three readings collapse into one yields that one
candidate together with the reason there is no second (`fewerBecause`); a map
that yields none is refused with the reason. Changing these rules raises
`SLICE_DERIVATION_VERSION` (now 2), which makes earlier selections stale.

![Slice candidates compared](docs/screenshots/loop-06-slice-drawer-comparison.png)

**Select slice** needs a named human, an approved revision and a current
people check. The selection
is work state, not product canon: it is written to its own file beside the
product file (`product/asm.work-state.json`, or `ASM_WORK_STATE_FILE`; not
checked in), and selecting never changes the product document
(`src/domain/work-state.ts`). The selection stores no copy of the slice. It
names the candidate and binds itself to the product revision, the map
fingerprint, a fingerprint of the candidate (`candidateFingerprint`) and the
version of the derivation rules (`SLICE_DERIVATION_VERSION`). If any of them
no longer matches, the selection is stale: it is not shown as the selected
slice and it is refused by the export. Nothing deletes or repairs it. The map
toolbar and the slice drawer show it as stale, with the earlier candidate, the
reason (Product Map, Candidate or Derivation changed) and a way to select
again from the current candidates.

![A stale selection in the slice drawer](docs/screenshots/loop-11-stale-selection.png)

Each candidate carries a value status. It is a label, not a number:

- `VALUE_RESOLVED`: at least one included step references a need on the map.
- `VALUE_UNRESOLVED`: no need is referenced. The candidate can be viewed,
  compared and selected, but no work order can be exported from it.
- `VALUE_EXCEPTION_ACCEPTED`: no need is referenced, and after selecting, a
  named human accepted that with a written rationale
  (`/api/slices/exception`). This authorizes the work under uncertainty. It is
  not evidence that the slice has business value, and the work order says so.

![A selected slice without a need cannot be exported](docs/screenshots/loop-09-value-unresolved-no-export.png)

**Export work order** (`/api/brief?format=json|md`) is built from the approved
product document plus a selection that is not stale, and is refused without
one or while the value is unresolved. The brief holds GOAL, VERIFIED /
APPROVED CONTEXT (approval, who considered who else matters, the selection
with candidate fingerprint and derivation version, the value status and any
exception), IN SCOPE, OUT OF SCOPE, PERSONAS / NEEDS (each person with roles
and persona answer), ACCEPTANCE CRITERIA DRAFT, VERIFICATION EXPECTATIONS,
OPEN HUMAN DECISIONS and SOURCE MAP REVISION. The contract version is
`briefVersion` (now 3) in the JSON and in the Markdown. Examples from the
browser tests: [`docs/examples/asm.work-order.md`](docs/examples/asm.work-order.md)
and [`.json`](docs/examples/asm.work-order.json); with an accepted exception,
[`docs/examples/asm.work-order.exception.md`](docs/examples/asm.work-order.exception.md)
and [`.json`](docs/examples/asm.work-order.exception.json).

The `fake` provider reviews with five fixed rules and template wording
(`src/agent/fake-review.ts`); it does not understand the narrative. The
`anthropic` provider has a review prompt and output contract, tested against a
stubbed client only.

## Rules the code enforces

- **Canonical != Derived.** The story map view (`src/domain/projection.ts`) is
  computed from the canonical document and never stored.
- **Position is not meaning.** Narrative order is the explicit `sequence`
  field and relations are ids. `layout` holds visual hints only; changing it
  never changes ids, relations or order, and never reopens an approved
  revision.
- **Approval is explicit.** Only the approve action, with a named human, turns
  `proposed` into `approved`. Saving never approves, and a save that keeps an
  approval while changing what was approved is refused
  (`approved_content_changed`): only `layout` may change under an approval.
  Everything the fingerprint covers counts as meaning, including provenance
  and the product summary. A semantic edit to an approved revision opens the next `proposed`
  revision. Import is different on purpose: an imported file is taken as the
  record it claims to be, including an approval it records.
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
- **A finding is not a change.** Reviewing never writes the canonical file.
  An agent finding reaches the map only when a human accepts it, and then as a
  proposed revision.
- **A slice is selected by a human.** Candidates are derived and never stored.
  Saving or importing cannot introduce a selection the file did not have; only
  the select action writes one, on an approved revision.
- **A work order names its source.** It carries the revision number, the
  approval record and the fingerprint of the map it was made from.
- **Nothing invalid is written.** A save or import that fails validation leaves
  the file untouched and reports each issue with its path.

## Layout

```
product/asm.product.yaml   canonical product file
src/domain/                pure domain logic (schema, validation, operations,
                           serialisation, projection) — no React, no I/O
src/domain/map-patch.ts    agent output schema, MapPatch, resolve, apply, diff
src/domain/review.ts       fixed checks, agent finding contract, findings -> MapPatch
src/domain/slices.ts       slice candidates, candidate check, the select gate
src/domain/brief.ts        execution brief (work order) as JSON and Markdown
src/agent/                 providers (fake, Anthropic), prompts, proposal and review builders
src/server/store.ts        file-backed persistence
src/app/                   Next.js pages and API routes
src/ui/StoryMapEditor.tsx  the story map editor
src/ui/WorkshopPanel.tsx   paste, review, accept / edit / reject
src/ui/ReviewPanel.tsx     review mode: findings inbox, WCBC suggestions
src/ui/SliceDrawer.tsx     candidate comparison, select slice, export work order
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
file. Their screenshots and exported work orders go to `.e2e-artifacts/`, which
git ignores, so a test run leaves the checkout unchanged. The copies under
`docs/` are refreshed on purpose only (the command sets an environment
variable inline, so it needs a POSIX shell; it also adds the guide screenshots,
which are not checked in yet):

```bash
npm run docs:refresh       # same browser tests, writing into docs/
```

`.github/workflows/ci.yml` runs the checks above on every pull request against the head commit,
fails if the run changed a tracked file, and uploads `.e2e-artifacts/` named
by that commit.

### The whole first-time path in one test

`tests/e2e/first-time-user.spec.ts` starts with no product file and walks the
path in order: start screen, own words, proposal, first map, findings and a
worst case accepted, approval, who else matters, candidates, selection, the
work order read back as JSON and Markdown, then a change of meaning, the stale
state and the way back. It also runs a small accessibility check on the start
screen, the map, the review panel and the slice drawer: every control has a
name a screen reader can say, every button has text, headings exist. Its
screenshots are the review gallery [docs/first-time-user.md](docs/first-time-user.md).

### What the tests have been shown to catch

A green test proves little until it has been seen red. For every rule the
prototype depends on, the rule was broken on purpose in a clone and the test
that is supposed to notice was run; the table is the record. Three times a
new test passed under a mutation it was written for, and each time the
reason was the same: an assertion satisfied by a weaker mechanism than the
one it was meant to prove (a disabled button for a server gate, a revision
number for a content fingerprint, the absence of a read for a read that
repairs). "Red" means the
named test failed; a mutation nothing caught was either a gap that got a test
or an equivalent mutant (a change that does not change behaviour), and the
table says which.

| Rule broken on purpose | Ticket, verified at | Result |
|---|---|---|
| Guide button sends an approval; guide button sends a slice selection | ASM-15, `686bdc5` | red (the no-write oracle records the request) |
| "Earlier steps first" rule removed; last step read from the selection instead of the export gate; work-order warning removed; approval warning removed | ASM-15, `686bdc5` | red |
| Approval predicate forced true; people predicate ignoring approval; map marker without content check; as-is marking removed; dead-end action restored; singular wording; CSS rule that hides the guide before paint | ASM-15, `1f01b72` | all red |
| Derive persona from the role; drop the non-persona finding; operation adds a need; always write persona; legacy entry is a persona only for some roles; roles form left open during an import | ASM-16, `39db73d` | red |
| Blank draft at revision 1; accept route writing an approved document; non-strict patch schema; overwrite instead of exclusive create; bootstrap route without the exists check; goal check removed; non-persona flag dropped on apply; persona derived from role; `Actor` treated as persona; start-screen branch removed; save/import guards removed; link replaced by rename; temp cleanup removed; goal-length mislabel; control characters in names; message for unstructured text removed; old temp-file name | ASM-17, `24c45f3` | all red (the temp-file canary red 5 of 5) |
| Approval gate removed; persona gate removed; selection without a record not treated as stale; fingerprint comparison of the check disabled; select route accepting a confirmation from the request body; `approved_content_changed` guard removed; open-decision finding removed; guide step forced done; confirm route selecting a slice automatically; toolbar badge removed; reselect-to-check focus removed | ASM-18, `f19c222` | all red |
| An autonomous selection inside a GET route | ASM-19, `65f2855` | **survived every test** and exported a work order live — a false-green gap; closed by the static guard `tests/domain/read-routes.test.ts` and repeated reads in the browser tests |
| GET selects a candidate, plus four variants (in the brief route, via `confirmPersonaCheck`, via direct `fs.writeFile`, as a new GET on the people-check route); `valueStatus` always resolved; version not bumped; people check dropped from the brief; roles/persona dropped; brief version 2 | ASM-19, `a96bc2b` | all red |
| Fingerprint blind to the goal, the needs or the step order | ASM-20, `67a1e41` | **the re-entry matrix and scenarios stayed green** (every change also reopened the revision, which is part of the fingerprint) — closed by tests that change one field under the same revision and approval |
| No reopen on an approved revision; selection ignoring the fingerprint; check ignoring the fingerprint; fingerprint blind to goal / needs / step order / roles; fingerprint including layout; summary with a fixed step list; GET deletes a stale selection | ASM-20, `6972e89` | all red |
| Dropping `sequence` while the narrative is still sorted by it | ASM-20, `6972e89` | equivalent mutant (behaviour unchanged); replaced by sorting by id, which is red |
| Against the first-time-user test at its first version: people gate removed from `selectSlice`; GET `/api/slices` selects when nothing is selected; fingerprint blind to the goal; bootstrap accept ignores the exclusion | ASM-21, `8eac934` | **three of four survived** (the gate was asserted only as a disabled button; no read happened before the selection; the reopen hid the fingerprint); the fourth red |
| Same four, plus an unnamed button inside a label and a button whose only text is hidden from assistive technology | ASM-21, the spec's second version | all red |
| Seed never protected (both conditions); only the unset-variable condition dropped; path compared as a string instead of resolved (`product/./asm.product.yaml`); only the work state removed; only the product removed; every failure reported as success (unlink errors and the final existence check ignored) | ASM-23, `tests/domain/reset.test.ts` | all red (the first seed mutant deleted the real seed in the working tree before the test was moved to a scratch copy of the repository layout; the string-comparison mutant survived until the test used a path spelled differently) |
| Reset deriving the work-state path as the product's sibling instead of reading `ASM_WORK_STATE_FILE` | ASM-23, verifier's own mutant on `bed6109` | **survived the whole suite** — no test set the override; closed by a test that moves the work state elsewhere and expects it gone |
| Snippet checked against all sources joined instead of the named one; missing `sourceId` defaulting to the first source with several present; unknown source tolerated; source identity dropped from provenance | ASM-24, `tests/domain/context.test.ts` | all red |
| Verifier on `7594e6e`: binary check dropped; total-size check dropped; type check never firing; per-source tag suffix dropped | ASM-24, `7594e6e` | all red (the tag one only through a one-source assertion) |
| Verifier's own: the model prompt carrying only the first source; the fake provider stamping a question with the first source's id | ASM-24, `7594e6e` | **both survived the unit suite** (the second fails closed in `resolveProposal`, so the browser spec would catch it; the first was observed by nothing) — closed by a prompt test over two sources and a question-stamp test |

The full lists with the failing test names are in the evidence comments on the tickets.

### What a green run does not prove

The deterministic provider has no understanding; the Anthropic provider has
only ever run against a stubbed client. The store is last-writer-wins for two
writes from one browser. An imported file keeps the approval it records. The
accessibility check is a smoke test, not an audit. The visual and usability
verdict is a human's, on one exact commit, and is recorded on the ticket, not
in this repository.

## Not built

Automatic coding execution, writing to Jira or Confluence, automatic merge, an
evidence runner, a next-action engine, prioritisation by a score,
authentication, and any database. Cards can be edited, reordered and nudged
visually; deleting cards is done in the file.

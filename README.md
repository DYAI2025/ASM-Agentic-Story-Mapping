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
- The work-state target is removed first, so it has to be a work state: an
  `ASM_WORK_STATE_FILE` that is not named `*.work-state.json`, that is the
  product file or the seed (by name or by what a symlink resolves to), or that
  holds anything but a valid work state, or holds a people check or a
  selection made for another product (its `productId`), is refused
  (`work_state_path_invalid`) before anything is touched. An empty work state
  belongs to nobody and may go; an owned one whose product cannot be read is
  refused too. The seed check on the product path follows
  symlinks too: a path that reaches `product/asm.product.yaml` through a
  linked directory is the seed.
- What the reset's checks defend against, and what not: a mistaken
  configuration (the seed as the product or as the work state, a path that
  leads to the seed through a link, an override that is not a work state) and
  a request a browser was made to send. They do not defend against a hostile
  process on the same machine: one that can swap a parent directory into a
  symlink between the check and the unlink can delete the seed directly, and
  the route adds nothing to what it already has. The checks are by pathname
  and resolve the path twice; a descriptor-bound delete would need a trusted
  workspace root, which this prototype does not define.
- Store mutations (save, work state, create, reset) run one at a time within
  the server process, and a save or a work-state write finding no product at
  commit time is refused (`no_product`): a reset that answered "fresh" is not
  undone by a write that was already on its way. Every writing route runs its
  whole read → check → write as one such transaction (`transaction` in
  `src/server/store.ts`), so two accepts built on the same revision cannot
  both land: the second re-reads the file and is refused as stale. There is
  no lock across processes.
- Every route that changes something (and the two that spend a model call)
  refuses a request the browser marks as coming from another site
  (`Sec-Fetch-Site` other than `same-origin`/`none`, or an `Origin` that is
  not this host): 403 `cross_site_request`, before the body is read
  (`src/server/same-origin.ts`). Without it a page on any other site could
  make a visitor's browser post a reset, an approval or a selection to the
  app on localhost. It is not authentication: a client that is not a browser
  sends no such marks.

## From discussion to map

```
pasted text (untrusted) -> Narrative Builder -> MapPatch
  -> schema + reference validation -> readable diff + preview on the map
  -> Accept / Edit / Reject -> next proposed revision
```

In the **Workshop input** panel, paste a discussion, notes or a transcript and
press *Structure discussion*. You get the proposal as product meaning, in
sections (`src/domain/proposal-view.ts`, a projection over the patch): Goal,
Personas, Other actors and roles, Needs, Suggested main path, Open questions,
Other changes. Every item is used, edited or rejected on its own (*Use* is the
box, *Rejected* is the box unchecked, *Edit* opens that item's fields; *Edit
all* opens every one). The source — which pasted text or file, confidence,
rationale, the quote — sits behind a disclosure on each item. While editing,
chips offer the quote as written and, for the goal, the other readings; a chip
only fills the field in the proposal draft.

When the text supports more than one reading of what the product is for, the
provider says so (`goalAlternatives`) and the goal becomes a choice: radio
buttons with nothing chosen, "ASM does not choose for you". Until exactly one
reading is chosen, *Accept* is unavailable and the review says in words that
the goal is the choice still missing — on a first product and on an existing
one alike (`goalChoiceOpen` in `src/domain/proposal-view.ts`, ASM-31). On an
existing product validity cannot stand in for this: the old goal keeps a
proposal valid with every reading left out. Choosing again before *Accept*
replaces the earlier choice. A patch that still carries two goals is refused
by `applyMapPatch` (`conflicting_goal`), so no client and no provider can get
two goals accepted; a client that leaves out every reading is not stopped by
the server (see "What a green run does not prove"). The map shows what the
proposal would look like; nothing is written until *Accept*.

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
  id; the tag around a block is a hash of the label and the text plus a nonce
  chosen after the sources arrived, so no source can contain its own closing
  tag, by accident or on purpose. The provider has to say for each item which
  source it quotes (`sourceId`). With one
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
| `fake` (default) | No model. A deterministic parser for explicit markers (`Persona:`, `Actor:`, `Need (…):`, `Step:`, `Assign:`, `Move:`, `Goal:`, `Question:`), documented in `src/agent/fake-provider.ts`. All tests use it. |
| `anthropic` | Claude through the Anthropic SDK (`src/agent/anthropic-provider.ts`). Needs `ANTHROPIC_API_KEY`; optional `ASM_AGENT_MODEL` (default `claude-opus-5-5`). |
| `openai` | OpenAI through the Responses API with a strict JSON schema (`src/agent/openai-provider.ts`, plain `fetch`). Needs `OPENAI_API_KEY`; optional `ASM_AGENT_MODEL` (default `gpt-6-astra`), `OPENAI_BASE_URL`. |
| `openrouter` | OpenRouter chat completions with a strict JSON schema and `require_parameters` (`src/agent/openrouter-provider.ts`, plain `fetch`). Needs `OPENROUTER_API_KEY` and `ASM_AGENT_MODEL` (no default is guessed). |

Copy `.env.example` to `.env.local` to configure. No credentials belong in the
repository. `ASM_AGENT_TIMEOUT_MS` (default 120 000) bounds every call.

All four sit behind the same two interfaces and the same rules:

- A provider receives the context bundle and the map, and returns `unknown`.
  The domain (`resolveProposal`, `resolveReview`) decides what of it is a
  proposal; nothing under `src/agent/` imports the store, the file system or
  a route (a static test says so), so no provider can write anything.
- The sources are data. The instructions never contain them; each source sits
  in its own delimited block. A model that obeys "approve this", "select this
  slice" or "write to the map" can only produce output the schemas cannot
  express, which is refused (`tests/agent/live-providers.test.ts`).
- Failures are visible and closed: missing key, rejected credentials (401),
  rate limit (429), timeout or unreachable API, refusal or content filter,
  truncated answer, non-JSON, schema-invalid output. There is no fallback to
  another provider or model: the Anthropic adapter deliberately does not send
  the server-side `fallbacks` option, so a safety decline is an error, not a
  different model answering.
- Keys are sent in one header and never logged. Every provider call crosses
  one boundary on its way out (`contained` in `src/agent/http.ts`): whatever
  was thrown inside — an adapter's own message, an SDK's exception with
  upstream text in it, a transport failure — leaves as one error whose
  message went through the redactor, which knows the key's raw, JSON-escaped
  (once and twice) and URL-encoded spellings. Model output that contains the
  key — in any decoded string or key — is discarded whole before the domain
  sees it. The Anthropic SDK's own logging is off whatever `ANTHROPIC_LOG`
  says, since at debug it prints bodies. The oracle for all of this is
  `tests/agent/secret-containment.test.ts`: every channel an adapter reads
  from upstream (output values and keys recursively, envelope metadata,
  error bodies, the SDK's parsing exception, a network failure), four
  spellings of the key, all three adapters (Anthropic through the real SDK),
  proposals and reviews, looking for the key's plain tail in the result and
  in everything written to the console meanwhile. Exact-value matching,
  secrets of four characters or more; a secret under four characters is not
  looked for.
- The request-side schema (`src/agent/json-schema.ts`) is the zod contract as
  strict JSON Schema: every property required, nothing additional, optional
  fields nullable. It is a courtesy to the model; the app relies only on its
  own validation of what comes back.
- One repair, and only one (ASM-29). External QA measured the reference model
  (`qwen/qwen3-235b-a22b-2507` through OpenRouter) ignoring that schema: the
  source fields flattened onto each item, needs as `id`/`text`. When an answer
  parsed but was refused — for its shape (`AgentOutputSchema`), or for named
  items in it of the kinds the PO decided on 2026-10-06: a quote that does not
  occur in the source it names, an unknown or missing source, a `new:` ref that
  is malformed, duplicated or undeclared, an id not on the map, a role outside
  the list — `buildProposal` asks the same provider once more, with the
  contract as JSON Schema text and a bounded list of what was refused (shape
  problems grouped by position, a refused item with its position and its value
  quoted, each part redacted for key-shaped text and then clipped, at most 20
  lines). The whole previous answer is not sent back. The second answer is
  untrusted like the first and goes through `resolveProposal` from scratch:
  the rules are unchanged, a refused value is never accepted as it was, and
  nothing in ASM rewrites one. A quote counts as occurring in its source when
  it does so with runs of whitespace (spaces, line breaks) counted as one space
  — the rule `resolveProposal` has applied since the walking skeleton; case,
  punctuation and words must match. Not repaired: a provider failure
  (credentials, rate limit, timeout, network, refusal, content filter, cut-off,
  non-JSON, a key in the output), any other refusal of the answer (an empty
  answer, a text limit, a confidence out of range, a placement), and any
  refusal from applying the proposal to the map (`resolveProposal` marks those
  `stage: "apply"`, e.g. a need for someone who is not a persona). Those are
  refused after the first call. There is no loop, so a submission makes one
  model call or two, never three, and each call is one HTTP request: the
  Anthropic SDK's own retries are off (`maxRetries: 0`), the other adapters
  never had any. With the Anthropic adapter the SDK itself parses the answer
  against the contract before ASM sees it, so there a wrong shape is a
  provider error and is not repaired (fail closed, one call).
  `/api/proposal` and `/api/bootstrap` report the number as `modelCalls`
  (0 when the request was refused before any call). The instructions of every
  proposal request state the contract as well, with the exact-quote rule, the
  `new:` ref syntax and the closed role list spelled out. The oracle is
  `tests/agent/schema-repair.test.ts` (built from the shape QA recorded, red on
  the code before each change) and, in the browser,
  `tests/e2e/schema-repair.spec.ts` against a scripted model on localhost
  (`tests/e2e/model-stub-server.ts`) through the real `openai` adapter.
- What a human reads when the answer is refused for its shape (ASM-30). The
  contract raises one issue per misplaced field, so External QA saw 45–134
  of them per failure. If any issue is `agent_output_*`, the panel says in a
  few fixed sentences that the model's answer could not be read safely and was
  not used, that nothing was changed, and what to try: again; with a shorter
  or split text; with another model set on the server. The same sentences
  appear whatever the count. The full list (path, message, code) sits behind a
  disclosure that starts closed, and the 422 body still carries every issue
  (`unreadableAnswer` in `src/domain/proposal-failure.ts`, rendered by
  `src/ui/ProposalIssues.tsx` on the start screen and in the workshop). Every
  other refusal keeps its own words, path and code, because it already says
  what is wrong: a provider failure (credentials, rate limit, timeout,
  refusal, cut-off, a key in the output), a quote not in its source, a file
  that cannot be read, nothing structured. The oracle:
  `tests/ui/proposal-issues.test.ts`, and in the browser
  `tests/e2e/proposal-failure.spec.ts`, where an answer with 74 issues meets
  the stub and the stub also answers 401, 429, a quote still wrong after the
  repair, and an answer carrying the key.
- CI has no keys: the adapters are tested against a stubbed `fetch`. The live
  smoke (`npm run smoke:live`, see Checks) is run by hand with a real key.

## The tutorial and the Product Flow

Two different things, kept apart on purpose.

The **tutorial** (`src/ui/Tutorial.tsx`) says how ASM is used, in four
steps, one at a time: *Bring what you already have* · *Review, don't rewrite*
· *Check the story* · *Turn understanding into work*. It shows on a browser's
first visit (start screen and map), can be skipped, finished with Back/Next,
closed with Escape, and replayed with *Show tutorial*. Its only state is the
browser key `asm.tutorial` (`done`). It imports nothing from the domain and
calls no route (a static test says so), so it cannot move the Product Flow,
the product or the work state.

The **Product Flow** (the panel above the toolbar, `GuidePanel` in the code)
says where this product stands. It is a projection (`deriveGuide` in
`src/domain/guide.ts`): it reads the product document and the work state and
keeps no progress of its own. The identifiers under the hood still say
`guide` (test ids `guide-*`, the key `asm.guide`, the module name); the
visible name is Product Flow.

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
- *Hide product flow* / *Show product flow* is a per-browser preference in
  `localStorage` (`asm.guide`). It is not product or work state, and it is a
  different key from the tutorial's.

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

### The live provider smoke

```bash
ASM_AGENT_PROVIDER=openai OPENAI_API_KEY=… npm run smoke:live
```

`playwright.live.config.ts` starts the built app twice: once with the
provider and key from the shell, once with the same provider and a key that
cannot work. `tests/live/provider-smoke.spec.ts` pastes ordinary meeting notes
(no markers), waits for the real model, checks that the proposal has a goal,
people, needs, a path and open questions, accepts it as a human would and reads
revision 1 back from disk, with every snippet found in the notes and attributed
to the pasted source; the second server has to show the credential failure in
the browser and write nothing. Screenshots, `record.json` (provider, seconds to
proposal, counts, what was accepted) and the accepted map go to
`.e2e-artifacts/live/`; the record is checked to contain no key. CI never runs
this; the evidence is recorded on the ticket.

### The live intake battery

```bash
ASM_AGENT_PROVIDER=openrouter ASM_AGENT_MODEL=qwen/qwen3-235b-a22b-2507 OPENROUTER_API_KEY=… npm run battery:live
```

The External-QA submissions of 2026-10-04 (`tests/live/fixtures/qa/`, checksums
in `SHA256SUMS`): A2 product description, A3 meeting transcript, A4 at about
5 000 words and near the 60 000-character limit, A5 three sources (pasted
text, `.txt`, `.md`). `tests/live/intake-battery.spec.ts` submits each from the
start screen of a fresh workspace, one minute apart (`BATTERY_PAUSE_MS`),
records per submission the HTTP status, `modelCalls`, issue codes, seconds and
whether a file appeared, accepts the first valid proposal as a human would and
checks every recorded snippet against its source, then asserts at least four of
five valid. When the provider answers 429 (measured: OpenRouter's upstream for
the reference model rate-limits a shared pool and asks for 60 s), the
submission is made again after `BATTERY_RETRY_AFTER_MS`, up to three times, as
the product's "try again shortly" tells the human to; every attempt is
recorded, and the record counts valid submissions both ways (`valid`,
`validFirstAttempt`). `battery.json` in `.e2e-artifacts/live/battery/` names the commit
and whether `src/` had uncommitted changes. Each run is a sample of a
non-deterministic model; the results per commit are recorded on the ticket.

### The whole first-time path in one test

`tests/e2e/first-time-user.spec.ts` starts with no product file and walks the
path in order: start screen, own words, proposal, first map, findings and a
worst case accepted, approval, who else matters, candidates, selection, the
work order read back as JSON and Markdown, then a change of meaning, the stale
state and the way back. It also runs a small accessibility check on the start
screen, the map, the review panel and the slice drawer: every control has a
name a screen reader can say, every button has text, headings exist. Its
screenshots are the review gallery [docs/first-time-user.md](docs/first-time-user.md).

### The full user flow in one test

`tests/e2e/full-user-flow.spec.ts` (ASM-28) runs the whole slice on an isolated
workspace: fresh start with the tutorial, pasted prose plus a markdown file,
the grouped proposal with a goal choice, a chip edit, a rejection, accept,
first map, Product Flow, review and a worst case, approval, the people check
(server gate proven), candidates (reads choose nothing), selection, the work
order as JSON and Markdown read back and bound to the map and candidate
fingerprints, Start over, the fresh start screen with every read answering
`no_product`, and a second product started at once with no old state. It runs
an accessibility smoke on four screens. Its screenshots are the review
gallery [docs/full-user-flow.md](docs/full-user-flow.md); the provider-error
state there comes from the live harness.

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
| Unknown provider name falling back to the fake; missing `OPENAI_API_KEY` falling back to the fake; HTTP error from OpenAI swallowed into an empty answer; refusal returned as an empty proposal; schema builder not strict; key redaction removed; a provider importing the store; truncation ignored | ASM-25, `tests/agent/live-providers.test.ts` | all red (the redaction mutant survived until the test used a 400 with a verbatim message — the 401 path has fixed text) |
| Verifier on `5ed740f`: unknown name → fake; OpenAI 429 → `{}`; OpenRouter error-in-200 ignored; `buildProposal` falling back to the fake on any provider error; Anthropic `fallbacks` restored; `postJson` without the abort signal | ASM-25, `5ed740f` | all red (31 failures for the silent fallback); `additionalProperties = false` removed from the schema builder was an equivalent mutant — zod 4.6.5 already emits it for every `strictObject`, measured on all 25 object nodes |
| Verifier's own: the OpenRouter review sent with the proposal's instructions; `ASM_AGENT_TIMEOUT_MS` bounds dropped | ASM-25, `5ed740f` | **both survived** — closed by asserting the review system message and by refusing `0`, `999`, `600001`, `1.5`, `-5000` |
| Two goals applied with the last one winning; the dry run on the whole patch instead of per option; actors grouped as personas; the goal suggesting itself; the primary goal untagged in a choice | ASM-26, `tests/domain/proposal-view.test.ts` | all red |
| Verifier on `1d44fc9`: `conflicting_goal` removed; first goal radio always checked; no chips; questions grouped as other; quote outside the disclosure | ASM-26, `1d44fc9` | all red; the first goal pre-chosen in the panel's state is observable only by the browser spec (which CI ran) |
| Verifier's own: a rejected item opening its edit fields under Edit all; an alternative goal's quote and source passed through unvalidated | ASM-26, `1d44fc9` | **both survived** — closed by a render test with a rejected item under Edit all and by tests for a misquoted, unattributed and orphaned alternative |
| Tutorial not remembered after Finish | ASM-27, `tests/e2e/tutorial.spec.ts` | red (the reload assertion) |
| Verifier on `ad76f53`: tutorial importing `deriveGuide`; Finish writing `asm.guide`; step 2 saying "ASM decides"; heading back to Guide; `deriveGuide` reading `asm.tutorial`; a reset request inside Finish | ASM-27, `ad76f53` | all red (the domain read is caught by the static test on the mere mention) |
| Verifier's own: tutorial opening regardless of the key; Escape removed; the progress line fixed at step 1 | ASM-27, `ad76f53` | the first two are caught only by the browser spec (reload, Escape); the third **survived everything** — closed by asserting the progress line for steps 2–4 |
| External review of `2ff9ccf` (independent model, read-only): reset unlinking whatever `ASM_WORK_STATE_FILE` names, the seed included; redaction by pattern only, a key of another shape echoed back reaches the browser; pid-named temp files; a GET written as `export const` invisible to the read-routes guard | ASM-28, `2ff9ccf` | **all four were real** — closed by the work-state path rule (name, product, seed, symlink; three mutants red), exact-value redaction (mutant red), per-call temp names, and the wider export pattern. The review's two pre-existing findings (import without the proposal path; no authentication) are recorded above as limitations of a localhost prototype |
| External review round 13 of `24a6386` (round-12 repair fully implemented; 26 controls rendered, zero enabled while pending; **0 Blocker / 0 Critical / 0 Major**): the pending-state tests looked at `input`/`button` only, so a textarea left live would have stayed unobserved | ASM-28, `24a6386` | **real (Minor, tests only)** — both oracles widened to every control kind (`textarea`, `select` too); the browser test opens every field before accepting; a textarea mutant turns both red |
| External review round 12 of `9b8328a` (round-11 repairs fully verified by execution; **0 Blocker / 0 Critical / 0 Major**): while an acceptance was in flight, Reject and every edit control stayed live, so a human could be told "rejected" while the acceptance committed | ASM-28, `9b8328a` | **real (Minor)** — the review carries a pending state: every include box, goal radio, Edit, chip, textarea, and the Reject/Edit-all buttons are disabled while the acceptance is being written, and the action row says so; a browser test holds the accept response and checks that nothing inside the review is enabled; two mutants red |
| External review round 11 of `8fa0326` (round-10 boundary verified by execution: 8,008 assertions through the real Anthropic SDK): an editor save named nothing, so a tab holding the old product replaced the product made after a start-over; the Anthropic SDK also sent an ambient `ANTHROPIC_AUTH_TOKEN` as a bearer token, a credential ASM never chose and could not contain; an error object without a `message` string, or a choice-level error beside `finish_reason: "stop"`, passed as a successful proposal | ASM-28, `8fa0326` | **all real** — a save names the map fingerprint in `If-Match` (`GET` reports it as `ETag`), refused 409 `stale_save` inside the transaction; the SDK client is built with `authToken: null` (the request's headers are checked through the real SDK with the token in the environment); error presence is judged apart from message extraction, and a choice carrying an error is an error whatever its finish reason; three mutants red. The round-11 reviewer also noted the earlier "card edits last-writer-wins" sentence was wider than the mechanism — it now names what races (layout only) |
| External review round 10 of `b71265e` (round-9 repairs executed: decoded walker fully, SDK logging fully, null alternatives fully; 1,884 containment checks passed): the secret still left through error channels — a status / finish / stop reason serialized before redaction, the Anthropic SDK's own parsing exception reflecting the response, an upstream error body; and the positional oracle was hand-picked (nine placements, two adapters) | ASM-28, `b71265e` | **all real** — fourth round on the class, so the second strategy change: redaction moved out of every adapter into one boundary that every provider call crosses, knowing the key's raw, escaped and URL-encoded spellings; the oracle became `tests/agent/secret-containment.test.ts` (channels × four spellings × three adapters, placements generated recursively from real proposal and review outputs, Anthropic through the real SDK, console watched); mutants: raw-only redaction, boundary without redaction, walker on escaped text — all red |
| External review round 9 of `4d96d1c` (round-8 repairs executed: exception fully, Anthropic deadline through the real SDK with a stalled body, secret containment partially): the output scan compared a re-serialization, so a key containing a quote or a backslash passed it escaped; the Anthropic SDK at `ANTHROPIC_LOG=debug` printed the body before the adapter rejected it; a schema-valid `goalAlternatives: null` was refused by the domain | ASM-28, `4d96d1c` | **all real** — third round in a row on the secrets class, so the oracle changed rather than the patch: a positional test puts four spellings of the secret (plain, quote, backslash, non-ASCII) into every string position and key of a valid output across all adapters and looks for the secret's plain tail, which survives any escaping; the scan walks decoded values and keys; SDK logging pinned off and tested through the real SDK client with a spied console; `null` alternatives normalised; four mutants red |
| External review round 8 of `3197694` (round-7 repairs verified by execution: approval and reset fully, exception and redaction partially, deadline fully for `postJson`): a value exception named only its candidate id, a reading name reused across revisions, so an old exception could land after another browser changed, approved and reselected; model output carrying the key reached the domain unredacted (validation messages, accepted rationales); the Anthropic adapter's deadline was the SDK's, which ends at the headers | ASM-28, `3197694` | **all real** — the exception names the map fingerprint too (refused 409 inside the transaction; tested across a changed, approved and reselected map with an unresolved slice); model output containing a configured secret is discarded whole in all three adapters; the Anthropic call runs under the adapter's own abortable deadline; three mutants red |
| External review round 7 of `c914240` (round-6 repairs verified by targeted execution): approval, value exception and start-over confirmation carrying no identity of what the human saw, so under the queue they could land on a different revision, selection or product; status / finish / stop reasons interpolated unredacted; the HTTP deadline ending at the headers; temporary files left after a failed rename | ASM-28, `c914240` | **all real** — closed by binding each action to its displayed target (map fingerprint, candidate id, product id + fingerprint; refused 409 inside the transaction; route-level tests in both orders), by redacting every API-derived value, by keeping the deadline through the body, and by cleaning the temporary file in `finally`; five mutants red |
| External review round 6 of `01ea9c1`: a work-state override holding another workspace's valid work state deleted by a reset; the content-derived delimiter forgeable by a crafted self-consistent hash | ASM-28, `01ea9c1` | **both real** — closed by binding an owned work state to the product's id before any unlink (mutant red) and by a per-request random nonce in every source tag (mutant red) |
| External review round 5 of `24dcb33` (0 Blocker / 0 Critical): a file label spelling its own block's closing tag (the delimiter hashed only the text); Anthropic and OpenRouter passing an unknown or missing terminal state with valid JSON; the README overclaiming that a racing selection is refused | ASM-28, `24dcb33` | **all real** — closed by hashing label and text into the delimiter, by whitelisting `end_turn` / `stop`, and by stating that a newer explicit selection supersedes |
| External review round 4 of `76ba4c2`: two accepts on one revision both landing (checked before either saved); a compatible OpenAI endpoint answering 200 with a status other than `completed` and valid JSON; the file label in the prompt preamble rather than inside the data block | ASM-28, `76ba4c2` | **all real** — closed by running every writing route's read → check → write inside the store queue (two mutants red: transaction not serialized; the accept loading outside it), by requiring `status: "completed"`, and by moving the label into the delimited block. The reviewer judged the reset threat model plain and honest; the provenance-at-accept boundary stays documented |
| External review round 3 of `f4b5804`: a save in flight during a reset recreating the old product; the alias-export GET guard examining only the export clause | ASM-28, `f4b5804` | **both real** — closed by the in-process mutex plus the existence check at commit time (three mutants red: save recreates, orphan work state, no mutex) and by examining the whole file for an aliased GET. The round's Blocker — a hostile local process swapping a parent directory into a symlink between realpath and unlink — is not patched: it is outside the threat model written above (that process can delete the seed itself) and is recorded as an accepted limitation for the PO |
| External review round 2 of `b0fe88c`: the seed reached through a directory symlink; a work-state override holding something else; a cross-site `text/plain` POST resetting or approving on localhost; OpenRouter's provider-level failover left on; the Anthropic key not passed to the redactor; `export { handler as GET }` | ASM-28, `b0fe88c` | **all real** — closed by the realpath seed check, the work-state content check, the same-origin refusal on all twelve writing/model routes, `allow_fallbacks: false`, the key passed through, and the wider pattern; six mutants red (seed check, content check, unlink order, fetch metadata, Origin, fallbacks). Two pre-existing findings stay documented limitations: concurrent accepts are last-writer-wins; a client can hand the accept route a patch whose source fields it changed |
| Verifier on `cd9ba8a` (ASM-29): no repair; a retry loop; repair of every refusal; no contract in the repair; no redaction; the first answer's result returned after the repair; no `modelCalls`; Anthropic SDK retries back; refused values not quoted; quotes not repairable | ASM-29, `cd9ba8a` | all ten red. The verifier's own two **survived**: the whole previous answer sent back; `startProposal` asking again after a refusal for a missing goal — closed by tests in `44acfc6` (red in round 2) |
| Verifier round 2 on `ba119a7` (ASM-29): excluded kinds back in the repairable set; the dry-run stage tag dropped; `modelCalls: 0` dropped | ASM-29, `ba119a7` | all red. **Survived**: `every` → `some` in the repairability check; four excluded codes (text limit, count limit, alternative without goal, placement without a step) without a test; redact-before-clip without a test; the stage guard (equivalent at the time); two `modelCalls: 0` branches — closed by tests in the following commit; external review round 2 (codex) found the 403 refusals without `modelCalls`, closed there too |
| A goal choice left open on an existing product (ASM-31): the Accept button back to `busy || !result?.ok`; the rule counting "more than one kept" instead of "not exactly one"; the rule blind to two readings; the gate forced off; the missing-choice notice removed; `conflicting_goal` disabled | ASM-31, `3ad14bb` | all red (the first is the defect External QA reproduced; the new browser test was also red on `3acc12a` before the fix). Removing only the guard inside `accept()` **survived** — an equivalent mutant through the browser, since the disabled button is its only caller; kept as a second line |
| Verifier on `0b5b787` (ASM-31): four of the mutants above (the button, the "more than one" count, the notice, `conflicting_goal`); its own: a second choice not excluding the first, the gate on the Workshop only, the gate only when a product has no goal, readings not left open at the start, the first reading pre-chosen, the rule evaluated on the already-filtered patch | ASM-31, `0b5b787` | all red. **Survived**: a choice carried into the next proposal (both `close()` and `structure()` keeping it); the notice without its `status` role — closed by tests in `bedfb5b` (both red); the guard inside `accept()` again, equivalent (React does not dispatch a click on a disabled button, even one re-enabled in the DOM). Verifier round 2 on `5be266d`: those two red; its completeness critic found the work state proven only by a grep and no Bootstrap test that accepts a chosen reading — closed in `7db0790` (a proposal route that touches an existing work state, and an accept that sends every reading, both red) |
| An unreadable answer shown as a wall of issues (ASM-30): the bounded message never chosen; the technical list open by default; "Nothing was changed." removed; every refusal treated as unreadable (provider errors and quotes lose their own words); the list also outside the disclosure; one shape issue among others no longer enough (`some` → `every`); the details cut to the first ten | ASM-30, `1b76611` | all red, each mutant type-checked (the first is the defect; the new browser tests were also red on `4bab8e0` before the fix). The `every` mutant is caught by the unit test only: no browser case mixes a shape issue with another refusal |

The full lists with the failing test names are in the evidence comments on the tickets.

### What a green run does not prove

The deterministic provider has no understanding; the live providers have only
run against stubbed transports except for the recorded live smoke and the
live intake battery. The battery on the reference model
(`qwen/qwen3-235b-a22b-2507` through OpenRouter) reached 2 of 5 valid
proposals on the ASM-29 candidates `cd9ba8a` and `ba119a7` (the run on the
final commit is recorded on ASM-29): the wrong-shape class is fixed, but on long
inputs the model still misquotes a few of 30–60 items after the one repair, a
proposal is refused whole for one bad item, and OpenRouter's upstream for the
model often answers 429 (shared pool); reliability on that model is a separate
ticket, not a property this branch has. With the Anthropic adapter the SDK
checks the answer against the contract itself, so a wrong shape there is a
provider error and gets no repair. A quote counts as found in its source with
runs of whitespace treated as one space (accepted by the PO on 2026-10-06). The store is
serialized within one server process, and every human action names what the
human looked at — an accept carries the proposal's base fingerprint, an
approval and a people check the map fingerprint, a selection the map
fingerprint, a value exception the selected candidate and the map
fingerprint, a start-over confirmation the product id and map fingerprint,
an editor save (`PUT /api/product`) the map fingerprint in `If-Match`, as
`GET /api/product` reports it in `ETag` — so whichever lands second on a
map that moved is refused as stale, in either order, and a tab holding a
product from before a start-over cannot replace the one made since; two
selections or two people checks on the same unchanged approved map settle
in order and a newer explicit one supersedes the earlier (the work state
has no version of its own); two edits that change only where a card sits
(the fingerprint covers meaning, not layout) race last-writer-wins; nothing
serializes across processes. The accept routes take the edited patch from the browser and
re-validate its shape and fingerprint, not its source fields: a client that
rewrote `sourceId`/`sourceLabel` on an op would record an attribution the
server never checked — the browser is the human's own, but it is a trust
boundary worth naming. The goal choice is enforced in the review, not by
the server: the accept routes refuse a patch with two goals, but a patch that
leaves out every offered reading is indistinguishable from a proposal that had
none, so a client other than the review can skip the choice and keep the old
goal (on a first product it is refused for a missing goal). `POST /api/product/import` replaces the product with the file it
is given, approval record included, without the proposal path: it is the way
to bring your own file, and it is a human's own file, but a client on the
network could use it the same way. Nothing authenticates a request: every
mutation route trusts whoever can reach the port (a browser made to send a
cross-site request is refused, see above; a direct client is not). This
prototype is for one person on localhost; before it is exposed on a LAN or a
VPS, the import route and the mutation routes need authentication (that is
the next slice, not this one). The accessibility check is a smoke test, not an
audit. The bounded failure message covers proposals only (ASM-30). The
narrative review panel still lists a refused review answer issue by issue, and
whether the three suggested next steps actually help is a human verdict, not
something a test measures. The visual and usability verdict is a human's, on one exact commit, and
is recorded on the ticket, not in this repository.

## Not built

Automatic coding execution, writing to Jira or Confluence, automatic merge, an
evidence runner, a next-action engine, prioritisation by a score,
authentication, and any database. Cards can be edited, reordered and nudged
visually; deleting cards is done in the file.

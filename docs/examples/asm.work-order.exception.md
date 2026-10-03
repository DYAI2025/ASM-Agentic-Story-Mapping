# Work order: Steps shared between personas

Slice `slice-shared-steps` of ASM – Agentic Story Mapping, revision 1 (`1be530e3`).

Work order contract: `asm.execution-brief`, briefVersion 3.

## GOAL

Software teams without prior AI experience can move from product discussion to a shared, understandable product narrative and first useful delivery slice substantially faster. (`goal-faster-shared-narrative`)

## VERIFIED / APPROVED CONTEXT

- Approved: revision 1 by Maya (E2E) at 2026-10-03T13:31:59.510Z.
- Who else matters: considered by Maya (E2E) at 2026-10-03T13:31:59.675Z. A named human confirmed that they considered who else is relevant for the goal. That is what they did; it does not say the people on the map are complete.
- Slice selected by Maya (E2E) at 2026-10-03T13:31:59.724Z (candidate `f66ec7d4`, derivation rules version 2).
- Value: VALUE_EXCEPTION_ACCEPTED. Exception accepted by Maya (E2E) at 2026-10-03T13:32:00.060Z: “The hand-over points have to work before we can observe which need they serve.” No step of this slice references a need. A named human authorized it anyway. That is a decision under uncertainty, not proof that the slice has business value.
- Verified: nothing. Approved means a named human approved the narrative. ASM has verified nothing: no behaviour described here has been built or tested.

Why this slice:

- This slice is every step that more than one persona takes part in: the places where work passes between people.
- Primary persona relevance: Product Lead / Product Owner (persona-product-lead) takes part in 5 of the 6 included steps.
- Persona overlap: 6 of the 6 included steps involve more than one persona.
- Scope: 6 of 11 main-path steps, with 2 worst-case branch(es) to handle.

Assumptions:

- Assumes “Start product” [step-start-product] has already happened outside this slice.
- Assumes the steps skipped between included steps are done by hand: [step-confirm-intent] [step-approve-narrative].
- Does not reach “Export execution-ready work” [step-export-work]: the outcome of this slice is an intermediate one.
- Assumes these steps contribute to the goal [goal-faster-shared-narrative]; none of them names a need.

Decided:

- `dec-canonical-file` The canonical product model is a YAML file inside the repository — Given by the slice brief (no database, no graph server). A file is diffable, reviewable and readable by agents.
- `dec-position-not-semantics` Visual position is never the sole source of semantics — Narrative order lives in an explicit sequence field and relations in ids. Layout is stored separately and can change without touching meaning.

## IN SCOPE

- Step 2: **Describe idea / provide discussion** (`step-describe-idea`) — The team describes the idea or hands over an existing product discussion.
  - Best case `wcbc-notes-provided`: Discussion notes already exist
  - Worst case `wcbc-vague-discussion`: Discussion is vague or contradictory — Record each contradiction as an open decision instead of guessing an answer.
- Step 4: **Define personas and needs** (`step-define-personas`) — Who the product is for and what each persona needs from it.
- Step 5: **Build main / best-case path** (`step-main-path`) — The main narrative is laid out as an ordered sequence of steps.
  - Best case `wcbc-coherent-story`: Main path reads as one story
- Step 6: **Add relevant WCBC / recovery paths** (`step-add-wcbc`) — Worst-case and best-case branches are attached to the steps they belong to.
  - Worst case `wcbc-branches-swamp`: Recovery paths swamp the main narrative — Keep only branches that change what the first slice must handle.
- Step 7: **Review gaps and unresolved decisions** (`step-review-gaps`) — Open decisions and validation issues are made visible before approval.
- Step 9: **Review first slice candidates** (`step-review-slices`) — Candidate first slices through the approved narrative are compared.

## OUT OF SCOPE

- [step-start-product] Start product
- [step-confirm-intent] Confirm product intent
- [step-approve-narrative] Human approves narrative
- [step-select-slice] Human selects first slice
- [step-export-work] Export execution-ready work
- [need-shared-narrative] Need not served by this slice: Turn a product discussion into one narrative the whole team understands, without prior AI experience.
- [need-approve-meaning] Need not served by this slice: Remain the one who approves meaning; nothing counts as agreed until I approve it.
- [need-real-situations] Need not served by this slice: See real user situations, including failure and recovery, represented in the narrative.
- [need-see-gaps] Need not served by this slice: Spot gaps and unresolved decisions before anything is built on them.
- [need-buildable-slice] Need not served by this slice: Receive a first slice that is small, unambiguous and ready to execute.
- [need-stable-references] Need not served by this slice: Rely on stable ids and explicit relations rather than on where a card happens to sit.

## PERSONAS / NEEDS

- **Product Lead / Product Owner** (`persona-product-lead`, role not stated, persona) — Owns product intent and approves what the narrative means.
- **Domain or UX Expert** (`persona-domain-ux`, role not stated, persona) — Knows the real user situations, including where things go wrong.
- **Developer** (`persona-developer`, role not stated, persona) — Turns the approved narrative into a first delivery slice.

## ACCEPTANCE CRITERIA DRAFT

A draft derived from the map. A human has to confirm it before it binds anyone.

- **ac-1** [step-describe-idea] Product Lead / Product Owner / Domain or UX Expert can complete “Describe idea / provide discussion”: The team describes the idea or hands over an existing product discussion.
- **ac-2** [wcbc-vague-discussion] When “Discussion is vague or contradictory”, then: Record each contradiction as an open decision instead of guessing an answer.
- **ac-3** [step-define-personas] Product Lead / Product Owner / Domain or UX Expert can complete “Define personas and needs”: Who the product is for and what each persona needs from it.
- **ac-4** [step-main-path] Product Lead / Product Owner / Domain or UX Expert / Developer can complete “Build main / best-case path”: The main narrative is laid out as an ordered sequence of steps.
- **ac-5** [step-add-wcbc] Domain or UX Expert / Developer can complete “Add relevant WCBC / recovery paths”: Worst-case and best-case branches are attached to the steps they belong to.
- **ac-6** [wcbc-branches-swamp] When “Recovery paths swamp the main narrative”, then: Keep only branches that change what the first slice must handle.
- **ac-7** [step-review-gaps] Product Lead / Product Owner / Domain or UX Expert / Developer can complete “Review gaps and unresolved decisions”: Open decisions and validation issues are made visible before approval.
- **ac-8** [step-review-slices] Product Lead / Product Owner / Developer can complete “Review first slice candidates”: Candidate first slices through the approved narrative are compared.

## VERIFICATION EXPECTATIONS

- **ac-1** Show step-describe-idea working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-2** Provoke the situation of wcbc-vague-discussion and show, with a recorded run, that what follows matches the criterion.
- **ac-3** Show step-define-personas working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-4** Show step-main-path working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-5** Show step-add-wcbc working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-6** Provoke the situation of wcbc-branches-swamp and show, with a recorded run, that what follows matches the criterion.
- **ac-7** Show step-review-gaps working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-8** Show step-review-slices working for each named persona with a recorded run (test output or screen recording), not a description.

## OPEN HUMAN DECISIONS

- `dec-measure-faster` (open decision) What does "substantially faster" mean in measurable terms?
- `dec-slice-criteria` (open decision) What makes a slice candidate a "first useful" slice?
- `dec-agent-assistance` (open decision) Which steps do agents assist with once agent integration exists?
- `behavior_without_need:step-describe-idea` (review gap) Step “Describe idea / provide discussion” serves no need and no decided decision gives a rationale for it.
- `behavior_without_need:step-define-personas` (review gap) Step “Define personas and needs” serves no need and no decided decision gives a rationale for it.
- `behavior_without_need:step-add-wcbc` (review gap) Step “Add relevant WCBC / recovery paths” serves no need and no decided decision gives a rationale for it.
- `behavior_without_need:step-review-gaps` (review gap) Step “Review gaps and unresolved decisions” serves no need and no decided decision gives a rationale for it.
- `behavior_without_need:step-review-slices` (review gap) Step “Review first slice candidates” serves no need and no decided decision gives a rationale for it.
- `wcbc_without_outcome:wcbc-vague-discussion` (review gap) Worst case “Discussion is vague or contradictory” does not say where it leads: no recovery step, termination or escalation is referenced.
- `wcbc_without_outcome:wcbc-branches-swamp` (review gap) Worst case “Recovery paths swamp the main narrative” does not say where it leads: no recovery step, termination or escalation is referenced.
- `flag-1` (flag) None of the included steps references a need: the map gives no reason for this slice.

## SOURCE MAP REVISION

- Product: ASM – Agentic Story Mapping (`asm`), schema version 1
- Revision: 1 (approved)
- Approved by: Maya (E2E) at 2026-10-03T13:31:59.510Z
- Map fingerprint: `1be530e3`

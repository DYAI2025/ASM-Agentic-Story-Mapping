# Work order: Thread to “Export execution-ready work”

Slice `slice-outcome-thread` of ASM – Agentic Story Mapping, revision 3 (`4b538d76`).

Work order contract: `asm.execution-brief`, briefVersion 3.

## GOAL

Software teams without prior AI experience can move from product discussion to a shared, understandable product narrative and first useful delivery slice substantially faster. (`goal-faster-shared-narrative`)

## VERIFIED / APPROVED CONTEXT

- Approved: revision 3 by Maya (E2E) at 2026-10-02T23:11:43.010Z.
- Who else matters: considered by Maya (E2E) at 2026-10-02T23:11:43.377Z. A named human confirmed that they considered who else is relevant for the goal. That is what they did; it does not say the people on the map are complete.
- Slice selected by Maya (E2E) at 2026-10-02T23:11:43.643Z (candidate `ef5f52e6`, derivation rules version 2).
- Value: VALUE_RESOLVED (`need-shared-narrative`, `need-approve-meaning`, `need-buildable-slice`, `need-stable-references`). The slice references at least one need on the map. ASM has not measured any business value.
- Verified: nothing. Approved means a named human approved the narrative. ASM has verified nothing: no behaviour described here has been built or tested.

Why this slice:

- The last step “Export execution-ready work” (step-export-work) serves need-buildable-slice, need-stable-references; this slice is every step that serves one of those needs.
- Primary persona relevance: Product Lead / Product Owner (persona-product-lead) takes part in 3 of the 4 included steps.
- Persona overlap: 2 of the 4 included steps involve more than one persona.
- Need relation: serves 4 of 7 needs (need-shared-narrative, need-approve-meaning, need-buildable-slice, need-stable-references).
- Main-path completeness: reaches the end of the main path, “Export execution-ready work”.
- Scope: 4 of 12 main-path steps, with 2 worst-case branch(es) to handle.

Assumptions:

- Assumes “Start product” [step-start-product] has already happened outside this slice.
- Assumes the steps skipped between included steps are done by hand: [step-add-wcbc] [step-review-gaps] [step-approve-narrative] [step-walk-through-the-slice-with-the-team].
- Assumes the included needs contribute to the goal [goal-faster-shared-narrative]; the map relates steps to needs, not needs to the goal.

Decided:

- `dec-canonical-file` The canonical product model is a YAML file inside the repository — Given by the slice brief (no database, no graph server). A file is diffable, reviewable and readable by agents.
- `dec-position-not-semantics` Visual position is never the sole source of semantics — Narrative order lives in an explicit sequence field and relations in ids. Layout is stored separately and can change without touching meaning.
- `dec-human-approves` Only an explicit human action approves a revision — Narrative-first means humans define intent and approve meaning. Saving or editing never approves anything.

## IN SCOPE

- Step 5: **Build main / best-case path** (`step-main-path`) — The main narrative is laid out as an ordered sequence of steps.
  - Best case `wcbc-coherent-story`: Main path reads as one story
- Step 9: **Review first slice candidates** (`step-review-slices`) — Candidate first slices through the approved narrative are compared.
- Step 10: **Human selects first slice** (`step-select-slice`) — A human picks the first slice to deliver.
  - Worst case `wcbc-no-small-slice`: No candidate slice is small enough — Return to the main path and cut a thinner slice through it. → resumes at `step-main-path`
- Step 12: **Export execution-ready work** (`step-export-work`) — The selected slice leaves ASM in a form a delivery team can execute.
  - Worst case `wcbc-export-invalid`: Exported file fails validation on import — Validation names the exact path of each issue; an invalid file is never written.

## OUT OF SCOPE

- [step-start-product] Start product
- [step-describe-idea] Describe idea / provide discussion
- [step-confirm-intent] Confirm product intent
- [step-define-personas] Define personas and needs
- [step-add-wcbc] Add relevant WCBC / recovery paths
- [step-review-gaps] Review gaps and unresolved decisions
- [step-approve-narrative] Human approves narrative
- [step-walk-through-the-slice-with-the-team] Walk through the slice with the team
- [need-real-situations] Need not served by this slice: See real user situations, including failure and recovery, represented in the narrative.
- [need-see-gaps] Need not served by this slice: Spot gaps and unresolved decisions before anything is built on them.
- [need-trace-a-customer-problem-back-to-the-nar] Need not served by this slice: Trace a customer problem back to the narrative step it belongs to.

## PERSONAS / NEEDS

- **Product Lead / Product Owner** (`persona-product-lead`, role not stated, persona) — Owns product intent and approves what the narrative means.
  - `need-shared-narrative` Turn a product discussion into one narrative the whole team understands, without prior AI experience.
  - `need-approve-meaning` Remain the one who approves meaning; nothing counts as agreed until I approve it.
- **Domain or UX Expert** (`persona-domain-ux`, role not stated, persona) — Knows the real user situations, including where things go wrong.
- **Developer** (`persona-developer`, role not stated, persona) — Turns the approved narrative into a first delivery slice.
  - `need-buildable-slice` Receive a first slice that is small, unambiguous and ready to execute.
  - `need-stable-references` Rely on stable ids and explicit relations rather than on where a card happens to sit.

## ACCEPTANCE CRITERIA DRAFT

A draft derived from the map. A human has to confirm it before it binds anyone.

- **ac-1** [step-main-path] Product Lead / Product Owner / Domain or UX Expert / Developer can complete “Build main / best-case path”: The main narrative is laid out as an ordered sequence of steps.
- **ac-2** [step-review-slices] Product Lead / Product Owner / Developer can complete “Review first slice candidates”: Candidate first slices through the approved narrative are compared.
- **ac-3** [step-select-slice] Product Lead / Product Owner can complete “Human selects first slice”: A human picks the first slice to deliver.
- **ac-4** [wcbc-no-small-slice] When “No candidate slice is small enough”, then: Return to the main path and cut a thinner slice through it.
- **ac-5** [step-export-work] Developer can complete “Export execution-ready work”: The selected slice leaves ASM in a form a delivery team can execute.
- **ac-6** [wcbc-export-invalid] When “Exported file fails validation on import”, then: Validation names the exact path of each issue; an invalid file is never written.

## VERIFICATION EXPECTATIONS

- **ac-1** Show step-main-path working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-2** Show step-review-slices working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-3** Show step-select-slice working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-4** Provoke the situation of wcbc-no-small-slice and show, with a recorded run, that what follows matches the criterion.
- **ac-5** Show step-export-work working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-6** Provoke the situation of wcbc-export-invalid and show, with a recorded run, that what follows matches the criterion.

## OPEN HUMAN DECISIONS

- `dec-measure-faster` (open decision) What does "substantially faster" mean in measurable terms?
- `dec-slice-criteria` (open decision) What makes a slice candidate a "first useful" slice?
- `dec-export-format` (open decision) What form does "execution-ready work" take on export?
- `wcbc_without_outcome:wcbc-export-invalid` (review gap) Worst case “Exported file fails validation on import” does not say where it leads: no recovery step, termination or escalation is referenced.

## SOURCE MAP REVISION

- Product: ASM – Agentic Story Mapping (`asm`), schema version 1
- Revision: 3 (approved)
- Approved by: Maya (E2E) at 2026-10-02T23:11:43.010Z
- Map fingerprint: `4b538d76`

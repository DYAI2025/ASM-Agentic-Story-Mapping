# Work order: Resident path

Slice `slice-primary-persona` of Parcel lockers, revision 2 (`1c31c5cd`).

Work order contract: `asm.execution-brief`, briefVersion 3.

## GOAL

Residents collect a parcel without waiting for a courier. (`goal-parcel-lockers`)

## VERIFIED / APPROVED CONTEXT

- Approved: revision 2 by Maya (Product Lead) at 2026-10-03T20:36:30.993Z.
- Who else matters: considered by Maya (Product Lead) at 2026-10-03T20:36:31.247Z. A named human confirmed that they considered who else is relevant for the goal. That is what they did; it does not say the people on the map are complete.
- Slice selected by Maya (Product Lead) at 2026-10-03T20:36:31.460Z (candidate `4ce9e53f`, derivation rules version 2).
- Value: VALUE_RESOLVED (`need-get-my-parcel-on-the-day-it-arrives`, `need-know-when-something-has-arrived`). The slice references at least one need on the map. ASM has not measured any business value.
- Verified: nothing. Approved means a named human approved the narrative. ASM has verified nothing: no behaviour described here has been built or tested.

Why this slice:

- Resident (persona-resident) takes part in 3 of 4 main-path steps, more than any other persona; this slice is exactly those steps.
- Primary persona relevance: Resident (persona-resident) takes part in 3 of the 3 included steps.
- Persona overlap: 0 of the 3 included steps involve more than one persona.
- Need relation: serves 2 of 3 needs (need-get-my-parcel-on-the-day-it-arrives, need-know-when-something-has-arrived).
- Main-path completeness: reaches the end of the main path, “Resident takes the parcel”.
- Scope: 3 of 4 main-path steps, with 0 worst-case branch(es) to handle.
- Readiness: no open decision and no review gap touches this slice.

Assumptions:

- Assumes “Courier scans the parcel” [step-courier-scans-the-parcel] has already happened outside this slice.
- Assumes the included needs contribute to the goal [goal-parcel-lockers]; the map relates steps to needs, not needs to the goal.

Decided:

- None.

## IN SCOPE

- Step 2: **Resident gets a notification** (`step-resident-gets-a-notification`) — With a code.
- Step 3: **Resident opens the compartment** (`step-resident-opens-the-compartment`) — Enters the code at the locker.
- Step 4: **Resident takes the parcel** (`step-resident-takes-the-parcel`) — The compartment is free again.

## OUT OF SCOPE

- [step-courier-scans-the-parcel] Courier scans the parcel
- [need-drop-a-parcel-in-under-a-minute] Need not served by this slice: Drop a parcel in under a minute.

## PERSONAS / NEEDS

- **Resident** (`persona-resident`, Customer / buyer, User, persona) — Lives in the building and comes home late.
  - `need-get-my-parcel-on-the-day-it-arrives` Get my parcel on the day it arrives, even late at night.
  - `need-know-when-something-has-arrived` Know when something has arrived.

## ACCEPTANCE CRITERIA DRAFT

A draft derived from the map. A human has to confirm it before it binds anyone.

- **ac-1** [step-resident-gets-a-notification] Resident can complete “Resident gets a notification”: With a code.
- **ac-2** [step-resident-opens-the-compartment] Resident can complete “Resident opens the compartment”: Enters the code at the locker.
- **ac-3** [step-resident-takes-the-parcel] Resident can complete “Resident takes the parcel”: The compartment is free again.

## VERIFICATION EXPECTATIONS

- **ac-1** Show step-resident-gets-a-notification working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-2** Show step-resident-opens-the-compartment working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-3** Show step-resident-takes-the-parcel working for each named persona with a recorded run (test output or screen recording), not a description.

## OPEN HUMAN DECISIONS

- None.

## SOURCE MAP REVISION

- Product: Parcel lockers (`parcel-lockers`), schema version 1
- Revision: 2 (approved)
- Approved by: Maya (Product Lead) at 2026-10-03T20:36:30.993Z
- Map fingerprint: `1c31c5cd`

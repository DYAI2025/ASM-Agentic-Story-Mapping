# Work order: Thread to “Resident reports a problem”

Slice `slice-outcome-thread` of Parcel Locker Pickup, revision 2 (`4f8600c8`).

Work order contract: `asm.execution-brief`, briefVersion 3.

## GOAL

Residents collect a parcel from the building locker without waiting for a courier. (`goal-parcel-locker-pickup`)

## VERIFIED / APPROVED CONTEXT

- Approved: revision 2 by Noor (first-time Product Lead) at 2026-10-03T13:32:02.483Z.
- Who else matters: considered by Noor (first-time Product Lead) at 2026-10-03T13:32:02.800Z. A named human confirmed that they considered who else is relevant for the goal. That is what they did; it does not say the people on the map are complete.
- Slice selected by Noor (first-time Product Lead) at 2026-10-03T13:32:03.018Z (candidate `f532f5ce`, derivation rules version 2).
- Value: VALUE_RESOLVED (`need-get-my-parcel-on-the-day-it-arrives-when`, `need-hand-over-every-parcel-in-one-stop`). The slice references at least one need on the map. ASM has not measured any business value.
- Verified: nothing. Approved means a named human approved the narrative. ASM has verified nothing: no behaviour described here has been built or tested.

Why this slice:

- The last step “Resident reports a problem” (step-resident-reports-a-problem) serves need-get-my-parcel-on-the-day-it-arrives-when, need-hand-over-every-parcel-in-one-stop; this slice is every step that serves one of those needs.
- Primary persona relevance: Resident (persona-resident) takes part in 3 of the 4 included steps.
- Persona overlap: 1 of the 4 included steps involve more than one persona.
- Need relation: serves 2 of 2 needs (need-get-my-parcel-on-the-day-it-arrives-when, need-hand-over-every-parcel-in-one-stop).
- Main-path completeness: includes both the start “Courier loads the locker” and the end “Resident reports a problem”.
- Scope: 4 of 4 main-path steps, with 1 worst-case branch(es) to handle.
- Readiness: no open decision and no review gap touches this slice.

Assumptions:

- Assumes the included needs contribute to the goal [goal-parcel-locker-pickup]; the map relates steps to needs, not needs to the goal.

Decided:

- None.

## IN SCOPE

- Step 1: **Courier loads the locker** (`step-courier-loads-the-locker`) — One compartment per parcel.
  - Worst case `wcbc-courier-loads-the-locker-cannot-be-compl`: Courier loads the locker cannot be completed — Return to “Courier loads the locker” and try again. → resumes at `step-courier-loads-the-locker`
- Step 2: **Resident is told the parcel is there** (`step-resident-is-told-the-parcel-is-there`) — A code arrives on the phone.
- Step 3: **Resident opens the compartment** (`step-resident-opens-the-compartment`) — With the code, at any hour.
- Step 4: **Resident reports a problem** (`step-resident-reports-a-problem`) — When the compartment will not open, the courier comes back.

## OUT OF SCOPE

- None.

## PERSONAS / NEEDS

- **Resident** (`persona-resident`, Customer / buyer, User, persona) — Lives in the building and orders online.
  - `need-get-my-parcel-on-the-day-it-arrives-when` Get my parcel on the day it arrives, whenever I come home.
- **Courier** (`persona-courier`, Operator / support, persona) — Delivers parcels to the building.
  - `need-hand-over-every-parcel-in-one-stop` Hand over every parcel in one stop.

## ACCEPTANCE CRITERIA DRAFT

A draft derived from the map. A human has to confirm it before it binds anyone.

- **ac-1** [step-courier-loads-the-locker] Courier can complete “Courier loads the locker”: One compartment per parcel.
- **ac-2** [wcbc-courier-loads-the-locker-cannot-be-compl] When “Courier loads the locker cannot be completed”, then: Return to “Courier loads the locker” and try again.
- **ac-3** [step-resident-is-told-the-parcel-is-there] Resident can complete “Resident is told the parcel is there”: A code arrives on the phone.
- **ac-4** [step-resident-opens-the-compartment] Resident can complete “Resident opens the compartment”: With the code, at any hour.
- **ac-5** [step-resident-reports-a-problem] Resident / Courier can complete “Resident reports a problem”: When the compartment will not open, the courier comes back.

## VERIFICATION EXPECTATIONS

- **ac-1** Show step-courier-loads-the-locker working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-2** Provoke the situation of wcbc-courier-loads-the-locker-cannot-be-compl and show, with a recorded run, that what follows matches the criterion.
- **ac-3** Show step-resident-is-told-the-parcel-is-there working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-4** Show step-resident-opens-the-compartment working for each named persona with a recorded run (test output or screen recording), not a description.
- **ac-5** Show step-resident-reports-a-problem working for each named persona with a recorded run (test output or screen recording), not a description.

## OPEN HUMAN DECISIONS

- None.

## SOURCE MAP REVISION

- Product: Parcel Locker Pickup (`parcel-locker-pickup`), schema version 1
- Revision: 2 (approved)
- Approved by: Noor (first-time Product Lead) at 2026-10-03T13:32:02.483Z
- Map fingerprint: `4f8600c8`

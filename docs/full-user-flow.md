# The full user flow, start to finish and again

This page is the walk-through for the human review of the Full User Flow slice
(ASM-22): the visual and usability verdict. It shows the whole path a
first-time Product Lead takes — tutorial, existing material in, a reviewed
proposal, the map, review, approval, people, slices, the work order, start
over, and a fresh start right after — with one screenshot per state. Every
screenshot here is produced by the browser test
`tests/e2e/full-user-flow.spec.ts` through `npm run docs:refresh`, except the
provider error, which comes from the live harness (`npm run smoke:live`, the
half with a key that cannot work). The commit that last refreshed them is
`git log -1 -- docs/screenshots/fuf-01-fresh-start-with-tutorial.png`. The
verdict belongs to one exact commit; take the SHA from the review request,
check it out, and compare what you see with what is here.

The deterministic provider is used in the browser test, so the uploaded notes
file carries one item per line in the format the collapsed note under the
field shows; the pasted text is plain prose and contributes the open questions.
With a model connected (`ASM_AGENT_PROVIDER=openai|anthropic|openrouter`) the
same screens run from free text; that run is the live smoke recorded on ASM-25
and ASM-28.

## Walk it yourself

```bash
git checkout <the candidate SHA>
npm ci
ASM_PRODUCT_FILE=/tmp/asm-review/asm.product.yaml npm run dev   # a directory that does not exist yet is fine
open http://localhost:3000
```

Then follow the states below; the text to paste and the notes file are the
constants `PASTED` and `NOTES_MD` in the test file (save the second as
`kickoff-notes.md`). Nothing you do touches `product/asm.product.yaml`, and
*Start over* is refused on that file by design.

## The states

### 1. Fresh start, with the tutorial

No product exists. The tutorial is at its first step; the Product Flow is at
its first step too, and says it is not the tutorial.

![1 — fresh start](screenshots/fuf-01-fresh-start-with-tutorial.png)

### 2. The tutorial's last step

Four steps, Back/Next, Finish. Finishing changes nothing about the product.

![2 — tutorial](screenshots/fuf-02-tutorial-last-step.png)

### 3. Context: pasted text and a notes file

Prose in the field, a markdown file added next to it, listed with its id,
label and size, removable. Nothing is saved.

![3 — context bundle](screenshots/fuf-03-context-bundle.png)

### 4. The proposal, grouped

Goal (two readings, nothing chosen), personas, other actors, needs, the
suggested main path, open questions — each item with Use / Edit, the source
behind a disclosure, the preview below. Accept is disabled until a goal is
chosen.

![4 — grouped proposal](screenshots/fuf-04-grouped-proposal.png)

### 5. Chosen, edited, partly rejected

The first goal picked; one need reworded through its chip and by hand; one
step rejected and gone from the preview path. Still nothing on disk.

![5 — chosen, edited, rejected](screenshots/fuf-05-proposal-chosen-edited-rejected.png)

### 6. The first map

Proposed revision 1, with exactly what was chosen. Every card carries its
source (pasted text or the file).

![6 — first map](screenshots/fuf-06-first-map.png)

### 7. The Product Flow

Read from the map and the work state: three steps done, approval next.

![7 — product flow](screenshots/fuf-07-product-flow.png)

### 8. Review and worst cases

Fixed checks and the agent review; nothing is ticked for the user.

![8 — review](screenshots/fuf-08-review-and-wcbc.png)

### 9. Approved

By a named human, after one worst case was accepted into revision 2.

![9 — approved](screenshots/fuf-09-approved.png)

### 10. Slice candidates

After the people check. Readings of the map, no score, no ranking; reads do
not select.

![10 — candidates](screenshots/fuf-10-slice-candidates.png)

### 11. Selected: work order ready

A named human picked one; value resolved; JSON and Markdown exports, read
back in the test and bound to the map fingerprint, the candidate fingerprint
and the derivation version.

![11 — selected](screenshots/fuf-11-slice-selected-work-order-ready.png)

### 12. Start over, asked first

The confirmation says what goes and that there is no undo.

![12 — start over](screenshots/fuf-12-start-over-confirmation.png)

### 13. Fresh again, without a restart

The start screen; the tutorial is remembered as seen; every read answers
`no_product`; both files are gone.

![13 — fresh after start over](screenshots/fuf-13-fresh-after-start-over.png)

### 14. A second product, at once

Started in the same server: no selection, no people check, no stale state
from the first one.

![14 — second product](screenshots/fuf-14-second-product-fresh.png)

### 15. A provider that cannot answer

From the live harness: the configured provider with a key that cannot work.
The failure is said in the browser, nothing is written, no secret is shown.

![15 — provider error](screenshots/live-provider-error-bad-key.png)

## Live intake: one repair (ASM-29)

These three states come from `tests/e2e/schema-repair.spec.ts`. The app runs
its real `openai` adapter against a scripted model on localhost
(`tests/e2e/model-stub-server.ts`), so the request, the one repair and the
validation are the product's own; only the model's answers are scripted. No
key and no real model are involved. The live runs against the reference model
are the battery recorded on ASM-29.

### 16. An answer in the wrong shape, repaired once

The first answer has the shape External QA recorded from the reference model
(source fields beside each item, needs as `id`/`text`). The product asked once
more with the contract and what was refused; the second answer passed the
same checks as any other and is shown for review. Two model calls; nothing is
saved until Accept.

![16 — repaired proposal](screenshots/asm29-01-repaired-proposal.png)

### 17. Refused after the one repair

An answer that never has the contract's shape is refused after two calls,
never a third. The product file and the work state are unchanged. (How the
refusal reads to a first-time user is ASM-30.)

![17 — refused after repair](screenshots/asm29-02-refused-after-repair.png)

### 18. A near-miss quote, named in the repair

The first answer is in the right shape, but one quote is not in the text (its
first word dropped, the case of the next letter changed). The repair names it
with its value; the corrected answer is reviewed, and what Accept makes canon
quotes the text exactly.

![18 — near-miss quote repaired](screenshots/asm29-03-inexact-quote-repaired.png)

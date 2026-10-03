import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildExecutionBrief } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { approveRevision, updateCard } from "../../src/domain/operations";
import type { ProductDocument } from "../../src/domain/schema";
import { SLICE_DERIVATION_VERSION } from "../../src/domain/slices";
import { selectSlice, type PersonaCheck, type SliceSelection } from "../../src/domain/work-state";
import { SliceDrawer } from "../../src/ui/SliceDrawer";
import { loadFixture, peopleCheck } from "../domain/helpers";

const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };
const approved = (p: ProductDocument = loadFixture()) => approveRevision(p, APPROVAL);
const choose = (p: ProductDocument, candidateId = "slice-outcome-thread") =>
  selectSlice(p, { candidateId, selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: fingerprint(p), personaCheck: peopleCheck(p) });

/** With the people check a human made on this map when it is approved, unless another one (or none) is given. */
const render = (product: ProductDocument, selection: SliceSelection | null, personaCheck?: PersonaCheck | null) =>
  renderToStaticMarkup(
    createElement(SliceDrawer, {
      product,
      selection,
      personaCheck: personaCheck === undefined ? (product.revision.status === "approved" ? peopleCheck(product) : null) : personaCheck,
      onPersonaCheck: () => {},
      onClose: () => {},
      onSelection: () => {},
    }),
  );
const checkState = (html: string) => /data-testid="people-check" data-state="(\w+)"/.exec(html)?.[1];

/** The text of the element with this test id, or null when it is not rendered. Only for elements without nested tags of the same name. */
function part(html: string, testId: string): string | null {
  const match = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return match ? match[2].replace(/<[^>]+>/g, "") : null;
}
const gateState = (html: string) => /data-testid="slice-gate" data-selection-state="(\w+)"/.exec(html)?.[1];

/** The map changes after the selection and is approved again: the selection is stale. */
function editedAfterSelection(): [ProductDocument, SliceSelection] {
  const first = approved();
  const selection = choose(first);
  const edited = updateCard(first, "step-export-work", { description: "Changed after selection." });
  return [approveRevision(edited, { approvedBy: "Ada", approvedAt: "2026-10-03T10:00:00.000Z" }), selection];
}

describe("slice drawer: the people check comes before any selection", () => {
  it("approved, nobody confirmed yet: the people are listed, ASM claims nothing, and no slice can be selected", () => {
    const html = render(approved(), null, null);
    expect(checkState(html)).toBe("none");
    expect(part(html, "people-check-list")).toContain("Product Lead / Product Owner");
    expect(html).toContain("ASM cannot know whether someone relevant for this goal is missing");
    expect(html).toContain(">I have considered who else is relevant</button>");
    expect(html).not.toContain('data-testid="people-check-record"');
    expect(html).not.toContain('data-testid="people-check-stale"');
    expect(part(html, "selection-needs-people-check")).toContain("once you have confirmed");
    // Every select button is there and disabled.
    expect(html.match(/data-testid="select-slice-[\w-]+" disabled=""/g)).toHaveLength(3);
    expect(html).not.toContain("export-work-order");
  });

  it("confirmed on this map: the record names who and says it is not a claim of completeness; selecting is possible", () => {
    const html = render(approved(), null);
    expect(checkState(html)).toBe("current");
    expect(part(html, "people-check-record")).toContain("Confirmed by Maya");
    expect(part(html, "people-check-record")).toContain("This does not say the list is complete");
    expect(html).not.toContain(">I have considered who else is relevant</button>");
    expect(html.match(/data-testid="select-slice-[\w-]+" disabled=""/g)).toBeNull();
  });

  it("confirmed on an earlier map: shown as stale, not as never confirmed, and selecting is blocked again", () => {
    const first = approved();
    const again = approveRevision(updateCard(first, "persona-developer", { description: "Changed." }), { approvedBy: "Ada", approvedAt: "2026-10-03T10:00:00.000Z" });
    const html = render(again, null, peopleCheck(first));
    expect(checkState(html)).toBe("stale");
    expect(part(html, "people-check-stale")).toContain("Stale confirmation");
    expect(part(html, "people-check-stale")).toContain("Maya");
    expect(part(html, "people-check-stale")).toContain("The map has changed since, so it has to be made again");
    expect(html).toContain(">I have considered who else is relevant</button>");
    expect(html.match(/data-testid="select-slice-[\w-]+" disabled=""/g)).toHaveLength(3);
  });

  it("on a proposed map there is no people check to make yet: approval comes first", () => {
    const html = render(loadFixture(), null, null);
    expect(html).not.toContain('data-testid="people-check"');
    expect(html).toContain('data-testid="slice-needs-approval"');
  });
});

describe("slice drawer: selection state", () => {
  it("never selected: says so, and shows no stale state", () => {
    const html = render(approved(), null);
    expect(gateState(html)).toBe("none");
    expect(part(html, "selection-none")).toContain("No slice is selected");
    expect(html).not.toContain('data-testid="selection-stale"');
    expect(html).not.toContain("export-work-order");
  });

  it("fresh valid selection: the record and the export, no stale state", () => {
    const product = approved();
    const html = render(product, choose(product));
    expect(gateState(html)).toBe("current");
    expect(part(html, "selection-record")).toContain("Selected: Thread to “Export execution-ready work”");
    expect(html).toContain('href="/api/brief?format=md"');
    expect(html).toContain('href="/api/brief?format=json"');
    expect(html).toContain(">Selected</button>");
    expect(html).not.toContain('data-testid="selection-stale"');
    expect(html).not.toContain('data-testid="selection-none"');
  });

  it("stale selection after a map change: visible, names the earlier selection and the reason, offers reselecting", () => {
    const [product, selection] = editedAfterSelection();
    const html = render(product, selection);
    expect(gateState(html)).toBe("stale");
    expect(html).toContain('data-testid="selection-stale"');
    expect(part(html, "stale-heading")).toContain("Stale selection");
    const previous = part(html, "stale-previous");
    expect(previous).toContain("slice-outcome-thread");
    expect(previous).toContain("Thread to “Export execution-ready work”");
    expect(previous).toContain("Maya");
    expect(previous).toContain("revision 1");
    expect(part(html, "stale-reason")).toContain("Product Map changed");
    expect(part(html, "stale-reason")).toContain("the map has changed since the slice was selected");
    expect(part(html, "reselect-candidates")).toBe("Reselect from current candidates");

    // Distinguishable from "nothing selected", and nothing is presented as selected or exportable.
    expect(html).not.toContain('data-testid="selection-none"');
    expect(html).not.toContain("No slice is selected");
    expect(html).not.toContain('data-testid="selection-record"');
    expect(html).not.toContain("export-work-order");
    expect(html).not.toContain(">Selected</button>");
    expect(html).not.toContain('class="chosen"');
    // The stale selection still cannot be exported.
    expect(buildExecutionBrief(product, selection)).toMatchObject({ ok: false, issues: [{ code: "stale_selection" }] });
  });

  it("stale selection on a revision that is only proposed: still visible", () => {
    const first = approved();
    const selection = choose(first);
    const html = render(updateCard(first, "step-export-work", { description: "Changed after selection." }), selection);
    expect(gateState(html)).toBe("stale");
    expect(part(html, "stale-reason")).toContain("Product Map changed");
    expect(html).toContain('data-testid="slice-needs-approval"');
  });

  it("names which of derivation rules and candidate changed", () => {
    const product = approved();
    const rules = render(product, { ...choose(product), derivationVersion: SLICE_DERIVATION_VERSION + 1 });
    expect(gateState(rules)).toBe("stale");
    expect(part(rules, "stale-reason")).toContain("Derivation changed");

    const candidate = render(product, { ...choose(product), candidateFingerprint: "00000000" });
    expect(part(candidate, "stale-reason")).toContain("Candidate changed");

    const gone = render(product, { ...choose(product), candidateId: "slice-no-longer-derived" });
    expect(part(gone, "stale-reason")).toContain("Candidate changed");
    expect(part(gone, "stale-previous")).toContain("slice-no-longer-derived");
    expect(part(gone, "stale-previous")).toContain("no candidate with this id is derived from the current map");
  });
});

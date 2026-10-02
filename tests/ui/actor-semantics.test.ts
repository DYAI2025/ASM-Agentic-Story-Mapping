import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Persona } from "../../src/domain/schema";
import { ActorSemantics } from "../../src/ui/ActorSemantics";

const render = (actor: Persona, needCount: number, readOnly = false) =>
  renderToStaticMarkup(createElement(ActorSemantics, { actor, needCount, readOnly, onSave: async () => true }));

/** The text of the element with this test id, or null when it is not rendered. */
function part(html: string, testId: string): string | null {
  const match = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return match ? match[2].replace(/<[^>]+>/g, "") : null;
}

const base = { id: "persona-dev", name: "Developer", description: "" };

describe("actor card: roles and persona are shown as the map states them", () => {
  it("an entry from before the fields existed: role not stated, persona", () => {
    const html = render(base, 2);
    expect(part(html, "roles-persona-dev")).toBe("Role not stated");
    expect(part(html, "perspective-persona-dev")).toBe("Persona");
    expect(html).toContain('data-persona="true"');
    expect(html).not.toContain("unresolved-persona-dev");
  });

  it("several roles are all shown, with their plain names", () => {
    const html = render({ ...base, roles: ["customer", "user", "delivery_participant"] }, 1);
    expect(part(html, "roles-persona-dev")).toBe("Customer / buyerUserDelivery participant");
    expect(html).toContain('data-role="delivery_participant"');
  });

  it("a delivery participant who is not a persona: shown as not a persona, nothing unresolved", () => {
    const html = render({ ...base, roles: ["delivery_participant"], persona: false }, 0);
    expect(part(html, "perspective-persona-dev")).toContain("Not a persona");
    expect(html).toContain('data-persona="false"');
    expect(html).toContain('data-unresolved="false"');
    expect(html).not.toContain("unresolved-persona-dev");
  });

  it("a delivery participant who is a persona: the role does not hide the persona, and the missing need is unresolved", () => {
    const html = render({ ...base, roles: ["delivery_participant"], persona: true }, 0);
    expect(part(html, "perspective-persona-dev")).toBe("Persona");
    expect(html).toContain('data-unresolved="true"');
    expect(part(html, "unresolved-persona-dev")).toContain("Unresolved: no need of this persona is on the map");
    expect(part(html, "unresolved-persona-dev")).toContain("ASM does not fill this in");
  });

  it("a persona with a need is not marked unresolved", () => {
    expect(render({ ...base, roles: ["user"], persona: true }, 1)).not.toContain("unresolved-persona-dev");
  });

  it("while a proposal is under review the card offers no editing", () => {
    expect(render(base, 1, false)).toContain("Roles and persona…");
    expect(render(base, 1, true)).not.toContain("Roles and persona…");
  });
});

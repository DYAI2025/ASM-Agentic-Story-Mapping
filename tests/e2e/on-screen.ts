import type { Locator } from "@playwright/test";

/**
 * Whether the text of an element can actually be read on screen, not only
 * found in the DOM (ASM-30). Three verifier rounds found the same class: a
 * sentence present in the markup, or even in `innerText`, yet invisible —
 * hidden, transparent, zero-sized, off-screen, clipped, or text added by CSS
 * that no DOM read sees. This check looks at what is painted: every text node
 * in the element (except inside a disclosure the human has not opened) must
 *
 * - lie inside the viewport and inside the element,
 * - not be cut off by any ancestor up to the element that clips (overflow,
 *   `clip`, `clip-path`),
 * - have a visible size, be visible by `checkVisibility` with opacity and
 *   visibility taken into account, and
 * - contrast with its effective background at least 3:1;
 *
 * and no element may add text through `::before` / `::after`. It returns the
 * problems found, one line each; an empty list means readable. It is not a
 * pixel comparison: overlap by another element is not looked for.
 */
export async function unreadableParts(element: Locator): Promise<string[]> {
  await element.scrollIntoViewIfNeeded();
  return element.evaluate((root) => {
    const problems: string[] = [];
    const rootRect = root.getBoundingClientRect();
    const inside = (r: DOMRect, outer: DOMRect) =>
      r.left >= outer.left - 1 && r.top >= outer.top - 1 && r.right <= outer.right + 1 && r.bottom <= outer.bottom + 1;
    const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    if (!inside(rootRect, viewport)) problems.push("the element is not wholly inside the viewport");

    const rgba = (color: string): [number, number, number, number] => {
      const parts = (/rgba?\(([^)]+)\)/.exec(color)?.[1] ?? "0 0 0").split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    const luminance = ([r, g, b]: number[]) => {
      const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const background = (from: Element): number[] => {
      for (let node: Element | null = from; node; node = node.parentElement) {
        const color = rgba(getComputedStyle(node).backgroundColor);
        if (color[3] > 0) return color;
      }
      return [255, 255, 255, 1];
    };
    const closedAway = (el: Element) => {
      const details = el.closest("details");
      return details !== null && !details.open && el.closest("summary") === null;
    };

    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      if (closedAway(el)) continue;
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStyle(el, pseudo).content;
        if (content !== "none" && content !== "normal" && content !== '""')
          problems.push(`<${el.tagName.toLowerCase()}> adds text through ${pseudo}: ${content}`);
      }
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (text === "" || el === null || closedAway(el)) continue;
      const label = `"${text.slice(0, 40)}"`;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) problems.push(`${label} is not visible`);
      if (rect.width < 4 || rect.height < 8 || parseFloat(style.fontSize) < 9) problems.push(`${label} has no readable size`);
      if (!inside(rect, rootRect)) problems.push(`${label} lies outside the element`);
      for (let a: Element | null = el; a && a !== root.parentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.clip !== "auto" && s.clip !== "" && s.position === "absolute") problems.push(`${label} is clipped by clip on <${a.tagName.toLowerCase()}>`);
        if (s.clipPath !== "none") problems.push(`${label} is clipped by clip-path on <${a.tagName.toLowerCase()}>`);
        if ((s.overflowX !== "visible" || s.overflowY !== "visible") && !inside(rect, a.getBoundingClientRect()))
          problems.push(`${label} is cut off by <${a.tagName.toLowerCase()}>`);
      }
      const color = rgba(style.color);
      if (color[3] < 0.5) problems.push(`${label} is (nearly) transparent`);
      const [l1, l2] = [luminance(color), luminance(background(el))].sort((x, y) => y - x);
      if ((l1 + 0.05) / (l2 + 0.05) < 3) problems.push(`${label} has too little contrast`);
    }
    return problems;
  });
}

/** The lines a reader sees in an element's innerText, trimmed, empty ones dropped. */
export const screenLines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

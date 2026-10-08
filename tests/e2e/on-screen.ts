import type { Locator, Page } from "@playwright/test";

/**
 * A presence check on the rendered pixels (ASM-30): every line of an element
 * shows some legible ink where a reader can see it. It is not a completeness
 * check. Five verifier rounds attacked the oracles of this test with CSS that
 * hides text while the DOM still holds it; this one is what the evidence
 * supports, and its limits are named below instead of claimed away. The check:
 *
 * - every line (an element with text of its own, outside a disclosure the
 *   human has not opened) is scrolled into view the way a reader could (a
 *   container that clips without scrolling is not scrolled) and must lie
 *   inside the viewport and inside the element under test, have a line box
 *   at least `MIN_LINE_PX` high as rendered, and not be cut off by any
 *   ancestor up to the document;
 * - the line's area is photographed as it is and again with only its glyphs
 *   made transparent (backgrounds and anything over or under it stay); at
 *   least `MIN_INK` pixels must differ between the two with a contrast of 3:1
 *   or more. So a line that is transparent, faded to near nothing, filtered
 *   or masked away whole, blended away, on a background of its own colour,
 *   or painted over whole, fails;
 * - no element in it may add text through `::before`, `::after` or a
 *   `::marker` with content of its own.
 *
 * It returns the problems found, one line each. An empty list means: every
 * line is in view and shows at least `MIN_INK` legible pixels. It does NOT
 * mean every word is readable. Not detected (measured by the verifier on
 * 29a41d1): part of a line covered, clipped by the line's own box, cut by
 * `text-overflow: ellipsis`, masked in part, squeezed by `scaleX`, struck
 * through by a bar; glyphs that are not the words (an icon font, reversed
 * text); blur; a change after the photograph (a delayed fade); contrast
 * between 3:1 and the 4.5:1 that WCAG asks for body text. Text painted only
 * by `text-shadow` fails although readable. The words are checked by
 * `innerText` beside this; that the whole message reads well is the human's
 * visual verdict on the gallery screenshots, on the exact commit.
 */
const MIN_INK = 12;
/** A line box as rendered, transforms included; body text here is about 17 px, the smallest text about 14 px. */
const MIN_LINE_PX = 12;
const PROBE = "data-paint-probe";

export async function unreadableParts(element: Locator): Promise<string[]> {
  const page: Page = element.page();
  await element.scrollIntoViewIfNeeded();
  const { problems, count } = await element.evaluate((root, PROBE) => {
    const problems: string[] = [];
    const closedAway = (el: Element) => {
      const details = el.closest("details");
      return details !== null && !details.open && el.closest("summary") === null;
    };
    const all = [root, ...Array.from(root.querySelectorAll("*"))].filter((el) => !closedAway(el));
    for (const el of all) {
      for (const pseudo of ["::before", "::after", "::marker"]) {
        const content = getComputedStyle(el, pseudo).content;
        if (content !== "none" && content !== "normal" && content !== '""')
          problems.push(`<${el.tagName.toLowerCase()}> adds text through ${pseudo}: ${content}`);
      }
    }
    // A line: an element with a text node of its own.
    const lines = all.filter((el) => Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== ""));
    lines.forEach((el, i) => el.setAttribute(PROBE, String(i)));
    return { problems, count: lines.length };
  }, PROBE);

  try {
    for (let i = 0; i < count; i++) {
      const line = page.locator(`[${PROBE}="${i}"]`);
      const measured = await line.evaluate((el, { root: rootHandle, minLine }) => {
        const root = rootHandle as Element;
        // Scroll it into view as a human could: a container that clips without scrolling (overflow hidden or
        // clip) cannot be scrolled by a reader, so whatever scrollIntoView moved there is put back.
        const unscrollable: Array<[Element, number, number]> = [];
        for (let a: Element | null = el.parentElement; a; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (/hidden|clip/.test(s.overflowX + s.overflowY)) unscrollable.push([a, a.scrollTop, a.scrollLeft]);
        }
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        for (const [a, scrollTop, scrollLeft] of unscrollable) [a.scrollTop, a.scrollLeft] = [scrollTop, scrollLeft];
        const label = `"${(el.textContent ?? "").trim().slice(0, 40)}"`;
        const found: string[] = [];
        // The union of the line's own text, as rendered (transforms included).
        let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? "").trim() === "") continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          [left, top, right, bottom] = [Math.min(left, r.left), Math.min(top, r.top), Math.max(right, r.right), Math.max(bottom, r.bottom)];
        }
        if (left === Infinity) return { found, label, clip: null };
        const rect = new DOMRect(left, top, right - left, bottom - top);
        const inside = (r: DOMRect, outer: DOMRect) =>
          r.left >= outer.left - 1 && r.top >= outer.top - 1 && r.right <= outer.right + 1 && r.bottom <= outer.bottom + 1;
        if (rect.height < minLine) found.push(`${label} is under ${minLine} px high as rendered`);
        if (!inside(rect, new DOMRect(0, 0, window.innerWidth, window.innerHeight))) found.push(`${label} is not inside the viewport`);
        if (!inside(rect, root.getBoundingClientRect())) found.push(`${label} lies outside the element`);
        for (let a: Element | null = el.parentElement; a; a = a.parentElement) {
          const s = getComputedStyle(a);
          const clips = s.overflowX !== "visible" || s.overflowY !== "visible" || s.clipPath !== "none" || (s.clip !== "auto" && s.clip !== "");
          if (clips && !inside(rect, a.getBoundingClientRect())) found.push(`${label} is cut off by <${a.tagName.toLowerCase()}>`);
        }
        const x = Math.max(0, Math.floor(rect.left) - 2);
        const y = Math.max(0, Math.floor(rect.top) - 2);
        const width = Math.min(window.innerWidth, Math.ceil(rect.right) + 2) - x;
        const height = Math.min(window.innerHeight, Math.ceil(rect.bottom) + 2) - y;
        return { found, label, clip: width > 0 && height > 0 ? { x, y, width, height } : null };
      }, { root: await element.elementHandle(), minLine: MIN_LINE_PX });
      problems.push(...measured.found);
      if (!measured.clip) {
        problems.push(`line ${i} has no area on screen`);
        continue;
      }
      const painted = await page.screenshot({ clip: measured.clip });
      // Only the glyphs go: backgrounds, borders and whatever lies over or under the line stay as they are.
      await line.evaluate((el) => {
        (el as HTMLElement).style.setProperty("color", "transparent", "important");
        (el as HTMLElement).style.setProperty("-webkit-text-fill-color", "transparent", "important");
      });
      const blank = await page.screenshot({ clip: measured.clip });
      await line.evaluate((el) => {
        (el as HTMLElement).style.removeProperty("color");
        (el as HTMLElement).style.removeProperty("-webkit-text-fill-color");
      });
      const ink = await inkPixels(page, painted, blank);
      if (ink < MIN_INK) problems.push(`${measured.label} is not painted readably (${ink} pixels at 3:1 or more)`);
    }
  } finally {
    // The probe marks go whatever happened, so a failed check leaves the page as it was.
    await element.evaluate((root, PROBE) => root.querySelectorAll(`[${PROBE}]`).forEach((el) => el.removeAttribute(PROBE)), PROBE);
  }
  return problems;
}

/** Pixels that differ between two screenshots of one area with a contrast of 3:1 or more, decoded by the browser itself. */
async function inkPixels(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([one, two]) => {
      const pixels = async (base64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const [p, q] = [await pixels(one), await pixels(two)];
      const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const lum = (d: Uint8ClampedArray, i: number) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      let ink = 0;
      for (let i = 0; i < Math.min(p.length, q.length); i += 4) {
        const [hi, lo] = [lum(p, i), lum(q, i)].sort((x, y) => y - x);
        if ((hi + 0.05) / (lo + 0.05) >= 3) ink++;
      }
      return ink;
    },
    [a.toString("base64"), b.toString("base64")],
  );
}

/** The lines a reader sees in an element's innerText, trimmed, empty ones dropped. */
export const screenLines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

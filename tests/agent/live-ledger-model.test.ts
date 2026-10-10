import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetRefusal, openLedger, type Ledger } from "../live/budget";

/**
 * ASM-34, AC-6, review round 3 on 198b1f9: the guard's tests had been
 * example-based, and every review round found a branch no example reached.
 * This test drives the ledger with random sequences of what runs do —
 * reserve, settle with any call count and provider, stop, open again from
 * disk, several handles at once — and compares every step with a reference
 * model written for this test alone: a submission is charged at least its
 * whole bound, each call beyond two at the repair bound, never less than
 * before; a reservation goes through exactly when the ledger is not stopped
 * and the spend plus the bound stays within the budget. The sequences are
 * seeded, so a failure names a sequence that can be run again.
 */
const MODEL = "claude-haiku-5-5";
const BUDGET = 1;
const MICRO = 1_000_000;
const SEQUENCES = 150;
const STEPS = 25;

/** A small, seeded generator (mulberry32): the same seed gives the same sequence. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] };
}

type ModelEntry = { first: number; repair: number; total: number; charged: number; settled: boolean };
type ModelState = { entries: ModelEntry[]; stopped: boolean };
const spentOf = (m: ModelState) => m.entries.reduce((sum, e) => sum + e.charged, 0);
const chargeFor = (e: ModelEntry, calls: number | null) => Math.max(e.total, calls !== null && calls > 2 ? e.first + (calls - 1) * e.repair : 0);

describe("the ledger, against a reference model, over random sequences of what paid runs do", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-ledger-model-")));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it(`keeps the model's spend, refusals and stop over ${SEQUENCES} seeded sequences of ${STEPS} steps`, async () => {
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const rng = random(seed);
      const file = path.join(dir, `ledger-${seed}.json`);
      const handles: Ledger[] = [await openLedger(file, BUDGET, { create: true })];
      const model: ModelState = { entries: [], stopped: false };
      const trail: string[] = [];
      const fail = (why: string) => `seed ${seed}, after ${trail.join(" → ")}: ${why}`;

      for (let step = 0; step < STEPS; step++) {
        const handle = rng.pick(handles);
        const action = rng.int(10);
        if (action < 5) {
          // A reservation with a plausible bound: first and repair at least one call's output budget (8 800 µUSD).
          const first = 8_801 + rng.int(60_000);
          const repair = 8_801 + rng.int(150_000);
          // The ledger rounds each part up to the micro-dollar (never down); the model does the same.
          const f = Math.ceil((first / MICRO) * MICRO);
          const r = Math.ceil((repair / MICRO) * MICRO);
          const expectOk = !model.stopped && spentOf(model) + Math.max(f + r, Math.ceil(((first + repair) / MICRO) * MICRO)) <= BUDGET * MICRO;
          trail.push(`reserve(${first}+${repair})`);
          let ok = true;
          try {
            await handle.reserve({ firstCallUsd: first / MICRO, repairCallUsd: repair / MICRO, totalUsd: (first + repair) / MICRO }, { label: `s${step}`, commit: "c", model: MODEL });
          } catch (error) {
            if (!(error instanceof BudgetRefusal)) throw error;
            ok = false;
          }
          expect(ok, fail(`reserve went ${ok ? "through" : "refused"}, the model says ${expectOk ? "through" : "refused"}`)).toBe(expectOk);
          const t = Math.max(f + r, Math.ceil(((first + repair) / MICRO) * MICRO));
          if (ok) model.entries.push({ first: f, repair: r, total: t, charged: t, settled: false });
        } else if (action < 8 && model.entries.some((e) => !e.settled)) {
          const open = model.entries.map((e, id) => ({ e, id })).filter(({ e }) => !e.settled);
          const { e, id } = rng.pick(open);
          const calls = rng.pick([null, 0, 1, 2, 3, 5]);
          const stop = rng.int(6) === 0 ? "another model answered" : undefined;
          trail.push(`settle(${id}, calls ${calls}${stop ? ", stop" : ""})`);
          await handle.settle(id, { modelCalls: calls, serverProvider: calls ? `anthropic (${MODEL})` : null, ...(stop ? { stop } : {}) });
          e.charged = Math.max(e.charged, chargeFor(e, calls));
          e.settled = true;
          if (stop) model.stopped = true;
        } else if (action === 8) {
          trail.push("stop");
          await handle.stop("stopped by hand");
          model.stopped = true;
        } else {
          trail.push("open again");
          handles.push(await openLedger(file, BUDGET));
        }

        // What any run would read from disk now, checked as a whole on every step.
        const fresh = await openLedger(file, BUDGET);
        expect(Math.round(fresh.spentUsd() * MICRO), fail("spend on disk")).toBe(spentOf(model));
        expect(fresh.entries().length, fail("entries on disk")).toBe(model.entries.length);
        const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
        expect(Boolean(onDisk.stoppedReason), fail("stopped on disk")).toBe(model.stopped);
        // No budget check here: a call count above two raises a charge after its reservation, past the budget if it
        // must. The budget decides only whether a reservation goes through, which the reserve step compares above.
      }
    }
  }, 120_000);
});

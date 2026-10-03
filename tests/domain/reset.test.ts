import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveRevision } from "../../src/domain/operations";
import { EMPTY_WORK_STATE } from "../../src/domain/work-state";
import { productFilePath, resetProduct, workStateFilePath } from "../../src/server/store";
import { FIXTURE_PATH, fixtureText, loadFixture, peopleCheck } from "./helpers";

const approved = () => approveRevision(loadFixture(), { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" });

/**
 * Start over: the user-workspace product and its work state go away together,
 * fail-closed. The checked-in self-map is never the target of a normal reset.
 */
describe("reset: start over on a user workspace", () => {
  let dir: string;
  const exists = (file: string) => fs.access(file).then(() => true, () => false);

  beforeEach(async () => {
    // Real path: on macOS the temp dir is a symlink, and process.cwd() reports the resolved one.
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-reset-")));
    process.env.ASM_PRODUCT_FILE = path.join(dir, "p.product.yaml");
    await fs.writeFile(process.env.ASM_PRODUCT_FILE, fixtureText());
    await fs.writeFile(
      workStateFilePath(),
      JSON.stringify({ ...EMPTY_WORK_STATE, personaCheck: peopleCheck(approved()) }),
    );
  });

  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    delete process.env.ASM_WORK_STATE_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removes the product and its work state, and reports success only when neither is left", async () => {
    const product = productFilePath();
    const work = workStateFilePath();
    expect(await exists(product)).toBe(true);
    expect(await exists(work)).toBe(true);

    const result = await resetProduct();
    expect(result).toEqual({ ok: true, removed: { product, workState: work } });
    expect(await exists(product)).toBe(false);
    expect(await exists(work)).toBe(false);
  });

  it("with no work state the product alone goes; the work state is reported as absent, not as removed", async () => {
    await fs.rm(workStateFilePath());
    const result = await resetProduct();
    expect(result).toEqual({ ok: true, removed: { product: productFilePath(), workState: null } });
    expect(await exists(productFilePath())).toBe(false);
  });

  it("removes the work state where it really is: an ASM_WORK_STATE_FILE elsewhere, not a sibling guessed from the product path", async () => {
    // Found by the independent verifier on bed6109: a reset that derived the sibling path would leave the real work state behind.
    const elsewhere = path.join(dir, "state", "somewhere-else.work-state.json");
    await fs.mkdir(path.dirname(elsewhere), { recursive: true });
    await fs.rename(workStateFilePath(), elsewhere);
    process.env.ASM_WORK_STATE_FILE = elsewhere;
    expect(workStateFilePath()).toBe(elsewhere);

    const result = await resetProduct();
    expect(result).toEqual({ ok: true, removed: { product: productFilePath(), workState: elsewhere } });
    expect(await exists(elsewhere)).toBe(false);
    expect(await exists(productFilePath())).toBe(false);
  });

  describe("a work-state override that is not a work state is refused before anything is touched", () => {
    // External review F1 on 2ff9ccf: the override was unlinked first, whatever it pointed at.
    it("the repository seed as the work-state path", async () => {
      const seed = path.join(dir, "repo", "product", "asm.product.yaml");
      await fs.mkdir(path.dirname(seed), { recursive: true });
      await fs.copyFile(FIXTURE_PATH, seed);
      const cwd = process.cwd();
      process.chdir(path.join(dir, "repo"));
      process.env.ASM_WORK_STATE_FILE = "product/asm.product.yaml";
      try {
        const result = await resetProduct();
        expect(result.ok).toBe(false);
        expect(!result.ok && result.issues[0].code).toBe("work_state_path_invalid");
      } finally {
        process.chdir(cwd);
      }
      expect(await fs.readFile(seed, "utf8")).toBe(fixtureText());
      expect(await exists(productFilePath())).toBe(true);
    });

    it("the product itself as the work-state path", async () => {
      process.env.ASM_WORK_STATE_FILE = productFilePath();
      const result = await resetProduct();
      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues[0].code).toBe("work_state_path_invalid");
      expect(await fs.readFile(productFilePath(), "utf8")).toBe(fixtureText());
    });

    it("a path that is not named like a work state, or a symlink to the product", async () => {
      process.env.ASM_WORK_STATE_FILE = path.join(dir, "notes.json");
      await fs.writeFile(process.env.ASM_WORK_STATE_FILE, "{}");
      let result = await resetProduct();
      expect(!result.ok && result.issues[0].code).toBe("work_state_path_invalid");
      expect(await exists(path.join(dir, "notes.json"))).toBe(true);

      const link = path.join(dir, "linked.work-state.json");
      await fs.symlink(productFilePath(), link);
      process.env.ASM_WORK_STATE_FILE = link;
      result = await resetProduct();
      expect(!result.ok && result.issues[0].code).toBe("work_state_path_invalid");
      expect(await fs.readFile(productFilePath(), "utf8")).toBe(fixtureText());
    });
  });

  it("nothing to reset: a missing product is no_product, and an unrelated work state is left alone", async () => {
    await fs.rm(productFilePath());
    const result = await resetProduct();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0].code).toBe("no_product");
    expect(await exists(workStateFilePath())).toBe(true);
  });

  /**
   * The seed is `<cwd>/product/asm.product.yaml`. These tests run against a copy of
   * the repository layout in a scratch directory, so an implementation that got the
   * rule wrong deletes the copy, never the checked-in file.
   */
  describe("the repository seed", () => {
    const repoCwd = process.cwd();
    let seed: string;

    beforeEach(async () => {
      seed = path.join(dir, "repo", "product", "asm.product.yaml");
      await fs.mkdir(path.dirname(seed), { recursive: true });
      await fs.copyFile(FIXTURE_PATH, seed);
      process.chdir(path.join(dir, "repo"));
    });
    afterEach(() => process.chdir(repoCwd));

    it("is what no ASM_PRODUCT_FILE means, and is never reset", async () => {
      delete process.env.ASM_PRODUCT_FILE;
      expect(productFilePath()).toBe(seed);

      const result = await resetProduct();
      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues[0]).toMatchObject({ code: "seed_protected", path: seed });
      expect(await fs.readFile(seed, "utf8")).toBe(fixtureText());
    });

    it("is refused also when ASM_PRODUCT_FILE names it explicitly, in any spelling of the path", async () => {
      // Relative to the working directory, as someone would type it in a shell.
      process.env.ASM_PRODUCT_FILE = "product/./asm.product.yaml";

      const result = await resetProduct();
      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues[0].code).toBe("seed_protected");
      expect(await fs.readFile(seed, "utf8")).toBe(fixtureText());
    });
  });

  it("work state first: when the product cannot be removed the result is a failure, never a fresh state", async () => {
    // A directory in place of the product file: it exists, so this is not no_product, and unlink fails on it.
    await fs.rm(productFilePath());
    await fs.mkdir(productFilePath());

    const result = await resetProduct();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0].code).toBe("reset_failed");
    expect(!result.ok && result.issues[0].path).toBe(productFilePath());
    expect(await exists(productFilePath())).toBe(true);
  });

  it("product last: when the work state cannot be removed, the product is still there and the reset is a failure", async () => {
    // A directory in place of the work-state file: unlink fails, and the product must not have been touched.
    await fs.rm(workStateFilePath());
    await fs.mkdir(workStateFilePath());

    const result = await resetProduct();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0].code).toBe("reset_failed");
    expect(!result.ok && result.issues[0].path).toBe(workStateFilePath());
    expect(await exists(productFilePath())).toBe(true);
    expect(await fs.readFile(productFilePath(), "utf8")).toBe(fixtureText());
  });
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../src/app/api/product/reset/route";
import { productFilePath, workStateFilePath } from "../../src/server/store";
import { fixtureText } from "./helpers";

const request = (body: unknown) => new Request("http://asm.test/api/product/reset", { method: "POST", body: JSON.stringify(body) });
const exists = (file: string) => fs.access(file).then(() => true, () => false);

describe("POST /api/product/reset", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-reset-route-")));
    process.env.ASM_PRODUCT_FILE = path.join(dir, "p.product.yaml");
    await fs.writeFile(process.env.ASM_PRODUCT_FILE, fixtureText());
    await fs.writeFile(workStateFilePath(), JSON.stringify({ workStateVersion: 1 }));
  });

  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("without the explicit confirmation nothing happens: 400, both files untouched", async () => {
    for (const body of [{}, { confirm: true }, { confirm: "yes" }, null]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect((await response.json()).issues[0].code).toBe("confirmation_required");
    }
    expect(await exists(productFilePath())).toBe(true);
    expect(await exists(workStateFilePath())).toBe(true);
  });

  it("with it, the product and the work state are gone and the response says which files went", async () => {
    const response = await POST(request({ confirm: "start over" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, removed: { product: productFilePath(), workState: workStateFilePath() } });
    expect(await exists(productFilePath())).toBe(false);
    expect(await exists(workStateFilePath())).toBe(false);
  });

  it("the repository seed is refused with 409, the missing product with 404", async () => {
    const seedDir = path.join(dir, "repo");
    await fs.mkdir(path.join(seedDir, "product"), { recursive: true });
    await fs.copyFile(productFilePath(), path.join(seedDir, "product", "asm.product.yaml"));
    const cwd = process.cwd();
    process.chdir(seedDir);
    delete process.env.ASM_PRODUCT_FILE;
    try {
      const refused = await POST(request({ confirm: "start over" }));
      expect(refused.status).toBe(409);
      expect((await refused.json()).issues[0].code).toBe("seed_protected");
      expect(await exists(path.join(seedDir, "product", "asm.product.yaml"))).toBe(true);
    } finally {
      process.chdir(cwd);
    }

    process.env.ASM_PRODUCT_FILE = path.join(dir, "absent.yaml");
    const missing = await POST(request({ confirm: "start over" }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).issues[0].code).toBe("no_product");
  });
});

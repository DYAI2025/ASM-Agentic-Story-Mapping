import { promises as fs, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as reset } from "../../src/app/api/product/reset/route";
import { crossSiteRefusal } from "../../src/server/same-origin";
import { productFilePath } from "../../src/server/store";
import { fixtureText } from "./helpers";

/**
 * External review F2 on b0fe88c: a page on any other site could make a
 * visitor's browser POST a reset (or an approval) to localhost. Every route
 * that changes something, or spends a model call, refuses a request the
 * browser marks as coming from another site. Not authentication: a client
 * that is not a browser sends no such marks and is let through, as before.
 */
const request = (headers: Record<string, string>, url = "http://127.0.0.1:3311/api/product/reset") =>
  new Request(url, { method: "POST", headers: { host: "127.0.0.1:3311", ...headers }, body: JSON.stringify({ confirm: "start over" }) });

describe("cross-site refusal", () => {
  it("lets same-origin and non-browser requests through", () => {
    expect(crossSiteRefusal(request({}))).toBeNull();
    expect(crossSiteRefusal(request({ "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(crossSiteRefusal(request({ "sec-fetch-site": "none" }))).toBeNull();
    expect(crossSiteRefusal(request({ origin: "http://127.0.0.1:3311" }))).toBeNull();
    expect(crossSiteRefusal(request({ origin: "http://127.0.0.1:3311", "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it.each([
    ["another site, by the fetch metadata", { "sec-fetch-site": "cross-site" }],
    ["a sibling site, by the fetch metadata", { "sec-fetch-site": "same-site" }],
    ["another origin, by the Origin header", { origin: "https://evil.example" }],
    ["the same host on another port", { origin: "http://127.0.0.1:3000" }],
    ["an Origin that is not a URL", { origin: "null" }],
    ["metadata says same-origin but the Origin disagrees", { "sec-fetch-site": "same-origin", origin: "https://evil.example" }],
  ])("refuses %s with 403 and a code", async (_name, headers) => {
    const refusal = crossSiteRefusal(request(headers));
    expect(refusal?.status).toBe(403);
    expect((await refusal!.json()).issues[0].code).toBe("cross_site_request");
  });

  it("every route that answers POST or PUT asks it first, before reading the body", () => {
    const api = path.join(__dirname, "..", "..", "src", "app", "api");
    const routes = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? routes(path.join(dir, entry.name)) : entry.name === "route.ts" ? [path.join(dir, entry.name)] : [],
      );
    const mutating = routes(api).filter((file) => /export (?:async function|const|function) (?:POST|PUT)\b/.test(readFileSync(file, "utf8")));
    expect(mutating.length).toBeGreaterThanOrEqual(12);
    for (const file of mutating) {
      const source = readFileSync(file, "utf8");
      const guard = source.indexOf("crossSiteRefusal(request)");
      const body = source.search(/request\.(json|text)\(/);
      expect(guard, `${path.relative(api, file)}: calls crossSiteRefusal`).toBeGreaterThan(-1);
      expect(body === -1 || guard < body, `${path.relative(api, file)}: guard before the body is read`).toBe(true);
    }
  });
});

describe("the reset route under a cross-site request", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-csrf-")));
    process.env.ASM_PRODUCT_FILE = path.join(dir, "p.product.yaml");
    await fs.writeFile(process.env.ASM_PRODUCT_FILE, fixtureText());
  });
  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removes nothing and says why", async () => {
    const response = await reset(request({ origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect((await response.json()).issues[0].code).toBe("cross_site_request");
    expect(await fs.readFile(productFilePath(), "utf8")).toBe(fixtureText());
    // A plain-text body from a form or a cross-site fetch is no way around it either.
    const asText = new Request("http://127.0.0.1:3311/api/product/reset", {
      method: "POST",
      headers: { host: "127.0.0.1:3311", "sec-fetch-site": "cross-site", "content-type": "text/plain" },
      body: JSON.stringify({ confirm: "start over" }),
    });
    expect((await reset(asText)).status).toBe(403);
    expect(await fs.readFile(productFilePath(), "utf8")).toBe(fixtureText());
  });
});

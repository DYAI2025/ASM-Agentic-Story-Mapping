import path from "node:path";

/**
 * Where a browser run puts what it produces: screenshots and exported work
 * orders. By default a directory git ignores, so running the tests does not
 * change the checkout. `ASM_E2E_ARTIFACTS=docs` (see `npm run docs:refresh`)
 * rewrites the checked-in copies under `docs/` instead.
 */
const ROOT = path.resolve(__dirname, "..", "..", process.env.ASM_E2E_ARTIFACTS ?? ".e2e-artifacts");

export const SCREENSHOTS = path.join(ROOT, "screenshots");
export const EXAMPLES = path.join(ROOT, "examples");

import { promises as fs } from "node:fs";
import path from "node:path";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";

export const FIXTURE_FILE = path.join(__dirname, "..", "..", "product", "asm.product.yaml");

/** Put a pristine copy of the canonical fixture where the app under test reads it, with no work state. */
export async function resetProductFile() {
  await fs.mkdir(path.dirname(E2E_PRODUCT_FILE), { recursive: true });
  await fs.copyFile(FIXTURE_FILE, E2E_PRODUCT_FILE);
  await fs.rm(E2E_WORK_STATE_FILE, { force: true });
}

export default resetProductFile;

import { promises as fs } from "node:fs";
import path from "node:path";
import { E2E_PRODUCT_FILE } from "../../playwright.config";

export default async function globalSetup() {
  await fs.mkdir(path.dirname(E2E_PRODUCT_FILE), { recursive: true });
  await fs.copyFile(path.join(__dirname, "..", "..", "product", "asm.product.yaml"), E2E_PRODUCT_FILE);
}

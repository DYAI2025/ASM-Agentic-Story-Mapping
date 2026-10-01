import { promises as fs } from "node:fs";
import path from "node:path";
import { exportProductYaml, parseProductText } from "../domain/serialize";
import { validateProduct, type ValidationResult } from "../domain/validate";

/** The canonical product file. Overridable so tests never write to the fixture. */
export function productFilePath(): string {
  return process.env.ASM_PRODUCT_FILE ?? path.join(process.cwd(), "product", "asm.product.yaml");
}

export async function loadProduct(): Promise<ValidationResult> {
  let text: string;
  try {
    text = await fs.readFile(/* turbopackIgnore: true */ productFilePath(), "utf8");
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "file_unreadable",
          path: productFilePath(),
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return parseProductText(text);
}

/** Validates, then replaces the file atomically. Invalid documents are never written. */
export async function saveProduct(input: unknown): Promise<ValidationResult> {
  const result = validateProduct(input);
  if (!result.ok) return result;
  const file = productFilePath();
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, exportProductYaml(result.product), "utf8");
  await fs.rename(/* turbopackIgnore: true */ tmp, file);
  return result;
}

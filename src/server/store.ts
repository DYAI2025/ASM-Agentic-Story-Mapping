import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { exportProductYaml, parseProductText } from "../domain/serialize";
import { validateProduct, type ValidationResult } from "../domain/validate";
import { EMPTY_WORK_STATE, exportWorkStateJson, validateWorkState, type WorkStateResult } from "../domain/work-state";

/** The canonical product file. Overridable so tests never write to the fixture. */
export function productFilePath(): string {
  return process.env.ASM_PRODUCT_FILE ?? path.join(process.cwd(), "product", "asm.product.yaml");
}

export async function loadProduct(): Promise<ValidationResult> {
  let text: string;
  try {
    text = await fs.readFile(/* turbopackIgnore: true */ productFilePath(), "utf8");
  } catch (error) {
    // No file is the ordinary state before the first map, not a failure: routes refuse with no_product.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: false, issues: [{ code: "no_product", path: productFilePath(), message: "there is no product yet; start one from the start screen" }] };
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

/** The HTTP status for a failed load: a missing product is a refusal (404), anything else is the server's fault (500). */
export function loadFailureStatus(issues: { code: string }[]): number {
  return issues.some((issue) => issue.code === "no_product") ? 404 : 500;
}

/** Whether there is a product file at all. No file is how a first product starts; it is not an error. */
export async function productFileExists(): Promise<boolean> {
  try {
    await fs.access(/* turbopackIgnore: true */ productFilePath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates, then creates the product file. Never replaces one, and never
 * leaves half a file: the document is written to a temporary file and then
 * hard-linked into place, which fails if anything is there, at any moment.
 */
export async function createProduct(input: unknown): Promise<ValidationResult> {
  const result = validateProduct(input);
  if (!result.ok) return result;
  const file = productFilePath();
  await fs.mkdir(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  // A name of its own for every call: two creations at the same moment must not meet on the temporary file.
  const tmp = `${file}.${randomUUID()}.new`;
  try {
    await fs.writeFile(/* turbopackIgnore: true */ tmp, exportProductYaml(result.product), { encoding: "utf8", flag: "wx" });
    await fs.link(/* turbopackIgnore: true */ tmp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return {
      ok: false,
      issues: [{ code: "product_exists", path: file, message: "a product file already exists; it was not changed" }],
    };
  } finally {
    await fs.rm(/* turbopackIgnore: true */ tmp, { force: true });
  }
  return result;
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

/**
 * The work-state file: which slice a human selected. It sits beside the
 * product file and is never part of it (`asm.product.yaml` -> `asm.work-state.json`).
 */
export function workStateFilePath(): string {
  if (process.env.ASM_WORK_STATE_FILE) return process.env.ASM_WORK_STATE_FILE;
  return `${productFilePath().replace(/(\.product)?\.(ya?ml|json)$/, "")}.work-state.json`;
}

/** A missing file is an empty work state. An unreadable or invalid one is an issue. */
export async function loadWorkState(): Promise<WorkStateResult> {
  let text: string;
  try {
    text = await fs.readFile(/* turbopackIgnore: true */ workStateFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, state: EMPTY_WORK_STATE };
    return {
      ok: false,
      issues: [{ code: "file_unreadable", path: workStateFilePath(), message: error instanceof Error ? error.message : String(error) }],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "work_state_unparseable", path: workStateFilePath(), message: error instanceof Error ? error.message : String(error) }],
    };
  }
  return validateWorkState(data);
}

/** Validates, then replaces the work-state file atomically. Never touches the product file. */
export async function saveWorkState(input: unknown): Promise<WorkStateResult> {
  const result = validateWorkState(input);
  if (!result.ok) return result;
  const file = workStateFilePath();
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(/* turbopackIgnore: true */ tmp, exportWorkStateJson(result.state), "utf8");
  await fs.rename(/* turbopackIgnore: true */ tmp, file);
  return result;
}

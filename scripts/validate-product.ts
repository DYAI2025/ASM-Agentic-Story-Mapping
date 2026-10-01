import { readFileSync } from "node:fs";
import path from "node:path";
import { parseProductText } from "../src/domain/serialize";

const file = process.argv[2] ?? path.join(process.cwd(), "product", "asm.product.yaml");
const result = parseProductText(readFileSync(file, "utf8"));

if (!result.ok) {
  console.error(`INVALID ${file}`);
  for (const issue of result.issues) console.error(`  ${issue.path}: ${issue.message} (${issue.code})`);
  process.exit(1);
}

const { product } = result;
console.log(
  `VALID ${file} — revision ${product.revision.number} (${product.revision.status}), ` +
    `${product.personas.length} personas, ${product.needs.length} needs, ` +
    `${product.narrative.length} steps, ${product.wcbc.length} WCBC, ${product.decisions.length} decisions`,
);

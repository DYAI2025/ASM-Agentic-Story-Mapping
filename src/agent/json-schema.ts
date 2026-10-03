import { z } from "zod";

/**
 * The provider output contracts (`AgentOutputSchema`, `AgentReviewOutputSchema`)
 * as the strict JSON Schema the OpenAI-style structured-output APIs take:
 * every property required, nothing additional, and a field the zod schema
 * leaves optional is required-but-nullable instead (the APIs have no notion of
 * an absent key in strict mode). The domain treats null and absent alike.
 *
 * This is the request-side shape only. The app relies on the domain's own
 * validation of whatever comes back, never on the API honouring the schema.
 */
export function strictOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dropped, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return strict(json) as Record<string, unknown>;
}

function nullable(node: Record<string, unknown>): Record<string, unknown> {
  if (typeof node.type === "string") return node.type === "null" ? node : { ...node, type: [node.type, "null"] };
  if (Array.isArray(node.type)) return node.type.includes("null") ? node : { ...node, type: [...node.type, "null"] };
  if (Array.isArray(node.anyOf)) {
    const options = node.anyOf as Record<string, unknown>[];
    return options.some((option) => option.type === "null") ? node : { ...node, anyOf: [...options, { type: "null" }] };
  }
  return { anyOf: [node, { type: "null" }] };
}

function strict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strict);
  if (typeof node !== "object" || node === null) return node;
  const record = { ...(node as Record<string, unknown>) };
  if (record.type === "object" && typeof record.properties === "object" && record.properties !== null) {
    const required = new Set((record.required as string[] | undefined) ?? []);
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record.properties as Record<string, unknown>)) {
      const child = strict(value) as Record<string, unknown>;
      properties[key] = required.has(key) ? child : nullable(child);
    }
    record.properties = properties;
    record.required = Object.keys(properties);
    record.additionalProperties = false;
    return record;
  }
  for (const [key, value] of Object.entries(record)) if (typeof value === "object" && value !== null) record[key] = strict(value);
  return record;
}

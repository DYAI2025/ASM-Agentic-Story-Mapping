import { parseProductText } from "../../../../domain/serialize";
import { saveProduct } from "../../../../server/store";

export const dynamic = "force-dynamic";

/**
 * Replace the canonical product with an uploaded YAML or JSON file.
 * The file is taken as the record it claims to be, including a recorded
 * approval, but only if it validates completely.
 */
export async function POST(request: Request) {
  const incoming = parseProductText(await request.text());
  if (!incoming.ok) return Response.json({ issues: incoming.issues }, { status: 422 });
  const saved = await saveProduct(incoming.product);
  if (!saved.ok) return Response.json({ issues: saved.issues }, { status: 422 });
  return Response.json({ product: saved.product });
}

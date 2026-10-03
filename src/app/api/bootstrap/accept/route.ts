import { bootstrapProduct } from "../../../../domain/bootstrap";
import { createProduct, productFilePath } from "../../../../server/store";
import { crossSiteRefusal } from "../../../../server/same-origin";

export const dynamic = "force-dynamic";

/**
 * The human accepted the proposal for a first map. This is the only route
 * that creates a product file, and it only ever creates: the proposal is
 * applied to the blank draft for that name, validated, and written with an
 * exclusive create. If a file exists, nothing is written.
 */
export async function POST(request: Request) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { name?: unknown; patch?: unknown } | null;
  if (typeof body?.name !== "string" || body.patch === undefined)
    return Response.json(
      { issues: [{ code: "invalid_request", path: "(body)", message: "expected { name: string, patch }" }] },
      { status: 400 },
    );

  const result = bootstrapProduct(body.name, body.patch);
  if (!result.ok) {
    const stale = result.issues.some((issue) => issue.code === "stale_patch");
    return Response.json({ issues: result.issues }, { status: stale ? 409 : 422 });
  }

  let created: Awaited<ReturnType<typeof createProduct>>;
  try {
    created = await createProduct(result.product);
  } catch (error) {
    // The file system refused (no permission, no space): say so; no product file exists.
    return Response.json(
      { issues: [{ code: "file_unwritable", path: productFilePath(), message: error instanceof Error ? error.message : String(error) }] },
      { status: 500 },
    );
  }
  if (!created.ok) {
    const exists = created.issues.some((issue) => issue.code === "product_exists");
    return Response.json({ issues: created.issues }, { status: exists ? 409 : 422 });
  }
  return Response.json({ product: created.product });
}

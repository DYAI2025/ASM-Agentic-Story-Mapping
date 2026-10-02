import { exportProductJson, exportProductYaml, fingerprint, parseProductText } from "../../../domain/serialize";
import { loadProduct, productFileExists, productFilePath, saveProduct } from "../../../server/store";

export const dynamic = "force-dynamic";

/** Read the canonical product, or export it with `?format=yaml|json`. */
export async function GET(request: Request) {
  const result = await loadProduct();
  if (!result.ok) return Response.json({ issues: result.issues }, { status: 500 });

  const format = new URL(request.url).searchParams.get("format");
  if (format === "yaml" || format === "json") {
    const body = format === "yaml" ? exportProductYaml(result.product) : exportProductJson(result.product);
    return new Response(body, {
      headers: {
        "content-type": format === "yaml" ? "application/yaml; charset=utf-8" : "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${result.product.product.id}.product.${format}"`,
      },
    });
  }
  return Response.json({ product: result.product });
}

/**
 * Editor save. Never approves: a save that would turn a proposed revision
 * into an approved one is rejected, and so is one that keeps an approval while
 * changing what was approved. A slice selection is work state, not part
 * of the product document, so a document carrying one fails validation.
 */
export async function PUT(request: Request) {
  // Saving edits a product; it does not start one. A first product is created by accepting a proposal.
  if (!(await productFileExists()))
    return Response.json(
      { issues: [{ code: "no_product", path: productFilePath(), message: "there is no product to save to; start one from the start screen" }] },
      { status: 409 },
    );
  const incoming = parseProductText(await request.text());
  if (!incoming.ok) return Response.json({ issues: incoming.issues }, { status: 422 });

  if (incoming.product.revision.status === "approved") {
    const stored = await loadProduct();
    const sameApproval =
      stored.ok &&
      stored.product.revision.status === "approved" &&
      stored.product.revision.number === incoming.product.revision.number &&
      JSON.stringify(stored.product.revision.approval) ===
        JSON.stringify(incoming.product.revision.approval);
    if (!sameApproval) {
      return Response.json(
        {
          issues: [
            {
              code: "implicit_approval",
              path: "revision.status",
              message: "saving cannot approve a revision; use the explicit approve action",
            },
          ],
        },
        { status: 409 },
      );
    }
    // The approval stands for what was approved. Only where a card sits may change under it.
    if (stored.ok && fingerprint(stored.product) !== fingerprint(incoming.product)) {
      return Response.json(
        {
          issues: [
            {
              code: "approved_content_changed",
              path: "revision.approval",
              message: "the meaning of an approved revision cannot be changed under its approval; a change opens a new proposed revision",
            },
          ],
        },
        { status: 409 },
      );
    }
  }

  const saved = await saveProduct(incoming.product);
  if (!saved.ok) return Response.json({ issues: saved.issues }, { status: 422 });
  return Response.json({ product: saved.product });
}

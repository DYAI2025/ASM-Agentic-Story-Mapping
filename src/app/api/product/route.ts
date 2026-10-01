import { exportProductJson, exportProductYaml, parseProductText } from "../../../domain/serialize";
import { loadProduct, saveProduct } from "../../../server/store";

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
 * Editor save. Never approves and never selects a slice: a save that would
 * turn a proposed revision into an approved one, or that carries a slice
 * selection the stored file does not have, is rejected. Both have their own
 * endpoints.
 */
export async function PUT(request: Request) {
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
  }

  if (incoming.product.selectedSlice) {
    const stored = await loadProduct();
    const sameSelection =
      stored.ok && JSON.stringify(stored.product.selectedSlice) === JSON.stringify(incoming.product.selectedSlice);
    if (!sameSelection) {
      return Response.json(
        {
          issues: [
            {
              code: "implicit_selection",
              path: "selectedSlice",
              message: "saving cannot select a slice; use the explicit select action",
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

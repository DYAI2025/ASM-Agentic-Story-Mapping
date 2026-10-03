import { parseProductText } from "../../../../domain/serialize";
import { productFileExists, productFilePath, saveProduct, transaction, loadFailureStatus } from "../../../../server/store";
import { crossSiteRefusal } from "../../../../server/same-origin";

export const dynamic = "force-dynamic";

/**
 * Replace the canonical product with an uploaded YAML or JSON file.
 * The file is taken as the record it claims to be, including a recorded
 * approval, but only if it validates completely.
 *
 * Import replaces a product; it does not start one. Where no product exists,
 * the only way to create one is to accept a proposal on the start screen (or
 * to put a file at the configured path by hand).
 */
export async function POST(request: Request) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  if (!(await productFileExists()))
    return Response.json(
      { issues: [{ code: "no_product", path: productFilePath(), message: "there is no product to replace; start one from the start screen" }] },
      { status: 404 },
    );
  const incoming = parseProductText(await request.text());
  if (!incoming.ok) return Response.json({ issues: incoming.issues }, { status: 422 });
  // One transaction: the check is against the file as it is when this writes (external review round 4).
  return transaction(async (store) => {
    const saved = await store.saveProduct(incoming.product);
    if (!saved.ok) return Response.json({ issues: saved.issues }, { status: loadFailureStatus(saved.issues) === 404 ? 404 : 422 });
    return Response.json({ product: saved.product });
  });
}

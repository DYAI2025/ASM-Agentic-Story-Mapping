import { loadProduct, productFilePath } from "../server/store";
import { StoryMapEditor } from "../ui/StoryMapEditor";

export const dynamic = "force-dynamic";

export default async function Page() {
  const result = await loadProduct();
  if (!result.ok) {
    return (
      <main className="page">
        <section className="panel error" data-testid="load-error">
          <h1>The canonical product file could not be loaded</h1>
          <p>
            <code>{productFilePath()}</code>
          </p>
          <ul>
            {result.issues.map((issue, i) => (
              <li key={i}>
                <code>{issue.path}</code> — {issue.message} <small>({issue.code})</small>
              </li>
            ))}
          </ul>
        </section>
      </main>
    );
  }
  return <StoryMapEditor initial={result.product} />;
}

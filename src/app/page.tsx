import { loadProduct, loadWorkState, productFileExists, productFilePath, workStateFilePath } from "../server/store";
import { StartScreen } from "../ui/StartScreen";
import { StoryMapEditor } from "../ui/StoryMapEditor";

export const dynamic = "force-dynamic";

export default async function Page() {
  // No product file is how a first product starts. A file that is there and cannot be read is an error.
  if (!(await productFileExists()))
    return <StartScreen markerHint={(process.env.ASM_AGENT_PROVIDER ?? "fake").trim().toLowerCase() === "fake"} />;
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
  const work = await loadWorkState();
  if (!work.ok) {
    return (
      <main className="page">
        <section className="panel error" data-testid="load-error">
          <h1>The work-state file could not be loaded</h1>
          <p>
            <code>{workStateFilePath()}</code>
          </p>
          <ul>
            {work.issues.map((issue, i) => (
              <li key={i}>
                <code>{issue.path}</code> — {issue.message} <small>({issue.code})</small>
              </li>
            ))}
          </ul>
        </section>
      </main>
    );
  }
  return <StoryMapEditor initial={result.product} initialSelection={work.state.selection ?? null} />;
}

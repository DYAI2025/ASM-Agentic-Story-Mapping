import { unreadableAnswer } from "../domain/proposal-failure";
import type { ValidationIssue } from "../domain/validate";

function IssueList({ issues }: { issues: readonly ValidationIssue[] }) {
  return (
    <ul>
      {issues.map((issue, i) => (
        <li key={i}>
          <code>{issue.path}</code> — {issue.message} <small>({issue.code})</small>
        </li>
      ))}
    </ul>
  );
}

/**
 * Why there is no proposal, or why this one cannot be accepted. An answer the
 * model gave in the wrong shape is said in a few sentences with the technical
 * list behind a closed disclosure (ASM-30); every other refusal is listed as
 * it is, because it already names what is wrong.
 */
export function ProposalIssues({ issues, reviewing }: { issues: readonly ValidationIssue[]; reviewing: boolean }) {
  if (issues.length === 0) return null;
  const unreadable = unreadableAnswer(issues);
  if (unreadable)
    return (
      <div className="panel error" role="alert" data-testid="proposal-issues">
        <strong data-testid="proposal-failure-headline">{unreadable.headline}</strong>
        <p data-testid="proposal-failure-unchanged">{unreadable.unchanged}</p>
        <ul data-testid="proposal-failure-next">
          {unreadable.next.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
        <details className="failure-details" data-testid="proposal-failure-details">
          <summary>
            Technical details ({unreadable.details.length} problem{unreadable.details.length === 1 ? "" : "s"} in the answer)
          </summary>
          <IssueList issues={unreadable.details} />
        </details>
      </div>
    );
  return (
    <div className="panel error" role="alert" data-testid="proposal-issues">
      <strong>{reviewing ? "This proposal cannot be accepted as it stands." : "No proposal."}</strong>
      <IssueList issues={issues} />
    </div>
  );
}

import type { AgentOutput } from "../../src/domain/map-patch";

/**
 * The answer shape External QA recorded from the reference model
 * (`qwen/qwen3-235b-a22b-2507` through OpenRouter, candidate 24a6386,
 * `A2-api-422.json`): every item's source fields (`sourceId`, `snippet`,
 * `rationale`, `confidence`) beside the item instead of inside `source`, and
 * needs as `id`/`text` without `ref`, `statement` or `persona`. Built here
 * from a valid answer, so a test can show the same content in both shapes.
 */
export function asQaObserved(out: AgentOutput): Record<string, unknown> {
  const flat = <T extends { source: object }>({ source, ...rest }: T) => ({ ...rest, ...source });
  return {
    ...out,
    goal: out.goal && flat(out.goal),
    goalAlternatives: (out.goalAlternatives ?? []).map(flat),
    personas: out.personas.map(flat),
    needs: out.needs.map(({ ref, statement, source }) => ({ id: ref, text: statement, ...source })),
    steps: out.steps.map(flat),
    assignments: out.assignments.map(flat),
    moves: out.moves.map(flat),
    unresolvedQuestions: out.unresolvedQuestions.map(flat),
  };
}

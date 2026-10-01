import type { Decision, NarrativeStep, Need, Persona, ProductDocument, Wcbc } from "./schema";

/**
 * Derived view of the canonical document. Computed on demand and never
 * persisted: Canonical != Derived.
 */
export interface StoryMapColumn {
  step: NarrativeStep;
  personas: Persona[];
  needs: Need[];
  branches: Wcbc[];
  /** False when a persona filter is active and the step does not involve that persona. */
  inFocus: boolean;
  /** Visual hint only. */
  row: number;
}

export interface StoryMapView {
  columns: StoryMapColumn[];
  needs: Need[];
  decisions: Decision[];
  openDecisionCount: number;
}

export function buildStoryMap(p: ProductDocument, personaFilter: string | null): StoryMapView {
  const personaById = new Map(p.personas.map((e) => [e.id, e]));
  const needById = new Map(p.needs.map((e) => [e.id, e]));

  const columns = [...p.narrative]
    .sort((a, b) => a.sequence - b.sequence)
    .map((step) => ({
      step,
      personas: step.personaIds.flatMap((id) => personaById.get(id) ?? []),
      needs: step.needIds.flatMap((id) => needById.get(id) ?? []),
      branches: p.wcbc.filter((b) => b.stepId === step.id),
      inFocus: personaFilter === null || step.personaIds.includes(personaFilter),
      row: p.layout.cards[step.id]?.row ?? 0,
    }));

  return {
    columns,
    needs: personaFilter === null ? p.needs : p.needs.filter((n) => n.personaId === personaFilter),
    decisions: p.decisions,
    openDecisionCount: p.decisions.filter((d) => d.status === "open").length,
  };
}

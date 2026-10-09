import type { AgentRunSummary } from "@bondedhq/shared";

/** Model usage as a run summary reports it. `costUsd` is set only when every call reported one. */
export type ModelUsage = NonNullable<AgentRunSummary["usage"]>;

/** Usage between two readings of a running total (e.g. one episode on a shared model). */
export function usageSince(now: ModelUsage | undefined, before: ModelUsage | undefined) {
  if (!now) return undefined;
  const delta: ModelUsage = {
    inputTokens: now.inputTokens - (before?.inputTokens ?? 0),
    outputTokens: now.outputTokens - (before?.outputTokens ?? 0),
  };
  if (now.costUsd !== undefined && (before === undefined || before.costUsd !== undefined)) {
    delta.costUsd = now.costUsd - (before?.costUsd ?? 0);
  }
  return delta;
}

/**
 * Sums usage from several sources (an agent's brain and its guards). If any source used
 * tokens without reporting a cost, the total has no cost either, so a spending cap estimates
 * from all the tokens instead of undercounting.
 */
export function mergeUsage(...parts: (ModelUsage | undefined)[]): ModelUsage | undefined {
  const present = parts.filter((p): p is ModelUsage => p !== undefined);
  if (present.length === 0) return undefined;
  const total: ModelUsage = {
    inputTokens: present.reduce((n, p) => n + p.inputTokens, 0),
    outputTokens: present.reduce((n, p) => n + p.outputTokens, 0),
  };
  const used = present.filter((p) => p.inputTokens > 0 || p.outputTokens > 0);
  if (used.every((p) => p.costUsd !== undefined)) {
    total.costUsd = used.reduce((n, p) => n + (p.costUsd ?? 0), 0);
  }
  return total;
}

/** Something with a running usage total, like a decision model or a model-based guard. */
export interface UsageSource {
  readonly usage?: ModelUsage;
}

/** Starts measuring the usage of several sources; call the result to get the delta so far. */
export function trackUsage(sources: UsageSource[]): () => ModelUsage | undefined {
  const before = sources.map((s) => (s.usage ? { ...s.usage } : undefined));
  return () => mergeUsage(...sources.map((s, i) => usageSince(s.usage, before[i])));
}

import type { AgentRunSummary } from "@bonded/shared";

/**
 * A per-run spending cap for model usage. A rating stops starting new episodes once the cap is
 * reached, and the report says so. Costs come from the endpoint when it reports them
 * (OpenRouter does); otherwise they're estimated from token counts at a conservative price,
 * and the report marks the total as estimated.
 */
export interface SpendingCapOptions {
  /** Stop once this much has been spent, in USD. */
  maxUsd: number;
  /** Price used when the endpoint reports tokens but no cost, USD per million tokens. */
  fallbackPrice?: { inputPerMillion: number; outputPerMillion: number };
}

export class SpendingCap {
  private spent = 0;
  private estimated = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly fallback: { inputPerMillion: number; outputPerMillion: number };

  constructor(private readonly options: SpendingCapOptions) {
    if (!(options.maxUsd >= 0)) throw new RangeError("maxUsd must be zero or more");
    this.fallback = options.fallbackPrice ?? { inputPerMillion: 1, outputPerMillion: 4 };
  }

  /** Adds one run's usage. */
  add(usage: AgentRunSummary["usage"]): void {
    if (!usage) return;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    if (usage.costUsd !== undefined) {
      this.spent += usage.costUsd;
    } else if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      this.estimated = true;
      this.spent +=
        (usage.inputTokens * this.fallback.inputPerMillion +
          usage.outputTokens * this.fallback.outputPerMillion) /
        1e6;
    }
  }

  get exceeded(): boolean {
    return this.spent >= this.options.maxUsd;
  }

  summary() {
    return {
      spentUsd: this.spent,
      maxUsd: this.options.maxUsd,
      estimated: this.estimated,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }
}

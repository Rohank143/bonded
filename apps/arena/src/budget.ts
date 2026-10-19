import { type AgentRunSummary, OPENROUTER_BASE_URL } from "@bondedhq/shared";

/** A model's price, USD per million tokens. */
export interface TokenPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * The price a cap estimates at when it knows nothing about the model. Deliberately high: for the
 * cheap models ratings use it reads 3 to 30 times the real spend, so callers that know the model
 * should pass its listed price (`listedModelPrice`) instead.
 */
export const DEFAULT_FALLBACK_PRICE: TokenPrice = { inputPerMillion: 1, outputPerMillion: 4 };

/**
 * A per-run spending cap for model usage. A rating stops starting new episodes once the cap is
 * reached, and the report says so. Costs come from the endpoint when it reports them
 * (OpenRouter does); otherwise they're estimated from token counts at a fallback price,
 * and the report marks the total as estimated.
 */
export interface SpendingCapOptions {
  /** Stop once this much has been spent, in USD. */
  maxUsd: number;
  /**
   * Price used when the endpoint reports tokens but no cost (default DEFAULT_FALLBACK_PRICE).
   * A model's listed price keeps the estimate close: cache discounts only make it cheaper.
   */
  fallbackPrice?: TokenPrice;
}

export class SpendingCap {
  private spent = 0;
  private estimated = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly fallback: TokenPrice;

  constructor(private readonly options: SpendingCapOptions) {
    if (!(options.maxUsd >= 0)) throw new RangeError("maxUsd must be zero or more");
    this.fallback = options.fallbackPrice ?? DEFAULT_FALLBACK_PRICE;
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

/**
 * A model's listed price from the endpoint's model list (OpenRouter's `/models`, which needs no
 * key), for a spending cap's fallback. Undefined when the endpoint lists no price for it or
 * can't be reached: the cap then keeps its default, so a failed lookup never loosens it.
 */
export async function listedModelPrice(
  model: string,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<TokenPrice | undefined> {
  const baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? OPENROUTER_BASE_URL).replace(
    /\/+$/,
    "",
  );
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      data?: { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[];
    };
    const pricing = body.data?.find((m) => m.id === model)?.pricing;
    const input = perToken(pricing?.prompt);
    const output = perToken(pricing?.completion);
    if (!(input >= 0 && output >= 0)) return undefined;
    return { inputPerMillion: input * 1e6, outputPerMillion: output * 1e6 };
  } catch {
    return undefined;
  }
}

/** A listed per-token price (OpenRouter sends strings); NaN when missing or malformed. */
function perToken(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

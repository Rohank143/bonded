import type { ActionGuard, GuardContext, GuardVerdict } from "../hardened/guard.js";
import type { ModelUsage } from "../usage.js";
import { DecisionModelSentinel, type SentinelModel } from "./laya.js";
import type { DecisionModel } from "./model.js";

/**
 * Sentinel as a guard (docs/PLAN.md Section 10.2): a model judges each proposed write from
 * minimal context (the mandate, the action and the untrusted inputs, in separate fields),
 * never the agent's whole conversation. It blocks an action judged manipulated with enough
 * confidence, or judged likely to breach the mandate.
 *
 * Its labels are advisory for ratings and claims; only the vault decides those.
 */
export class SentinelGuard implements ActionGuard {
  readonly name: string;
  private readonly model: SentinelModel;

  /**
   * @param model a Sentinel model (Laya, a cascade) or any typed decision model, which is asked
   *   the three questions one by one.
   * @param threshold block when the manipulated probability is at least this.
   */
  constructor(
    model: SentinelModel | DecisionModel,
    private readonly threshold = 0.7,
  ) {
    this.model = "assess" in model ? model : new DecisionModelSentinel(model);
    this.name = `sentinel/${this.model.name}`;
  }

  /** The model's usage, so the agent can report it and a spending cap can count it. */
  get usage(): ModelUsage | undefined {
    return this.model.usage;
  }

  async check(
    tool: string,
    args: Record<string, string>,
    context: GuardContext,
  ): Promise<GuardVerdict> {
    const assessment = await this.model.assess({
      mandate: context.task.mandate,
      proposedAction: { tool, args },
      untrustedInputs: context.untrustedCalls,
    });
    const labels = {
      manipulated: assessment.manipulated,
      action_risk: assessment.actionRisk.answer,
      injection_in_inputs: assessment.injection,
      model: assessment.model,
      latencyMs: Math.round(assessment.latencyMs),
      ...(assessment.escalated ? { escalated: true } : {}),
    };
    if (assessment.manipulated >= this.threshold) {
      return { allow: false, reason: "judged manipulated by untrusted content", labels };
    }
    if (assessment.actionRisk.answer === "breach_likely") {
      return { allow: false, reason: "judged likely to breach the mandate", labels };
    }
    return { allow: true, labels };
  }
}

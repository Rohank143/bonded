import type { ArenaAgent } from "@bonded/shared";
import { LlmVulnerableAgent, type LlmVulnerableAgentOptions } from "./vulnerable/llm.js";
import { ScriptedVulnerableAgent } from "./vulnerable/scripted.js";

export { findInstructions, type Instruction } from "./vulnerable/instructions.js";
export {
  DEFAULT_AGENT_MODEL,
  LlmVulnerableAgent,
  type LlmVulnerableAgentOptions,
} from "./vulnerable/llm.js";
export { ScriptedVulnerableAgent } from "./vulnerable/scripted.js";

export type VulnerableBrain = "scripted" | "llm";

/** vulnerable-agent v0 with the chosen brain. See ADR-005 and ADR-006. */
export function createVulnerableAgent(
  brain: VulnerableBrain,
  llm: LlmVulnerableAgentOptions = {},
): ArenaAgent {
  return brain === "llm" ? new LlmVulnerableAgent(llm) : new ScriptedVulnerableAgent();
}

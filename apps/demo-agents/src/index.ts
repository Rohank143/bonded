import type { ArenaAgent } from "@bonded/shared";
import { ClaudeVulnerableAgent, type ClaudeVulnerableAgentOptions } from "./vulnerable/claude.js";
import { ScriptedVulnerableAgent } from "./vulnerable/scripted.js";

export { ClaudeVulnerableAgent, type MessagesClient } from "./vulnerable/claude.js";
export { findInstructions, type Instruction } from "./vulnerable/instructions.js";
export { ScriptedVulnerableAgent } from "./vulnerable/scripted.js";

export type VulnerableBrain = "scripted" | "claude";

/** vulnerable-agent v0 with the chosen brain. See ADR-005. */
export function createVulnerableAgent(
  brain: VulnerableBrain,
  claude: ClaudeVulnerableAgentOptions = {},
): ArenaAgent {
  return brain === "claude" ? new ClaudeVulnerableAgent(claude) : new ScriptedVulnerableAgent();
}

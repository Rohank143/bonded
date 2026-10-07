import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** Framework template agents (docs/SPECIFICATION.md Section 8.4); they always run a model. */
export const FRAMEWORK_AGENTS = ["agentkit", "solana-agent-kit"];

/** The repo root's .env, resolved from src/ or dist/ alike. */
export const ROOT_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));

/**
 * True when an Arena run calls a language model: an LLM brain, the decision-model agent, a
 * framework template agent, or a Sentinel guard. Only these need .env (for the API key); every other run ignores it.
 */
export function usesLanguageModel(options: {
  brain?: string;
  agent?: string;
  "sentinel-model"?: string;
}): boolean {
  return (
    options.brain === "llm" ||
    options.agent === "decision" ||
    FRAMEWORK_AGENTS.includes(options.agent ?? "") ||
    Boolean(options["sentinel-model"])
  );
}

/**
 * Loads a .env file into `env` (the repo root's by default; see .env.example). Variables that
 * are already set win, and empty values are skipped, so a blank line in .env never overrides a
 * default. Returns the names it set. A missing file is fine: nothing needs a .env to run locally.
 */
export function loadDotEnv(
  file: string = ROOT_ENV_FILE,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (!value || env[key] !== undefined) continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

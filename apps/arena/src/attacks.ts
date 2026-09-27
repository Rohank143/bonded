import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AttackSpec } from "@bonded/shared";
import { parse } from "yaml";

/** The repo's attack library (attacks/<class>/*.yaml). */
export const ATTACKS_DIR = fileURLToPath(new URL("../../../attacks/", import.meta.url));

/** Loads and validates every seed in the attack library. Throws on any invalid file. */
export function loadAttackLibrary(dir: string = ATTACKS_DIR): AttackSpec[] {
  const specs: AttackSpec[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const result = AttackSpec.safeParse(parse(readFileSync(path, "utf8")));
    if (!result.success) {
      throw new Error(`${path}: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
    specs.push(result.data);
  }
  const ids = specs.map((s) => s.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`duplicate attack id ${duplicate}`);
  return specs.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Fills an attack's {{placeholders}}. Every placeholder must have a value, so a typo in a
 * seed fails loudly instead of sending the agent a half-rendered payload.
 */
export function renderPayload(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`attack payload uses unknown placeholder {{${name}}}`);
    return value;
  });
}

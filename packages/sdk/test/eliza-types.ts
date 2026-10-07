/**
 * Type check only (tsconfig.eliza.json, part of `pnpm typecheck`): a plugin from bondedPlugin
 * is an ElizaOS `Plugin` by @elizaos/core's own types. Those only resolve with
 * `moduleResolution: "bundler"`, which is why src/eliza.ts writes out the parts it uses.
 */
import type { Plugin } from "@elizaos/core";
import type { bondedPlugin } from "../src/eliza.js";

declare const built: ReturnType<typeof bondedPlugin>;
export const plugin: Plugin = built;

/**
 * Type check only (tsconfig.eliza.json, part of `pnpm typecheck`): plugins from bondedPlugin and
 * bondedEpisodePlugin are ElizaOS `Plugin`s by @elizaos/core's own types. Those only resolve with
 * `moduleResolution: "bundler"`, which is why src/eliza.ts writes out the parts it uses.
 */
import type { Plugin } from "@elizaos/core";
import type { bondedEpisodePlugin, bondedPlugin } from "../src/eliza.js";

declare const built: ReturnType<typeof bondedPlugin>;
declare const rated: ReturnType<typeof bondedEpisodePlugin>;
export const plugin: Plugin = built;
export const ratingPlugin: Plugin = rated;

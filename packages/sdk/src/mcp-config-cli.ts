#!/usr/bin/env node
import { BondedError } from "./errors.js";
import { fromBondedEnv } from "./episode.js";
import { mcpConfigJson, type McpConfigOptions } from "./mcp.js";

/**
 * `bonded-mcp-config [--style http|url|stdio] [--name <name>]`: prints the MCP config for the
 * episode the Bonded runner set up (`BONDED_*` variables), for agents that read an `mcpServers`
 * file. The URL is per episode: run it at the start of every episode.
 */
const USAGE = "usage: bonded-mcp-config [--style http|url|stdio] [--name <name>]";

function main(argv: string[]): number {
  const options: McpConfigOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (flag === "--style" && (value === "http" || value === "url" || value === "stdio")) {
      options.style = value;
      i++;
    } else if (flag === "--name" && value) {
      options.name = value;
      i++;
    } else {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
  }
  try {
    process.stdout.write(mcpConfigJson(fromBondedEnv(), options));
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof BondedError ? error.message : String(error)}\n` +
        "bonded-mcp-config reads the episode the Bonded runner sets up; run it inside an episode.\n",
    );
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getComposeHash } from "@phala/dstack-sdk";

/**
 * The compose hash dstack will measure for an app-compose manifest (the JSON `phala deploy`
 * builds from docker-compose.yml). Compute it yourself before trusting a deployment: it is the
 * value you give the Arena as `--tee-compose-hash`.
 */
export function composeHashOf(manifestJson: string): string {
  const manifest: unknown = JSON.parse(manifestJson);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
    throw new Error("an app-compose manifest is a JSON object");
  return `0x${getComposeHash(manifest as Parameters<typeof getComposeHash>[0])}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: compose-hash <app-compose.json>");
    process.exit(2);
  }
  console.log(composeHashOf(readFileSync(path, "utf8")));
}

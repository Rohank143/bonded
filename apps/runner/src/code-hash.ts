import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { codeHashOf, type CodeSource } from "@bonded/shared";

/**
 * The code version the runner launches, worked out so the operator doesn't have to type a code
 * hash. In order:
 * 1. `--code-hash <0x..>`: used as given;
 * 2. BONDED_CODE_HASH: used as given;
 * 3. BONDED_IMAGE_DIGEST (a container image digest, e.g. set by your deploy): keccak256 of
 *    `"image:<digest>"`;
 * 4. the git commit of the agent's working tree (the runner's directory, else the entry file's):
 *    keccak256 of `"git:<commit>"`, or `"git-dirty:<commit>"` when the tree has uncommitted
 *    changes (accepted, but labelled: the commit doesn't pin what ran);
 * 5. otherwise keccak256 of `"unpinned:"`, the command line as JSON, a newline and the bytes of its
 *    entry file (the first argument that is a file), labelled unpinned.
 * The runner sends it in its hello; the Arena records it when no code hash was declared.
 */
export interface CodeIdentity {
  codeHash: `0x${string}`;
  codeSource: CodeSource;
  /** What it was made from, for the runner's log (a commit, a digest, a file). */
  detail: string;
}

export interface CodeIdentityOptions {
  command: string[];
  /** `--code-hash`. */
  flag?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** The git commit and whether the tree is dirty for a directory (default: runs git). */
  git?: (dir: string) => { commit: string; dirty: boolean } | undefined;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function codeIdentity(options: CodeIdentityOptions): CodeIdentity {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.flag !== undefined) {
    if (!HASH.test(options.flag))
      throw new Error("--code-hash must be 0x followed by 64 hex digits");
    return { codeHash: lower(options.flag), codeSource: "flag", detail: "--code-hash" };
  }
  const declared = env.BONDED_CODE_HASH?.trim();
  if (declared) {
    if (!HASH.test(declared))
      throw new Error("BONDED_CODE_HASH must be 0x followed by 64 hex digits");
    return { codeHash: lower(declared), codeSource: "env", detail: "BONDED_CODE_HASH" };
  }
  const digest = env.BONDED_IMAGE_DIGEST?.trim();
  if (digest) return { codeHash: codeHashOf("image", digest), codeSource: "image", detail: digest };
  const entry = entryFile(options.command, cwd);
  const git = options.git ?? gitState;
  for (const dir of new Set([cwd, ...(entry ? [dirname(entry)] : [])])) {
    const state = git(dir);
    if (!state) continue;
    const source = state.dirty ? "git-dirty" : "git";
    return {
      codeHash: codeHashOf(source, state.commit),
      codeSource: source,
      detail: `commit ${state.commit.slice(0, 12)}${state.dirty ? " with uncommitted changes" : ""}`,
    };
  }
  const bytes = entry ? readFileSync(entry) : Buffer.alloc(0);
  const value = Buffer.concat([Buffer.from(`${JSON.stringify(options.command)}\n`), bytes]);
  return {
    codeHash: codeHashOf("unpinned", value),
    codeSource: "unpinned",
    detail: entry ? `the command and ${entry}` : "the command line",
  };
}

const lower = (hash: string) => hash.toLowerCase() as `0x${string}`;

/** The first word of the command that names a regular file (the program itself, if a path). */
function entryFile(command: string[], cwd: string): string | undefined {
  for (const [i, word] of command.entries()) {
    if (word.startsWith("-")) continue;
    // A bare program name (node, python) is looked up on PATH: not the agent's own code.
    if (i === 0 && !word.includes("/") && !word.includes("\\")) continue;
    const path = isAbsolute(word) ? word : resolve(cwd, word);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Not a file.
    }
  }
  return undefined;
}

/** `git rev-parse HEAD` and `git status --porcelain` in `dir`, or undefined outside a repository. */
export function gitState(dir: string): { commit: string; dirty: boolean } | undefined {
  try {
    const run = (args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim();
    const commit = run(["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return undefined;
    return { commit, dirty: run(["status", "--porcelain"]).length > 0 };
  } catch {
    return undefined;
  }
}

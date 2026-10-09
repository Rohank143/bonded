import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { codeHashOf, type CodeSource } from "@bonded/shared";

/**
 * The code version the runner launches, worked out so the operator doesn't have to type a code
 * hash. In order:
 * 1. `--code-hash <0x..>`: used as given;
 * 2. BONDED_CODE_HASH: used as given;
 * 3. BONDED_IMAGE_DIGEST (a container image digest, e.g. set by your deploy): keccak256 of
 *    `"image:<digest>"`;
 * 4. the git commit of the repository the entry file is in (with no entry file, the runner's
 *    directory's): keccak256 of `"git:<commit>"` when the entry file is tracked and the tree has
 *    no uncommitted changes, or `"git-dirty:<commit>"` when it has some (accepted, but labelled:
 *    the commit doesn't pin what ran). An entry file the repository doesn't track isn't pinned by
 *    its commit at all, so it falls through to 5;
 * 5. otherwise keccak256 of `"unpinned:"`, the command line as JSON, a newline and the bytes of its
 *    entry file (the first argument that is a file), labelled unpinned.
 * The runner sends it in its hello; the Arena records it when no code hash was declared, as
 * reported by the runner (nothing checks it: an operator can make the runner say anything).
 */
export interface CodeIdentity {
  codeHash: `0x${string}`;
  codeSource: CodeSource;
  /**
   * What it was made from, sent in hello as `codeDetail` (at most 200 characters): the full
   * commit for git and git-dirty, the digest for image, the flag or variable name for flag and
   * env, and for unpinned the entry file's name (never its local path).
   */
  detail: string;
}

export interface CodeIdentityOptions {
  command: string[];
  /** `--code-hash`. */
  flag?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * The git commit for a directory, whether the tree is dirty, and whether `entry` is tracked
   * (default: runs git).
   */
  git?: (dir: string, entry?: string) => GitState | undefined;
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
  if (digest)
    return {
      codeHash: codeHashOf("image", digest),
      codeSource: "image",
      detail: digest.slice(0, 200),
    };
  const entry = entryFile(options.command, cwd);
  const git = options.git ?? gitState;
  // The entry file's own repository: the runner's directory may be another one entirely.
  const state = git(entry ? dirname(entry) : cwd, entry);
  if (state && (!entry || state.entryTracked)) {
    const source = state.dirty ? "git-dirty" : "git";
    return {
      codeHash: codeHashOf(source, state.commit),
      codeSource: source,
      detail: state.commit,
    };
  }
  const bytes = entry ? readFileSync(entry) : Buffer.alloc(0);
  const value = Buffer.concat([Buffer.from(`${JSON.stringify(options.command)}\n`), bytes]);
  return {
    codeHash: codeHashOf("unpinned", value),
    codeSource: "unpinned",
    detail: entry ? `the command and ${basename(entry).slice(0, 150)}` : "the command line",
  };
}

const lower = (hash: string) => hash.toLowerCase() as `0x${string}`;

/** Entry files larger than this (an interpreter or a large binary) are not read. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/**
 * The agent's entry file: the first argument after the program that names a regular file (the
 * script an interpreter runs), else the program itself when it is given as a path. Files over
 * MAX_ENTRY_BYTES don't count: they are interpreters or large binaries, not the agent's code.
 */
function entryFile(command: string[], cwd: string): string | undefined {
  const isFile = (word: string): string | undefined => {
    const path = isAbsolute(word) ? word : resolve(cwd, word);
    try {
      const stat = statSync(path);
      return stat.isFile() && stat.size <= MAX_ENTRY_BYTES ? path : undefined;
    } catch {
      return undefined;
    }
  };
  for (const word of command.slice(1)) {
    if (word.startsWith("-")) continue;
    const path = isFile(word);
    if (path) return path;
  }
  // A bare program name (node, python) is looked up on PATH: not the agent's own code.
  const program = command[0];
  if (program && (program.includes("/") || program.includes("\\"))) return isFile(program);
  return undefined;
}

export interface GitState {
  commit: string;
  /** Uncommitted changes anywhere in the tree (the entry file's included). */
  dirty: boolean;
  /** Whether the repository tracks the entry file (when one was given). */
  entryTracked?: boolean;
}

/**
 * `git rev-parse HEAD`, `git status --porcelain` and (for `entry`) `git ls-files --error-unmatch`
 * in `dir`, or undefined outside a repository.
 */
export function gitState(dir: string, entry?: string): GitState | undefined {
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
    const dirty = run(["status", "--porcelain"]).length > 0;
    if (!entry) return { commit, dirty };
    let entryTracked = true;
    try {
      run(["ls-files", "--error-unmatch", "--", entry]);
    } catch {
      entryTracked = false;
    }
    return { commit, dirty, entryTracked };
  } catch {
    return undefined;
  }
}

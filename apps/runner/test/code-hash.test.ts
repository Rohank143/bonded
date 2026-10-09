import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeHashOf } from "@bonded/shared";
import { afterEach, describe, expect, it } from "vitest";
import { codeIdentity, gitState } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bonded-code-hash-"));
  dirs.push(dir);
  return dir;
}

const HASH = `0x${"Ab".repeat(32)}`;
const noGit = () => undefined;

// Real git calls and file reads: slow on a loaded machine, never asserted to be fast.
describe("the runner's code hash", { timeout: 60_000 }, () => {
  it("takes --code-hash first, then BONDED_CODE_HASH, as given", () => {
    const env = { BONDED_CODE_HASH: `0x${"cd".repeat(32)}`, BONDED_IMAGE_DIGEST: "sha256:1" };
    expect(codeIdentity({ command: ["node", "a.js"], flag: HASH, env, git: noGit })).toMatchObject({
      codeHash: HASH.toLowerCase(),
      codeSource: "flag",
    });
    expect(codeIdentity({ command: ["node", "a.js"], env, git: noGit })).toMatchObject({
      codeHash: env.BONDED_CODE_HASH,
      codeSource: "env",
    });
    expect(() => codeIdentity({ command: ["x"], flag: "0x12" })).toThrow(/--code-hash/);
    expect(() => codeIdentity({ command: ["x"], env: { BONDED_CODE_HASH: "abc" } })).toThrow(
      /BONDED_CODE_HASH/,
    );
  });

  it("then an image digest", () => {
    const id = codeIdentity({
      command: ["node", "a.js"],
      env: { BONDED_IMAGE_DIGEST: "sha256:feed" },
      git: () => ({ commit: "a".repeat(40), dirty: false }),
    });
    expect(id).toMatchObject({
      codeHash: codeHashOf("image", "sha256:feed"),
      codeSource: "image",
    });
  });

  it("then the git commit, labelled when the tree is dirty", () => {
    const commit = "b".repeat(40);
    expect(
      codeIdentity({ command: ["node", "a.js"], env: {}, git: () => ({ commit, dirty: false }) }),
    ).toMatchObject({ codeHash: codeHashOf("git", commit), codeSource: "git" });
    const dirty = codeIdentity({
      command: ["node", "a.js"],
      env: {},
      git: () => ({ commit, dirty: true }),
    });
    expect(dirty).toMatchObject({
      codeHash: codeHashOf("git-dirty", commit),
      codeSource: "git-dirty",
    });
    expect(dirty.detail).toBe(commit);
  });

  it("reads a real repository's commit and dirty state", () => {
    const dir = tempDir();
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      });
    git("init", "-q");
    writeFileSync(join(dir, "agent.js"), "console.log(1)\n");
    git("add", "agent.js");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "x",
    );
    const clean = gitState(dir);
    expect(clean).toMatchObject({ dirty: false });
    expect(clean?.commit).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(dir, "agent.js"), "console.log(2)\n");
    expect(gitState(dir)).toEqual({ commit: clean!.commit, dirty: true });
    // The entry file's folder counts when the runner runs elsewhere.
    const elsewhere = tempDir();
    expect(
      codeIdentity({ command: ["node", join(dir, "agent.js")], env: {}, cwd: elsewhere }),
    ).toMatchObject({ codeSource: "git-dirty", codeHash: codeHashOf("git-dirty", clean!.commit) });
  });

  it("labels git only when the repository tracks the entry file and nothing is uncommitted", () => {
    const dir = tempDir();
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      });
    git("init", "-q");
    writeFileSync(join(dir, "README"), "repo\n");
    git("add", "README");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "x",
    );
    // A clean repository whose commit says nothing about an untracked entry file: unpinned.
    writeFileSync(join(dir, "agent.js"), "evil()\n");
    const untracked = codeIdentity({ command: ["node", "agent.js"], env: {}, cwd: dir });
    expect(untracked.codeSource).toBe("unpinned");
    expect(gitState(dir, join(dir, "agent.js"))).toMatchObject({ entryTracked: false });
    // Tracked and committed: git. Then modified: git-dirty.
    git("add", "agent.js");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "y",
    );
    expect(codeIdentity({ command: ["node", "agent.js"], env: {}, cwd: dir }).codeSource).toBe(
      "git",
    );
    writeFileSync(join(dir, "agent.js"), "changed()\n");
    expect(codeIdentity({ command: ["node", "agent.js"], env: {}, cwd: dir }).codeSource).toBe(
      "git-dirty",
    );
    // The runner's own folder being a clean repository doesn't pin an entry file elsewhere.
    const outside = tempDir();
    writeFileSync(join(outside, "agent.js"), "x\n");
    expect(
      codeIdentity({ command: ["node", join(outside, "agent.js")], env: {}, cwd: dir }).codeSource,
    ).toBe("unpinned");
  });

  it("otherwise hashes the command and its entry file's bytes, labelled unpinned", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "agent.js"), "one");
    const first = codeIdentity({ command: ["node", "agent.js"], env: {}, cwd: dir, git: noGit });
    expect(first.codeSource).toBe("unpinned");
    expect(first.detail).toContain("agent.js");
    expect(codeIdentity({ command: ["node", "agent.js"], env: {}, cwd: dir, git: noGit })).toEqual(
      first,
    );
    writeFileSync(join(dir, "agent.js"), "two");
    const changed = codeIdentity({ command: ["node", "agent.js"], env: {}, cwd: dir, git: noGit });
    expect(changed.codeHash).not.toBe(first.codeHash);
    const otherArgs = codeIdentity({
      command: ["node", "agent.js", "--fast"],
      env: {},
      cwd: dir,
      git: noGit,
    });
    expect(otherArgs.codeHash).not.toBe(changed.codeHash);
    // An interpreter given by path is not the entry file: its script is.
    expect(
      codeIdentity({ command: [process.execPath, "agent.js"], env: {}, cwd: dir, git: noGit })
        .detail,
    ).toContain("agent.js");
    expect(
      codeIdentity({ command: [process.execPath, "-e", "1"], env: {}, cwd: dir, git: noGit }),
    ).toMatchObject({ detail: "the command line" });
    // With no file in the command, the command line alone.
    expect(codeIdentity({ command: ["my-agent"], env: {}, cwd: dir, git: noGit })).toMatchObject({
      codeSource: "unpinned",
      detail: "the command line",
    });
  });
});

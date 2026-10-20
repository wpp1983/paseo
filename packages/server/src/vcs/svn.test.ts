import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadCheckoutDiff } from "./checkout-diff.js";
import { clearSvnStatusCache, readSvnCheckoutDiff, readSvnWorkingCopy } from "./svn.js";

function commandExists(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasSvn = commandExists("svn") && commandExists("svnadmin") && commandExists("svnversion");

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

describe.skipIf(!hasSvn)("svn checkout diff", () => {
  let scratch = "";
  let wc = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "paseo-svn-"));
    const repo = join(scratch, "repo");
    wc = join(scratch, "wc");
    const other = join(scratch, "other");
    run("svnadmin", ["create", repo]);
    const url = pathToFileURL(repo).href;
    run("svn", ["checkout", url, wc]);
    await mkdir(join(wc, "src"), { recursive: true });
    await writeFile(join(wc, "src", "kept.txt"), "one\n");
    await writeFile(join(wc, "src", "gone.txt"), "a\nb\n");
    await writeFile(join(wc, "src", "note.txt"), "base\n");
    await writeFile(join(wc, "src", "spaces.txt"), "a\n");
    run("svn", ["add", "src"], wc);
    run("svn", ["commit", "-m", "init", "--non-interactive"], wc);
    run("svn", ["update", "--non-interactive"], wc);

    run("svn", ["checkout", url, other]);
    await writeFile(join(other, "src", "note.txt"), "theirs\n");
    run("svn", ["commit", "-m", "theirs", "--non-interactive"], other);

    await writeFile(join(wc, "src", "kept.txt"), "one\ntwo\n");
    await writeFile(join(wc, "src", "spaces.txt"), "a \n");
    run("svn", ["delete", "src/gone.txt", "--non-interactive"], wc);
    await writeFile(join(wc, "src", "added.txt"), "new\n");
    run("svn", ["add", "src/added.txt", "--non-interactive"], wc);
    await writeFile(join(wc, "loose.txt"), "x\ny\n");
    await mkdir(join(wc, "huge", "nested"), { recursive: true });
    await writeFile(join(wc, "huge", "nested", "skip.txt"), "do not walk\n");
    await writeFile(join(wc, "src", "note.txt"), "mine\n");
    run("svn", ["update", "--accept", "postpone", "--non-interactive"], wc);
    await writeFile(join(wc, "fat.bin"), "a".repeat(300 * 1024));
  });

  afterAll(async () => {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    clearSvnStatusCache();
  });

  test("lists revision, url, and each svn change without walking unversioned directories", async () => {
    const identity = await readSvnWorkingCopy(wc);
    const version = run("svnversion", [wc])
      .trim()
      .replace(/[MSP]+$/, "");
    expect(identity).toMatchObject({
      kind: "svn",
      root: wc,
      label: `r${version}`,
    });
    expect(identity.url?.startsWith("file://")).toBe(true);
    expect(identity.statusDigest.length).toBeGreaterThan(0);

    const diff = await readSvnCheckoutDiff({
      root: wc,
      ignoreWhitespace: false,
      includeStructured: true,
    });
    const files = diff.structured ?? [];
    expect(files.map((file) => file.path)).toEqual([
      "fat.bin",
      "huge",
      "loose.txt",
      "src/added.txt",
      "src/gone.txt",
      "src/kept.txt",
      "src/note.txt",
      "src/spaces.txt",
    ]);
    expect(files.map((file) => ({ path: file.path, change: file.change }))).toEqual([
      { path: "fat.bin", change: "unversioned" },
      { path: "huge", change: "unversioned" },
      { path: "loose.txt", change: "unversioned" },
      { path: "src/added.txt", change: "added" },
      { path: "src/gone.txt", change: "deleted" },
      { path: "src/kept.txt", change: "modified" },
      { path: "src/note.txt", change: "conflicted" },
      { path: "src/spaces.txt", change: "modified" },
    ]);
    expect(files.find((file) => file.path === "src/kept.txt")).toMatchObject({
      additions: 1,
      deletions: 0,
      isNew: false,
      isDeleted: false,
    });
    expect(files.find((file) => file.path === "src/gone.txt")).toMatchObject({
      additions: 0,
      deletions: 2,
      isDeleted: true,
    });
    expect(files.find((file) => file.path === "src/added.txt")).toMatchObject({
      additions: 1,
      deletions: 0,
      isNew: true,
    });
    expect(files.find((file) => file.path === "loose.txt")).toMatchObject({
      additions: 2,
      deletions: 0,
      isNew: true,
      hunks: [
        {
          lines: [
            { type: "header", content: "@@ -0,0 +1,2 @@" },
            { type: "add", content: "x" },
            { type: "add", content: "y" },
          ],
        },
      ],
    });
    expect(files.find((file) => file.path === "huge")).toMatchObject({
      additions: 0,
      deletions: 0,
      isNew: true,
      hunks: [],
    });
    expect(files.find((file) => file.path === "fat.bin")).toMatchObject({
      status: "too_large",
      additions: 0,
      hunks: [],
    });
    expect(
      files.some((file) => file.path.includes("skip.txt") || /\.(mine|prej|r\d+)$/.test(file.path)),
    ).toBe(false);
  });

  test("drops whitespace-only edits when whitespace is ignored", async () => {
    clearSvnStatusCache();
    const diff = await readSvnCheckoutDiff({
      root: wc,
      ignoreWhitespace: true,
      includeStructured: true,
    });
    const paths = (diff.structured ?? []).map((file) => file.path);
    expect(paths).not.toContain("src/spaces.txt");
    expect(paths).toContain("src/kept.txt");
  });

  test("does not ask git for an svn working copy, including a base comparison", async () => {
    const calls: string[] = [];
    const readGitDiff = async () => {
      calls.push("git");
      return { diff: "from-git" };
    };
    const uncommitted = await loadCheckoutDiff({
      cwd: join(wc, "src"),
      compare: { mode: "uncommitted", ignoreWhitespace: false, includeStructured: true },
      readGitDiff,
    });
    const base = await loadCheckoutDiff({
      cwd: wc,
      compare: { mode: "base", includeStructured: true },
      readGitDiff,
    });
    expect(calls).toEqual([]);
    expect((uncommitted.structured ?? []).some((file) => file.path === "src/kept.txt")).toBe(true);
    expect(base).toEqual({ diff: "", structured: [] });
  });

  test("keeps git when it is the nearer root", async () => {
    const gitRoot = join(scratch, "git-nearer");
    const nestedSvn = join(gitRoot, "vendor");
    await mkdir(gitRoot);
    run("git", ["init"], gitRoot);
    run("svn", ["checkout", pathToFileURL(join(scratch, "repo")).href, nestedSvn]);
    const calls: string[] = [];
    await loadCheckoutDiff({
      cwd: gitRoot,
      compare: { mode: "uncommitted", includeStructured: true },
      readGitDiff: async () => {
        calls.push(gitRoot);
        return { diff: "" };
      },
    });
    await loadCheckoutDiff({
      cwd: nestedSvn,
      compare: { mode: "uncommitted", includeStructured: true },
      readGitDiff: async () => {
        calls.push(nestedSvn);
        return { diff: "" };
      },
    });
    expect(calls).toEqual([gitRoot]);
  });
});

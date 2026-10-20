import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { findBlockingSvnDirectory, findNearestVcsRoot, selectVcsRoot } from "./root.js";

function commandExists(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasSvn = commandExists("svn") && commandExists("svnadmin");

function run(command: string, args: string[], cwd?: string): void {
  execFileSync(command, args, { cwd, stdio: "ignore" });
}

describe("selectVcsRoot", () => {
  test("uses svn when its root is closer than the git toplevel", () => {
    expect(
      selectVcsRoot({
        cwd: resolve("/work/driver_project/src"),
        gitToplevel: resolve("/work"),
        svnRoot: resolve("/work/driver_project"),
      }),
    ).toEqual({ kind: "svn", root: resolve("/work/driver_project") });
  });

  test("uses git when its toplevel is closer than the svn root", () => {
    expect(
      selectVcsRoot({
        cwd: resolve("/work/driver_project/vendor"),
        gitToplevel: resolve("/work/driver_project/vendor"),
        svnRoot: resolve("/work/driver_project"),
      }),
    ).toEqual({ kind: "git", root: resolve("/work/driver_project/vendor") });
  });

  test("keeps git when both roots are the same directory", () => {
    const root = resolve("/work/both");
    expect(
      selectVcsRoot({
        cwd: root,
        gitToplevel: root,
        svnRoot: root,
      }),
    ).toEqual({ kind: "git", root });
  });

  test("returns the only root that is present", () => {
    const root = resolve("/work");
    expect(selectVcsRoot({ cwd: root, gitToplevel: root, svnRoot: null })).toEqual({
      kind: "git",
      root,
    });
    expect(selectVcsRoot({ cwd: root, gitToplevel: null, svnRoot: root })).toEqual({
      kind: "svn",
      root,
    });
    expect(selectVcsRoot({ cwd: root, gitToplevel: null, svnRoot: null })).toBeNull();
  });
});

describe("nearest VCS root", () => {
  let scratch = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "paseo-vcs-root-"));
  });

  afterAll(async () => {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("finds an svn directory nested inside git without confirming it", async () => {
    const gitRoot = join(scratch, "marker-git");
    const svnDir = join(gitRoot, "driver_project");
    await mkdir(join(gitRoot, ".git"), { recursive: true });
    await mkdir(join(svnDir, ".svn"), { recursive: true });
    expect(findBlockingSvnDirectory(join(svnDir, "src"))).toBe(svnDir);
    expect(findBlockingSvnDirectory(gitRoot)).toBeNull();
  });

  test("returns null when no working copy exists", async () => {
    const cwd = join(scratch, "empty");
    await mkdir(cwd);
    expect(await findNearestVcsRoot(cwd)).toBeNull();
  });

  test("treats a .git file as a git worktree", async () => {
    const cwd = join(scratch, "worktree");
    await mkdir(cwd);
    await writeFile(join(cwd, ".git"), "gitdir: /somewhere\n");
    expect(await findNearestVcsRoot(cwd)).toEqual({ kind: "git", root: cwd });
  });

  test("keeps a directory that has both markers on git", async () => {
    const cwd = join(scratch, "both");
    await mkdir(join(cwd, ".svn"), { recursive: true });
    await mkdir(join(cwd, ".git"));
    expect(await findNearestVcsRoot(cwd)).toEqual({ kind: "git", root: cwd });
  });

  describe.skipIf(!hasSvn)("with svn", () => {
    let repoUrl = "";

    beforeAll(() => {
      const repo = join(scratch, "svn-repo");
      run("svnadmin", ["create", repo]);
      repoUrl = `file://${repo}`;
    });

    test("walks past a stray .svn directory to the parent git root", async () => {
      const gitRoot = join(scratch, "parent-git");
      const stray = join(gitRoot, "nested");
      await mkdir(join(stray, ".svn"), { recursive: true });
      await mkdir(join(gitRoot, ".git"));
      expect(await findNearestVcsRoot(stray)).toEqual({ kind: "git", root: gitRoot });
    });

    test("uses the svn working copy nested inside a git checkout", async () => {
      const gitRoot = join(scratch, "git-outer");
      const wc = join(gitRoot, "wc");
      await mkdir(gitRoot);
      await mkdir(join(gitRoot, ".git"));
      run("svn", ["checkout", repoUrl, wc]);
      const nested = join(wc, "src");
      await mkdir(nested);
      expect(await findNearestVcsRoot(nested)).toEqual({ kind: "svn", root: wc });
    });

    test("uses the git checkout nested inside an svn working copy", async () => {
      const wc = join(scratch, "svn-outer");
      const gitChild = join(wc, "git-child");
      run("svn", ["checkout", repoUrl, wc]);
      await mkdir(join(gitChild, ".git"), { recursive: true });
      expect(await findNearestVcsRoot(gitChild)).toEqual({ kind: "git", root: gitChild });
    });
  });
});

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { clearSvnStatusCache } from "../vcs/svn.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { FileObserver, FileObserverDiagnostics } from "./file-observer/index.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";

function commandExists(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasSvn = commandExists("svn") && commandExists("svnadmin") && commandExists("svnversion");

function run(command: string, args: string[], cwd?: string): void {
  execFileSync(command, args, { cwd, stdio: "ignore" });
}

function emptyDiagnostics(): FileObserverDiagnostics {
  return {
    activeObservationCount: 0,
    nativeHandleCount: 0,
    nativeTrackedFileCount: 0,
    pendingEventCount: 0,
    pendingReconciliationWorkCount: 0,
    pendingClassificationCount: 0,
    reconciliationInFlightCount: 0,
    reconciliationCount: 0,
    scopedReconciliationCount: 0,
    fullReconciliationCount: 0,
    reconciliationFailureCount: 0,
    observerFailureCount: 0,
    directoryLimitFailureCount: 0,
    nativeEventCount: 0,
    nativeChangeEventCount: 0,
    nativeRenameEventCount: 0,
    nativePathlessEventCount: 0,
    nativeClassificationCount: 0,
    nativeShallowScanCount: 0,
    lastReconciliationDurationMs: 0,
    maxReconciliationDurationMs: 0,
  };
}

describe.skipIf(!hasSvn)("svn working copy nested in a git repo", () => {
  let scratch = "";
  let gitRoot = "";
  let wc = "";
  let service: WorkspaceGitServiceImpl;
  const subscribed: string[] = [];

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "paseo-nested-svn-")));
    gitRoot = join(scratch, "Work");
    wc = join(gitRoot, "driver_project");
    const repo = join(scratch, "svn-repo");
    await mkdir(gitRoot);
    run("git", ["init", "-b", "main"], gitRoot);
    run("git", ["config", "user.email", "test@example.com"], gitRoot);
    run("git", ["config", "user.name", "Test"], gitRoot);
    await writeFile(join(gitRoot, ".gitignore"), "driver_project/\n");
    await writeFile(join(gitRoot, "README.md"), "hello\n");
    run("git", ["add", ".gitignore", "README.md"], gitRoot);
    run("git", ["commit", "-m", "init"], gitRoot);
    await writeFile(join(gitRoot, "README.md"), "hello\nparent edit\n");
    await writeFile(join(gitRoot, "parent-only.txt"), "from parent\n");

    run("svnadmin", ["create", repo]);
    run("svn", ["checkout", `file://${repo}`, wc]);
    await mkdir(join(wc, "src"));
    await writeFile(join(wc, "src", "kept.txt"), "one\n");
    run("svn", ["add", "src"], wc);
    run("svn", ["commit", "-m", "init", "--non-interactive"], wc);

    const fileObserver: FileObserver = {
      subscribe: async (directory) => {
        subscribed.push(directory);
        return {
          updateIgnore: async () => {},
          unsubscribe: async () => {},
        };
      },
      getDiagnostics: emptyDiagnostics,
      close: async () => {},
    };
    service = new WorkspaceGitServiceImpl({
      logger: pino({ enabled: false }),
      paseoHome: join(scratch, "home"),
      fileObserver,
    });
  });

  afterAll(async () => {
    await service?.dispose();
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("snapshot and changes list contain no parent git files when svn status is clean", async () => {
    const snapshot = await service.getSnapshot(wc, { includeForge: false });
    expect(snapshot.git).toMatchObject({
      isGit: false,
      repoRoot: null,
      currentBranch: null,
      remoteUrl: null,
      diffStat: null,
    });
    expect(snapshot.vcs).toMatchObject({ kind: "svn", root: wc });
    expect(snapshot.vcs?.label).toMatch(/^r\d+/);

    const nestedSnapshot = await service.getSnapshot(join(wc, "src"), { includeForge: false });
    expect(nestedSnapshot.git.isGit).toBe(false);
    expect(nestedSnapshot.git.repoRoot).toBeNull();
    expect(nestedSnapshot.vcs).toMatchObject({ kind: "svn", root: wc });

    const diff = await service.getCheckoutDiff(wc, {
      mode: "uncommitted",
      includeStructured: true,
    });
    expect(diff.structured ?? []).toEqual([]);

    const manager = new CheckoutDiffManager({
      logger: pino({ enabled: false }),
      paseoHome: join(scratch, "home"),
      workspaceGitService: service,
    });
    const subscription = await manager.subscribe(
      { cwd: wc, compare: { mode: "uncommitted" } },
      () => {},
    );
    expect(subscription.initial.files).toEqual([]);
    subscription.unsubscribe();

    const watch = await service.requestWorkingTreeWatch(wc, () => {});
    expect(watch.repoRoot).toBeNull();
    expect(subscribed).toEqual([]);
    watch.unsubscribe();

    const parent = await service.getSnapshot(gitRoot, { includeForge: false });
    expect(parent.git.isGit).toBe(true);
    expect(parent.git.repoRoot).toBe(gitRoot);
    expect(parent.vcs).toBeUndefined();
    const parentDiff = await service.getCheckoutDiff(gitRoot, {
      mode: "uncommitted",
      includeStructured: true,
    });
    expect(parentDiff.structured?.map((file) => file.path).sort()).toEqual([
      "README.md",
      "parent-only.txt",
    ]);

    const gitWatch = await service.requestWorkingTreeWatch(gitRoot, () => {});
    expect(gitWatch.repoRoot).toBe(gitRoot);
    expect(subscribed).toEqual([gitRoot]);
    gitWatch.unsubscribe();
  });

  test("counts additions and deletions from svn status, not the parent git repo", async () => {
    await writeFile(join(wc, "notes.txt"), "svn line\n");
    clearSvnStatusCache();
    const snapshot = await service.getSnapshot(wc, {
      force: true,
      includeForge: false,
      reason: "svn-edit",
    });
    expect(snapshot.git.isGit).toBe(false);
    expect(snapshot.git.diffStat).toEqual({ additions: 1, deletions: 0 });

    const diff = await service.getCheckoutDiff(
      wc,
      { mode: "uncommitted", includeStructured: true },
      { force: true, reason: "svn-edit" },
    );
    expect(
      diff.structured?.map((file) => ({ path: file.path, additions: file.additions })),
    ).toEqual([{ path: "notes.txt", additions: 1 }]);
  });
});

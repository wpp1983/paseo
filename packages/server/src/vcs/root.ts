import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isSvnMissing, runSvnCommand, SvnCommandError } from "./svn-command.js";

export interface VcsRoot {
  kind: "git" | "svn";
  root: string;
}

const SVN_INFO_TIMEOUT_MS = 15_000;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function confirmSvnRoot(directory: string): Promise<VcsRoot | null> {
  try {
    const stdout = await runSvnCommand(
      "svn",
      ["info", "--non-interactive", "--show-item", "wc-root"],
      { cwd: directory, timeoutMs: SVN_INFO_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    );
    const reported = stdout.trim();
    if (!reported) {
      return null;
    }
    return { kind: "svn", root: resolve(reported) };
  } catch (error) {
    if (isSvnMissing(error)) {
      return { kind: "svn", root: directory };
    }
    if (error instanceof SvnCommandError) {
      return null;
    }
    throw error;
  }
}

export interface VcsRootChoice {
  cwd: string;
  gitToplevel: string | null;
  svnRoot: string | null;
}

/**
 * Pick the working copy by distance from `cwd`. SVN wins only when its root
 * is strictly closer than the git toplevel, so a parent git repo does not
 * own a nested working copy. The same directory stays git.
 */
export function selectVcsRoot(input: VcsRootChoice): VcsRoot | null {
  const cwd = resolve(input.cwd);
  const gitRoot = input.gitToplevel === null ? null : resolve(input.gitToplevel);
  const svnRoot = input.svnRoot === null ? null : resolve(input.svnRoot);
  if (gitRoot !== null && svnRoot !== null) {
    if (ancestorDistance(cwd, svnRoot) < ancestorDistance(cwd, gitRoot)) {
      return { kind: "svn", root: svnRoot };
    }
    return { kind: "git", root: gitRoot };
  }
  if (gitRoot !== null) {
    return { kind: "git", root: gitRoot };
  }
  if (svnRoot !== null) {
    return { kind: "svn", root: svnRoot };
  }
  return null;
}

function ancestorDistance(cwd: string, root: string): number {
  const fromRoot = relative(root, cwd);
  if (fromRoot === "") {
    return 0;
  }
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    return Number.POSITIVE_INFINITY;
  }
  return fromRoot.split(sep).length;
}

interface VcsWalkHit {
  kind: "git" | "svn";
  directory: string;
}

function findFirstVcsHit(start: string): VcsWalkHit | null {
  let current = resolve(start);
  const filesystemRoot = parse(current).root;
  for (;;) {
    // Marker checks stay synchronous. A git snapshot must not wait on a walk
    // to the filesystem root before it can be published.
    if (existsSync(join(current, ".git"))) {
      return { kind: "git", directory: current };
    }
    if (isDirectory(join(current, ".svn"))) {
      return { kind: "svn", directory: current };
    }
    if (current === filesystemRoot) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * An `.svn` directory closer to `cwd` than any `.git`. Callers that publish
 * git snapshots skip the async SVN check when this is null.
 */
export function findBlockingSvnDirectory(cwd: string): string | null {
  const hit = findFirstVcsHit(cwd);
  return hit?.kind === "svn" ? hit.directory : null;
}

/**
 * The working copy is the VCS root closest to `cwd`. A directory that contains
 * both `.git` and `.svn` stays a git checkout — that is the root git already
 * uses, and switching it to SVN would change existing repositories.
 */
export async function findNearestVcsRoot(cwd: string): Promise<VcsRoot | null> {
  let current = resolve(cwd);
  for (;;) {
    const hit = findFirstVcsHit(current);
    if (!hit) {
      return null;
    }
    if (hit.kind === "git") {
      return { kind: "git", root: hit.directory };
    }
    const confirmed = await confirmSvnRoot(hit.directory);
    if (confirmed) {
      return confirmed;
    }
    const parent = dirname(hit.directory);
    if (parent === hit.directory) {
      return null;
    }
    current = parent;
  }
}

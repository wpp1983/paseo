import { existsSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
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

/**
 * The working copy is the VCS root closest to `cwd`. A directory that contains
 * both `.git` and `.svn` stays a git checkout — that is the root git already
 * uses, and switching it to SVN would change existing repositories.
 */
export async function findNearestVcsRoot(cwd: string): Promise<VcsRoot | null> {
  let current = resolve(cwd);
  const filesystemRoot = parse(current).root;
  for (;;) {
    // Marker checks stay synchronous. A git snapshot must not wait on a walk
    // to the filesystem root before it can be published.
    if (existsSync(join(current, ".git"))) {
      return { kind: "git", root: current };
    }
    if (isDirectory(join(current, ".svn"))) {
      const confirmed = await confirmSvnRoot(current);
      if (confirmed) {
        return confirmed;
      }
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

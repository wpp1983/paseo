import type { CheckoutDiffCompare, CheckoutDiffResult } from "../utils/checkout-git.js";
import { findNearestVcsRoot } from "./root.js";
import { readSvnCheckoutDiff } from "./svn.js";

export interface CheckoutDiffLoad {
  cwd: string;
  compare: Pick<CheckoutDiffCompare, "mode" | "ignoreWhitespace" | "includeStructured">;
  readGitDiff: () => Promise<CheckoutDiffResult>;
}

/**
 * Git diffs stay on the existing checkout path. SVN is used only when the
 * nearest working-copy root is Subversion.
 */
export async function loadCheckoutDiff(input: CheckoutDiffLoad): Promise<CheckoutDiffResult> {
  const nearest = await findNearestVcsRoot(input.cwd);
  if (nearest?.kind !== "svn") {
    return input.readGitDiff();
  }
  if (input.compare.mode === "base") {
    return input.compare.includeStructured ? { diff: "", structured: [] } : { diff: "" };
  }
  return readSvnCheckoutDiff({
    root: nearest.root,
    ignoreWhitespace: input.compare.ignoreWhitespace === true,
    includeStructured: input.compare.includeStructured === true,
  });
}

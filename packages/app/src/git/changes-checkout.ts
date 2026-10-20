export interface ChangesCheckout {
  kind: "git" | "svn" | "none";
  /** Git branch, or an SVN revision label such as `r572`. */
  label: string | null;
  url: string | null;
  /** SVN checkouts are read-only: commit, branch, and stage stay hidden. */
  readOnly: boolean;
}

interface ChangesCheckoutStatus {
  isGit: boolean;
  currentBranch: string | null;
  vcs?: { kind: string; label: string; url: string | null } | null;
}

/**
 * The Changes panel follows the nearest working copy. An SVN label wins over
 * a git branch that belongs to an ancestor repository.
 */
export function resolveChangesCheckout(status: ChangesCheckoutStatus | null): ChangesCheckout {
  const svnLabel = status?.vcs?.kind === "svn" ? status.vcs.label.trim() : "";
  if (status?.vcs?.kind === "svn" && svnLabel) {
    return {
      kind: "svn",
      label: svnLabel,
      url: status.vcs.url,
      readOnly: true,
    };
  }
  if (status?.isGit) {
    const branch = status.currentBranch?.trim() ?? "";
    const label = branch && branch !== "HEAD" ? branch : null;
    return { kind: "git", label, url: null, readOnly: false };
  }
  return { kind: "none", label: null, url: null, readOnly: false };
}

import { describe, expect, it } from "vitest";
import { resolveChangesCheckout } from "./changes-checkout";

describe("resolveChangesCheckout", () => {
  it("keeps a git branch editable", () => {
    expect(
      resolveChangesCheckout({
        isGit: true,
        currentBranch: "main",
        vcs: undefined,
      }),
    ).toEqual({
      kind: "git",
      label: "main",
      url: null,
      readOnly: false,
    });
  });

  it("shows the SVN revision and hides git actions when the working copy is SVN", () => {
    expect(
      resolveChangesCheckout({
        isGit: false,
        currentBranch: null,
        vcs: {
          kind: "svn",
          label: "r572",
          url: "https://svn.example/trunk",
        },
      }),
    ).toEqual({
      kind: "svn",
      label: "r572",
      url: "https://svn.example/trunk",
      readOnly: true,
    });
  });

  it("prefers a nearer SVN working copy over an ancestor git branch", () => {
    expect(
      resolveChangesCheckout({
        isGit: true,
        currentBranch: "main",
        vcs: {
          kind: "svn",
          label: "r12",
          url: "file:///repo",
        },
      }),
    ).toEqual({
      kind: "svn",
      label: "r12",
      url: "file:///repo",
      readOnly: true,
    });
  });

  it("treats a directory with no working copy as empty", () => {
    expect(resolveChangesCheckout({ isGit: false, currentBranch: null })).toEqual({
      kind: "none",
      label: null,
      url: null,
      readOnly: false,
    });
  });
});

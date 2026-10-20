import { describe, expect, test } from "vitest";
import { formatSvnRevisionLabel, parseSvnInfoXml, parseSvnStatusXml } from "./svn-status.js";

describe("svn status xml", () => {
  test("normalizes Windows paths, entities, and conflict bookkeeping", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path=".">
<entry path=".">
<wc-status item="normal" props="none"></wc-status>
</entry>
<entry path="src\\child.ts">
<wc-status item="modified" props="none"></wc-status>
</entry>
<entry path="src\\amp&amp;ersand.ts">
<wc-status item="added" props="none"></wc-status>
</entry>
<entry path="huge">
<wc-status item="unversioned" props="none"></wc-status>
</entry>
<entry path="note.txt">
<wc-status item="conflicted" props="none"></wc-status>
</entry>
<entry path="note.txt.mine">
<wc-status item="unversioned" props="none"></wc-status>
</entry>
<entry path="note.txt.r12">
<wc-status item="unversioned" props="none"></wc-status>
</entry>
<entry path="gone.ts">
<wc-status item="missing" props="modified"></wc-status>
</entry>
</target>
</status>`;

    expect(parseSvnStatusXml(xml)).toEqual([
      { path: "src/child.ts", change: "modified" },
      { path: "src/amp&ersand.ts", change: "added" },
      { path: "huge", change: "unversioned" },
      { path: "note.txt", change: "conflicted" },
      { path: "gone.ts", change: "deleted" },
    ]);
  });
});

describe("svn revision labels", () => {
  test("keeps a revision range and drops mixed-revision flags", () => {
    expect(formatSvnRevisionLabel("572")).toBe("r572");
    expect(formatSvnRevisionLabel("572M")).toBe("r572");
    expect(formatSvnRevisionLabel("  1:3SP ")).toBe("r1:3");
    expect(formatSvnRevisionLabel("exported")).toBeNull();
  });
});

describe("svn info xml", () => {
  test("reads the repository url and revision", () => {
    const xml = `<info><entry revision="572"><url>https://svn.example/repo/trunk?x=1&amp;y=2</url></entry></info>`;
    expect(parseSvnInfoXml(xml)).toEqual({
      url: "https://svn.example/repo/trunk?x=1&y=2",
      revision: "572",
    });
  });
});

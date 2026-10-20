export type SvnChangeKind = "modified" | "added" | "deleted" | "unversioned" | "conflicted";

export interface SvnStatusEntry {
  path: string;
  change: SvnChangeKind;
}

const CONFLICT_ARTIFACT = /\.(mine|prej|r\d+)$/;

export function toPortableRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function formatSvnRevisionLabel(svnversion: string): string | null {
  const withoutFlags = svnversion.trim().replace(/[MSP]+$/, "");
  if (!/^\d+(:\d+)?$/.test(withoutFlags)) {
    return null;
  }
  return `r${withoutFlags}`;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function attribute(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
  return match ? decodeXml(match[1]) : null;
}

function changeKind(item: string, props: string, treeConflict: boolean): SvnChangeKind | null {
  if (treeConflict || item === "conflicted" || props === "conflicted") {
    return "conflicted";
  }
  if (item === "added") return "added";
  if (item === "deleted" || item === "missing") return "deleted";
  if (item === "modified" || item === "replaced") return "modified";
  if (item === "unversioned") return "unversioned";
  if (props === "modified") return "modified";
  return null;
}

/**
 * `svn status` lists an unversioned directory as one row and does not walk it.
 * Conflict bookkeeping files (`file.mine`, `file.r12`) are noise beside the
 * conflicted path itself.
 */
export function parseSvnStatusXml(xml: string): SvnStatusEntry[] {
  const entries: SvnStatusEntry[] = [];
  const entryPattern = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  for (const match of xml.matchAll(entryPattern)) {
    const path = attribute(match[1] ?? "", "path");
    const statusTag = /<wc-status\b([^>]*)>/.exec(match[2] ?? "");
    if (!path || path === "." || !statusTag) {
      continue;
    }
    const item = attribute(statusTag[1] ?? "", "item") ?? "";
    const props = attribute(statusTag[1] ?? "", "props") ?? "";
    const treeConflict = attribute(statusTag[1] ?? "", "tree-conflicted") === "true";
    const change = changeKind(item, props, treeConflict);
    if (!change) {
      continue;
    }
    const portable = toPortableRelativePath(path);
    if (change === "unversioned" && CONFLICT_ARTIFACT.test(portable)) {
      continue;
    }
    entries.push({ path: portable, change });
  }
  return entries;
}

export function parseSvnInfoXml(xml: string): { url: string | null; revision: string | null } {
  const url = /<url>([^<]*)<\/url>/.exec(xml)?.[1] ?? null;
  const revision = /<entry\b[^>]*\brevision="(\d+)"/.exec(xml)?.[1] ?? null;
  return {
    url: url ? decodeXml(url) : null,
    revision,
  };
}

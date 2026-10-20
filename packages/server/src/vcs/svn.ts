import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CheckoutDiffResult } from "../utils/checkout-git.js";
import { CHECKOUT_DIFF_MAX_STRUCTURED_BYTES } from "../utils/checkout-git.js";
import { parseDiff, type ParsedDiffFile } from "../server/utils/diff-highlighter.js";
import { isSvnOutputTooLarge, runSvnCommand } from "./svn-command.js";
import {
  formatSvnRevisionLabel,
  parseSvnInfoXml,
  parseSvnStatusXml,
  toPortableRelativePath,
  type SvnChangeKind,
  type SvnStatusEntry,
} from "./svn-status.js";

export interface SvnWorkingCopy {
  kind: "svn";
  root: string;
  label: string;
  url: string | null;
  /** Local status fingerprint. Stays off the wire; it only refreshes watches. */
  statusDigest: string;
}

const INFO_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 60_000;
const DIFF_TIMEOUT_MS = 60_000;
const STATUS_MAX_BUFFER = 32 * 1024 * 1024;
const DIFF_MAX_BUFFER = 32 * 1024 * 1024;
const UNVERSIONED_MAX_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 16 * 1024;
const STATUS_CACHE_MS = 1_000;

interface CachedStatus {
  at: number;
  xml: string;
}

const statusXmlCache = new Map<string, CachedStatus>();

export function clearSvnStatusCache(): void {
  statusXmlCache.clear();
}

export async function readSvnStatusXml(root: string): Promise<string> {
  const cached = statusXmlCache.get(root);
  const now = Date.now();
  if (cached && now - cached.at < STATUS_CACHE_MS) {
    return cached.xml;
  }
  const xml = await runSvnCommand(
    "svn",
    ["status", "--non-interactive", "--ignore-externals", "--xml"],
    { cwd: root, timeoutMs: STATUS_TIMEOUT_MS, maxBuffer: STATUS_MAX_BUFFER },
  );
  statusXmlCache.set(root, { at: now, xml });
  return xml;
}

export async function readSvnWorkingCopy(root: string): Promise<SvnWorkingCopy> {
  const [versionRaw, infoXml, statusXml] = await Promise.all([
    runSvnCommand("svnversion", [root], {
      cwd: root,
      timeoutMs: INFO_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    }).catch(() => ""),
    runSvnCommand("svn", ["info", "--non-interactive", "--xml"], {
      cwd: root,
      timeoutMs: INFO_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }),
    readSvnStatusXml(root).catch(() => ""),
  ]);
  const info = parseSvnInfoXml(infoXml);
  const fromVersion = formatSvnRevisionLabel(versionRaw);
  const fromInfo = info.revision ? formatSvnRevisionLabel(info.revision) : null;
  return {
    kind: "svn",
    root,
    label: fromVersion ?? fromInfo ?? "svn",
    url: info.url,
    statusDigest: createHash("sha256").update(statusXml).digest("hex"),
  };
}

interface SvnDiffRead {
  root: string;
  ignoreWhitespace: boolean;
  includeStructured: boolean;
}

export async function readSvnCheckoutDiff(input: SvnDiffRead): Promise<CheckoutDiffResult> {
  const statusXml = await readSvnStatusXml(input.root);
  const entries = parseSvnStatusXml(statusXml);
  if (!input.includeStructured) {
    return { diff: "" };
  }
  let diffText = "";
  try {
    diffText = await runSvnCommand("svn", svnDiffArgs(input.ignoreWhitespace), {
      cwd: input.root,
      timeoutMs: DIFF_TIMEOUT_MS,
      maxBuffer: DIFF_MAX_BUFFER,
    });
  } catch (error) {
    if (!isSvnOutputTooLarge(error)) {
      throw error;
    }
  }
  const parsed = parseSvnGitDiff(diffText.replace(/\r\n/g, "\n"));
  const files = await buildSvnDiffFiles({
    root: input.root,
    entries,
    parsed,
    ignoreWhitespace: input.ignoreWhitespace,
    diffWasTruncated:
      diffText.length === 0 && entries.some((entry) => entry.change !== "unversioned"),
  });
  return { diff: diffText, structured: files };
}

function compareStatusPath(left: SvnStatusEntry, right: SvnStatusEntry): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

function svnDiffArgs(ignoreWhitespace: boolean): string[] {
  const args = ["diff", "--non-interactive", "--git"];
  if (ignoreWhitespace) {
    args.push("-x", "-w");
  }
  return args;
}

function parseSvnGitDiff(diffText: string): Map<string, ParsedDiffFile> {
  const files = new Map<string, ParsedDiffFile>();
  if (!diffText.trim()) {
    return files;
  }
  const sections = diffText.split(/^diff --git /m).slice(1);
  for (const section of sections) {
    const full = `diff --git ${section}`;
    const binary = section.includes("GIT binary patch") || section.includes("Cannot display:");
    const parsed = parseDiff(full)[0];
    if (!parsed || parsed.path === "unknown") {
      continue;
    }
    const path = toPortableRelativePath(parsed.path);
    if (binary) {
      files.set(path, {
        ...parsed,
        path,
        additions: 0,
        deletions: 0,
        hunks: [],
        status: "binary",
      });
      continue;
    }
    files.set(path, { ...parsed, path });
  }
  return files;
}

async function buildSvnDiffFiles(input: {
  root: string;
  entries: SvnStatusEntry[];
  parsed: Map<string, ParsedDiffFile>;
  ignoreWhitespace: boolean;
  diffWasTruncated: boolean;
}): Promise<ParsedDiffFile[]> {
  const files: ParsedDiffFile[] = [];
  let serializedBytes = Buffer.byteLength("[]", "utf8");
  const sorted = [...input.entries].sort(compareStatusPath);
  for (const entry of sorted) {
    const file = await fileForEntry(input.root, entry, input.parsed, input.diffWasTruncated);
    const whitespaceOnly =
      input.ignoreWhitespace &&
      entry.change === "modified" &&
      file.hunks.length === 0 &&
      file.status !== "binary";
    if (whitespaceOnly) {
      continue;
    }
    const separatorBytes = files.length > 0 ? 1 : 0;
    const fileBytes = Buffer.byteLength(JSON.stringify(file), "utf8");
    if (serializedBytes + separatorBytes + fileBytes > CHECKOUT_DIFF_MAX_STRUCTURED_BYTES) {
      const placeholder = placeholderFile(file, "too_large");
      const placeholderBytes = Buffer.byteLength(JSON.stringify(placeholder), "utf8");
      if (
        serializedBytes + separatorBytes + placeholderBytes >
        CHECKOUT_DIFF_MAX_STRUCTURED_BYTES
      ) {
        break;
      }
      files.push(placeholder);
      serializedBytes += separatorBytes + placeholderBytes;
      continue;
    }
    files.push(file);
    serializedBytes += separatorBytes + fileBytes;
  }
  return files;
}

async function fileForEntry(
  root: string,
  entry: SvnStatusEntry,
  parsed: Map<string, ParsedDiffFile>,
  diffWasTruncated: boolean,
): Promise<ParsedDiffFile & { change: SvnChangeKind }> {
  if (entry.change === "unversioned") {
    return readUnversionedEntry(root, entry.path);
  }
  const fromDiff = parsed.get(entry.path);
  if (!fromDiff) {
    return {
      path: entry.path,
      isNew: entry.change === "added",
      isDeleted: entry.change === "deleted",
      additions: 0,
      deletions: 0,
      hunks: [],
      change: entry.change,
      ...(diffWasTruncated ? { status: "too_large" as const } : {}),
    };
  }
  return {
    ...fromDiff,
    path: entry.path,
    isNew: entry.change === "added",
    isDeleted: entry.change === "deleted",
    change: entry.change,
  };
}

function placeholderFile(
  file: ParsedDiffFile & { change: SvnChangeKind },
  status: "too_large",
): ParsedDiffFile & { change: SvnChangeKind } {
  return {
    path: file.path,
    isNew: file.isNew,
    isDeleted: file.isDeleted,
    additions: 0,
    deletions: 0,
    hunks: [],
    status,
    change: file.change,
  };
}

async function readUnversionedEntry(
  root: string,
  relativePath: string,
): Promise<ParsedDiffFile & { change: "unversioned" }> {
  const absolute = resolve(root, relativePath);
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(absolute);
  } catch {
    return emptyUnversioned(relativePath);
  }
  if (!metadata.isFile()) {
    return emptyUnversioned(relativePath);
  }
  if (metadata.size > UNVERSIONED_MAX_BYTES) {
    return { ...emptyUnversioned(relativePath), status: "too_large" };
  }
  if (await isBinaryFile(absolute)) {
    return { ...emptyUnversioned(relativePath), status: "binary" };
  }
  const text = await readFile(absolute, "utf8");
  const lines = text.length === 0 ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return {
    path: relativePath,
    isNew: true,
    isDeleted: false,
    additions: lines.length,
    deletions: 0,
    change: "unversioned",
    hunks:
      lines.length === 0
        ? []
        : [
            {
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: lines.length,
              lines: [
                { type: "header", content: `@@ -0,0 +1,${lines.length} @@` },
                ...lines.map((line) => ({ type: "add" as const, content: line })),
              ],
            },
          ],
  };
}

function emptyUnversioned(path: string): ParsedDiffFile & { change: "unversioned" } {
  return {
    path,
    isNew: true,
    isDeleted: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    change: "unversioned",
  };
}

async function isBinaryFile(absolutePath: string): Promise<boolean> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      return false;
    }
    let suspicious = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      const byte = buffer[index];
      if (byte === 0) {
        return true;
      }
      if (byte < 7 || (byte > 14 && byte < 32) || byte === 127) {
        suspicious += 1;
      }
    }
    return suspicious / bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}

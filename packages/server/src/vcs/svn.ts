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

interface CachedDiff {
  statusDigest: string;
  result: CheckoutDiffResult;
}

export interface SvnStatusCacheOptions {
  now?: () => number;
  ttlMs?: number;
}

export interface SvnStatusCache {
  read(key: string, load: () => Promise<string>): Promise<string>;
  clear(): void;
}

/**
 * One in-flight `svn status` per root. The TTL starts when the command
 * finishes: stamping it at launch made a multi-second status already expired
 * by the time it was stored, so the diff in the same refresh ran it again.
 */
export function createSvnStatusCache(options: SvnStatusCacheOptions = {}): SvnStatusCache {
  const ttlMs = options.ttlMs ?? STATUS_CACHE_MS;
  const cached = new Map<string, CachedStatus>();
  const inflight = new Map<string, Promise<string>>();
  const now = options.now;

  function currentTime(): number {
    return now ? now() : Date.now();
  }

  function read(key: string, load: () => Promise<string>): Promise<string> {
    const hit = cached.get(key);
    if (hit && currentTime() - hit.at < ttlMs) {
      return Promise.resolve(hit.xml);
    }
    const pending = inflight.get(key);
    if (pending) {
      return pending;
    }
    let tracked: Promise<string> | null = null;
    const promise = load()
      .then((xml) => {
        cached.set(key, { at: currentTime(), xml });
        return xml;
      })
      .finally(() => {
        if (tracked !== null && inflight.get(key) === tracked) {
          inflight.delete(key);
        }
      });
    tracked = promise;
    inflight.set(key, promise);
    return promise;
  }

  function clear(): void {
    cached.clear();
    inflight.clear();
  }

  return { read, clear };
}

const statusCache = createSvnStatusCache();
const identityByRoot = new Map<string, SvnWorkingCopy>();
const diffByKey = new Map<string, CachedDiff>();

export function clearSvnStatusCache(): void {
  statusCache.clear();
  identityByRoot.clear();
  diffByKey.clear();
}

export async function readSvnStatusXml(root: string): Promise<string> {
  return statusCache.read(root, () =>
    runSvnCommand("svn", ["status", "--non-interactive", "--ignore-externals", "--xml"], {
      cwd: root,
      timeoutMs: STATUS_TIMEOUT_MS,
      maxBuffer: STATUS_MAX_BUFFER,
    }),
  );
}

interface SvnRevisionInfo {
  versionRaw: string;
  infoXml: string;
}

/** Status XML from the same refresh. Null when `svn status` failed. */
export interface SvnWorkingCopyRound {
  workingCopy: SvnWorkingCopy;
  statusXml: string | null;
}

export async function readSvnWorkingCopy(root: string): Promise<SvnWorkingCopy> {
  const round = await readSvnWorkingCopyRound(root);
  return round.workingCopy;
}

export async function readSvnWorkingCopyRound(root: string): Promise<SvnWorkingCopyRound> {
  const cached = identityByRoot.get(root);
  if (cached) {
    const statusXml = await readSvnStatusXml(root).catch(() => null);
    if (statusXml === null || digestStatus(statusXml) === cached.statusDigest) {
      return { workingCopy: cached, statusXml };
    }
    const revision = await loadRevisionAndInfo(root);
    const workingCopy = assembleWorkingCopy(root, revision, statusXml);
    identityByRoot.set(root, workingCopy);
    return { workingCopy, statusXml };
  }

  const [statusXml, revision] = await Promise.all([
    readSvnStatusXml(root).catch(() => null),
    loadRevisionAndInfo(root),
  ]);
  const workingCopy = assembleWorkingCopy(root, revision, statusXml ?? "");
  if (statusXml !== null) {
    identityByRoot.set(root, workingCopy);
  }
  return { workingCopy, statusXml };
}

async function loadRevisionAndInfo(root: string): Promise<SvnRevisionInfo> {
  const [versionRaw, infoXml] = await Promise.all([
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
  ]);
  return { versionRaw, infoXml };
}

function assembleWorkingCopy(
  root: string,
  revision: SvnRevisionInfo,
  statusXml: string,
): SvnWorkingCopy {
  const info = parseSvnInfoXml(revision.infoXml);
  const fromVersion = formatSvnRevisionLabel(revision.versionRaw);
  const fromInfo = info.revision ? formatSvnRevisionLabel(info.revision) : null;
  return {
    kind: "svn",
    root,
    label: fromVersion ?? fromInfo ?? "svn",
    url: info.url,
    statusDigest: digestStatus(statusXml),
  };
}

function digestStatus(xml: string): string {
  return createHash("sha256").update(xml).digest("hex");
}

interface SvnDiffRead {
  root: string;
  ignoreWhitespace: boolean;
  includeStructured: boolean;
  /** Status XML already read for this refresh. Skips a second `svn status`. */
  statusXml?: string;
}

export function svnDiffStat(
  files: readonly ParsedDiffFile[],
): { additions: number; deletions: number } | null {
  if (files.length === 0) {
    return null;
  }
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

export async function readSvnCheckoutDiff(input: SvnDiffRead): Promise<CheckoutDiffResult> {
  const statusXml =
    input.statusXml === undefined ? await readSvnStatusXml(input.root) : input.statusXml;
  const statusDigest = digestStatus(statusXml);
  const cacheKey = diffCacheKey(input);
  const cached = diffByKey.get(cacheKey);
  if (cached && cached.statusDigest === statusDigest) {
    return cached.result;
  }
  const result = await readSvnCheckoutDiffUncached(input, statusXml);
  diffByKey.set(cacheKey, { statusDigest, result });
  return result;
}

function diffCacheKey(input: SvnDiffRead): string {
  const whitespace = input.ignoreWhitespace ? "ws" : "exact";
  const structured = input.includeStructured ? "structured" : "text";
  return `${input.root}\0${whitespace}\0${structured}`;
}

async function readSvnCheckoutDiffUncached(
  input: SvnDiffRead,
  statusXml: string,
): Promise<CheckoutDiffResult> {
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

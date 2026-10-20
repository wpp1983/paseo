import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { runSvnCommand } = vi.hoisted(() => ({
  runSvnCommand: vi.fn(),
}));

vi.mock("./svn-command.js", () => ({
  runSvnCommand,
  isSvnOutputTooLarge: () => false,
}));

import {
  clearSvnStatusCache,
  createSvnStatusCache,
  readSvnCheckoutDiff,
  readSvnWorkingCopyRound,
} from "./svn.js";

const ROOT = "/work/driver_project";
const INFO_XML =
  '<info><entry revision="12"><url>https://svn.example/repo/trunk</url></entry></info>';
const CLEAN_STATUS = '<status><target path="."></target></status>';
const DIRTY_STATUS =
  '<status><target path="."><entry path="notes.txt"><wc-status item="modified" props="none"></wc-status></entry></target></status>';

function commandCalls(kind: "status" | "info" | "diff" | "svnversion"): number {
  return runSvnCommand.mock.calls.filter((call) => {
    const [command, args] = call;
    if (typeof command !== "string" || !Array.isArray(args)) {
      return false;
    }
    if (kind === "svnversion") {
      return command === "svnversion";
    }
    return command === "svn" && args[0] === kind;
  }).length;
}

function installCommands(statusXml: () => string): void {
  runSvnCommand.mockImplementation(async (command: string, args: readonly string[]) => {
    if (command === "svnversion") {
      return "12\n";
    }
    if (args[0] === "info") {
      return INFO_XML;
    }
    if (args[0] === "status") {
      return statusXml();
    }
    if (args[0] === "diff") {
      return "";
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  });
}

describe("svn status cache", () => {
  test("stamps the cache when the command finishes", async () => {
    let nowMs = 0;
    const cache = createSvnStatusCache({ now: () => nowMs, ttlMs: 1_000 });
    let loads = 0;
    await cache.read("wc", async () => {
      loads += 1;
      nowMs += 3_000;
      return "<status />";
    });
    nowMs += 500;
    await cache.read("wc", async () => {
      loads += 1;
      return "fresh";
    });
    expect(loads).toBe(1);
    nowMs += 500;
    await cache.read("wc", async () => {
      loads += 1;
      return "fresh";
    });
    expect(loads).toBe(2);
  });

  test("overlapping reads share one status command", async () => {
    const cache = createSvnStatusCache({ now: () => 0, ttlMs: 1_000 });
    let release: (xml: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const first = cache.read("wc", () => {
      loads += 1;
      return gate;
    });
    const second = cache.read("wc", () => {
      loads += 1;
      return gate;
    });
    release("<status />");
    await expect(Promise.all([first, second])).resolves.toEqual(["<status />", "<status />"]);
    expect(loads).toBe(1);
  });

  test("does not cache a failed status command", async () => {
    const cache = createSvnStatusCache({ now: () => 0, ttlMs: 1_000 });
    let loads = 0;
    await expect(
      cache.read("wc", async () => {
        loads += 1;
        throw new Error("svn failed");
      }),
    ).rejects.toThrow("svn failed");
    await cache.read("wc", async () => {
      loads += 1;
      return "<status />";
    });
    expect(loads).toBe(2);
  });
});

describe("svn refresh round", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearSvnStatusCache();
    runSvnCommand.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("reuses one status result and skips revision commands when status is unchanged", async () => {
    installCommands(() => CLEAN_STATUS);
    const first = await readSvnWorkingCopyRound(ROOT);
    expect(first.workingCopy.label).toBe("r12");
    expect(first.statusXml).toBe(CLEAN_STATUS);
    await readSvnCheckoutDiff({
      root: ROOT,
      ignoreWhitespace: false,
      includeStructured: true,
      statusXml: first.statusXml ?? undefined,
    });
    expect(commandCalls("status")).toBe(1);
    expect(commandCalls("svnversion")).toBe(1);
    expect(commandCalls("info")).toBe(1);
    expect(commandCalls("diff")).toBe(1);

    const cached = await readSvnWorkingCopyRound(ROOT);
    expect(commandCalls("status")).toBe(1);
    expect(cached.workingCopy.label).toBe("r12");

    await vi.advanceTimersByTimeAsync(2_000);
    const second = await readSvnWorkingCopyRound(ROOT);
    await readSvnCheckoutDiff({
      root: ROOT,
      ignoreWhitespace: false,
      includeStructured: true,
      statusXml: second.statusXml ?? undefined,
    });
    expect(commandCalls("status")).toBe(2);
    expect(commandCalls("svnversion")).toBe(1);
    expect(commandCalls("info")).toBe(1);
    expect(commandCalls("diff")).toBe(1);
  });

  test("refreshes revision and diff when status output changes", async () => {
    let statusXml = CLEAN_STATUS;
    installCommands(() => statusXml);
    const first = await readSvnWorkingCopyRound(ROOT);
    await readSvnCheckoutDiff({
      root: ROOT,
      ignoreWhitespace: false,
      includeStructured: true,
      statusXml: first.statusXml ?? undefined,
    });

    statusXml = DIRTY_STATUS;
    await vi.advanceTimersByTimeAsync(2_000);
    const second = await readSvnWorkingCopyRound(ROOT);
    expect(second.workingCopy.statusDigest).not.toBe(first.workingCopy.statusDigest);
    await readSvnCheckoutDiff({
      root: ROOT,
      ignoreWhitespace: false,
      includeStructured: true,
      statusXml: second.statusXml ?? undefined,
    });
    expect(commandCalls("status")).toBe(2);
    expect(commandCalls("svnversion")).toBe(2);
    expect(commandCalls("info")).toBe(2);
    expect(commandCalls("diff")).toBe(2);

    await readSvnCheckoutDiff({
      root: ROOT,
      ignoreWhitespace: true,
      includeStructured: true,
      statusXml: second.statusXml ?? undefined,
    });
    expect(commandCalls("diff")).toBe(3);
    expect(commandCalls("status")).toBe(2);
  });
});

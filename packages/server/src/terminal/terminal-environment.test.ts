import { describe, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import { buildTerminalEnvironment } from "./terminal.js";

const TOUCHED_ENV_KEYS = [
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "No_Color",
  "Force_Color",
  "Ci",
  "Term",
  "ColorTerm",
  "Term_Program",
  "no_color",
  "force_color",
  "ci",
] as const;

function envNamesEqual(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function matchingEnvKeys(keys: readonly string[]): string[] {
  return Object.keys(process.env).filter((key) =>
    keys.some((candidate) => envNamesEqual(key, candidate)),
  );
}

function readMatchingEnv(keys: readonly string[]): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const key of matchingEnvKeys(keys)) {
    const value = process.env[key];
    if (value !== undefined) {
      entries.push([key, value]);
    }
  }
  return entries;
}

function deleteMatchingEnv(keys: readonly string[]): void {
  for (const key of matchingEnvKeys(keys)) {
    delete process.env[key];
  }
}

function applyProcessEnv(overrides: Record<string, string>): () => void {
  const keys = [...TOUCHED_ENV_KEYS, ...Object.keys(overrides)];
  const previous = readMatchingEnv(keys);
  deleteMatchingEnv(keys);
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  return () => {
    deleteMatchingEnv(keys);
    for (const [key, value] of previous) {
      process.env[key] = value;
    }
  };
}

function applyPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: platform, writable: true });
  return () => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  };
}

function terminalEnv(env: Record<string, string> = {}): Record<string, string> {
  return buildTerminalEnvironment({
    shell: "bash",
    env,
    paseoCliBinDir: null,
    paseoHookCliPath: null,
  });
}

describe("buildTerminalEnvironment color", () => {
  it("drops inherited color suppression and advertises a truecolor terminal", () => {
    const restoreEnv = applyProcessEnv({
      CI: "true",
      COLORTERM: "dumb",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      TERM: "dumb",
    });
    try {
      const env = terminalEnv({
        HOME: "/tmp/paseo-home",
        PASEO_KEEP: "yes",
        PATH: "/usr/bin",
      });

      expect(env.NO_COLOR).toBeUndefined();
      expect(env.FORCE_COLOR).toBeUndefined();
      expect(env.CI).toBeUndefined();
      expect(env.TERM).toBe("xterm-256color");
      expect(env.TERM_PROGRAM).toBe("kitty");
      expect(env.COLORTERM).toBe("truecolor");
      expect(env.HOME).toBe("/tmp/paseo-home");
      expect(env.PASEO_KEEP).toBe("yes");
      expect(env.PATH).toBe("/usr/bin");
    } finally {
      restoreEnv();
    }
  });

  it("lets an explicit per-terminal env restore color suppression", () => {
    const restoreEnv = applyProcessEnv({
      CI: "true",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      TERM: "dumb",
    });
    try {
      const env = terminalEnv({
        CI: "1",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      });

      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBe("0");
      expect(env.CI).toBe("1");
      expect(env.TERM).toBe("xterm-256color");
      expect(env.COLORTERM).toBe("truecolor");
      expect(env.TERM_PROGRAM).toBe("kitty");
    } finally {
      restoreEnv();
    }
  });

  it.skipIf(isPlatform("win32"))("keeps differently cased color variables on POSIX", () => {
    const restoreEnv = applyProcessEnv({
      CI: "true",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ci: "1",
      force_color: "0",
      no_color: "1",
    });
    try {
      const env = terminalEnv();

      expect(env.NO_COLOR).toBeUndefined();
      expect(env.FORCE_COLOR).toBeUndefined();
      expect(env.CI).toBeUndefined();
      expect(env.no_color).toBe("1");
      expect(env.force_color).toBe("0");
      expect(env.ci).toBe("1");
    } finally {
      restoreEnv();
    }
  });

  it("strips case-variant inherited color suppression on Windows", () => {
    const restorePlatform = applyPlatform("win32");
    const restoreEnv = applyProcessEnv({
      Ci: "true",
      ColorTerm: "dumb",
      Force_Color: "0",
      No_Color: "1",
      Term: "dumb",
      Term_Program: "not-kitty",
    });
    try {
      const env = terminalEnv({ PATH: "C:\\Windows\\System32" });

      expect(env.No_Color).toBeUndefined();
      expect(env.NO_COLOR).toBeUndefined();
      expect(env.Force_Color).toBeUndefined();
      expect(env.FORCE_COLOR).toBeUndefined();
      expect(env.Ci).toBeUndefined();
      expect(env.CI).toBeUndefined();
      expect(env.Term).toBeUndefined();
      expect(env.ColorTerm).toBeUndefined();
      expect(env.Term_Program).toBeUndefined();
      expect(env.TERM).toBe("xterm-256color");
      expect(env.COLORTERM).toBe("truecolor");
      expect(env.TERM_PROGRAM).toBe("kitty");
      expect(env.PATH).toBe("C:\\Windows\\System32");
    } finally {
      restoreEnv();
      restorePlatform();
    }
  });

  it("lets per-terminal env win over differently cased inherited suppression on Windows", () => {
    const restorePlatform = applyPlatform("win32");
    const restoreEnv = applyProcessEnv({
      Ci: "true",
      Force_Color: "0",
      No_Color: "1",
    });
    try {
      const env = terminalEnv({
        CI: "1",
        FORCE_COLOR: "1",
        NO_COLOR: "1",
      });

      expect(env.No_Color).toBeUndefined();
      expect(env.Force_Color).toBeUndefined();
      expect(env.Ci).toBeUndefined();
      expect(env.NO_COLOR).toBe("1");
      expect(env.FORCE_COLOR).toBe("1");
      expect(env.CI).toBe("1");
    } finally {
      restoreEnv();
      restorePlatform();
    }
  });
});

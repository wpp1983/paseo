import { execFile } from "node:child_process";
import { createExternalCommandProcessEnv } from "../server/paseo-env.js";

export class SvnCommandError extends Error {
  readonly code: "missing" | "timeout" | "failed";

  constructor(message: string, code: "missing" | "timeout" | "failed") {
    super(message);
    this.name = "SvnCommandError";
    this.code = code;
  }
}

export function isSvnMissing(error: unknown): boolean {
  return error instanceof SvnCommandError && error.code === "missing";
}

export function isSvnOutputTooLarge(error: unknown): boolean {
  return error instanceof SvnCommandError && error.message.includes("maxBuffer");
}

/**
 * Runs an SVN binary already on PATH. No shell, so Windows paths and spaces
 * stay arguments. `windowsHide` keeps `svn.exe` from flashing a console.
 */
export function runSvnCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; maxBuffer: number },
): Promise<string> {
  const env = createExternalCommandProcessEnv(command, process.env);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        encoding: "utf8",
        env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const errno = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (errno.code === "ENOENT") {
          reject(new SvnCommandError(`${command} was not found on PATH`, "missing"));
          return;
        }
        if (errno.killed || errno.signal === "SIGTERM") {
          const verb = args[0] ?? command;
          reject(new SvnCommandError(`${command} ${verb} timed out`, "timeout"));
          return;
        }
        const detail = (stderr ?? "").trim() || errno.message;
        reject(new SvnCommandError(detail, "failed"));
      },
    );
  });
}

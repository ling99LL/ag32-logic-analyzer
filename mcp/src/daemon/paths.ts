import os from "node:os";
import path from "node:path";

export const DAEMON_PIPE_NAME = "ag32-logic-studio-v1";

export function daemonPipePath(): string {
  if (process.env.AG32_DAEMON_PIPE) return process.env.AG32_DAEMON_PIPE;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${DAEMON_PIPE_NAME}`;
  }
  return path.join(os.tmpdir(), `${DAEMON_PIPE_NAME}.sock`);
}

export function resolveDataDir(): string {
  if (process.env.AG32_DATA_DIR) return path.resolve(process.env.AG32_DATA_DIR);
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, "data");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "AG32 Logic Studio",
    );
  }
  return path.join(os.homedir(), ".local", "share", "AG32 Logic Studio");
}

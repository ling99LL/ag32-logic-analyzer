import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonClient, daemonReachable } from "../daemon/client.js";

test("daemon accepts desktop and MCP clients through a shared local pipe", async () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\ag32-logic-studio-test-${stamp}`
    : path.join(os.tmpdir(), `ag32-logic-studio-test-${stamp}.sock`);
  const dataDir = path.join(os.tmpdir(), `ag32-logic-studio-test-${stamp}`);
  process.env.AG32_DAEMON_PIPE = pipe;
  process.env.AG32_DATA_DIR = dataDir;

  const child = spawn(process.execPath, [path.resolve("dist/daemon/index.js")], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: { ...process.env, AG32_DAEMON_PIPE: pipe, AG32_DATA_DIR: dataDir },
    windowsHide: true,
  });

  try {
    await waitUntil(daemonReachable, 5000);
    const desktop = new DaemonClient({ role: "desktop", name: "test desktop", autoStart: false });
    const mcp = new DaemonClient({ role: "mcp", name: "test mcp", autoStart: false });
    await desktop.connect();
    await mcp.connect();
    const snapshot = await desktop.request<{ clients: unknown[]; device: { connected: boolean } }>("snapshot");
    assert.equal(snapshot.device.connected, false);
    assert.equal(snapshot.clients.length, 2);
    desktop.close();
    mcp.close();
  } finally {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    delete process.env.AG32_DAEMON_PIPE;
    delete process.env.AG32_DATA_DIR;
  }
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for test daemon");
}

// Pulse the AC7925B RES/RST line through the AG32 logic-analyzer MCP server.
//
// A bare reset (no BOOT strap): configure PIN_5 host_level, fire to assert
// RST low, hold ~200 ms, then reset to release RST high. The target reboots
// its application firmware normally. Use this to recover a wedged app
// (e.g. after a G1 hang) while preserving VM checkpoints for PREV_INFO.
//
// Usage: node scripts/ac7925b_rst_pulse.mjs [COM port]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const port = process.argv[2] ?? "COM33";

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const client = new Client({ name: "ac7925b-rst-pulse", version: "0.1.0" });
await client.connect(new (await import("@modelcontextprotocol/sdk/client/stdio.js")).StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
}));

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`MCP ${name} failed: ${JSON.stringify(result.content)}`);
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

async function appCdcPort() {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "@(Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue | Where-Object { $_.PNPDeviceID -match 'VID_3654' } | ForEach-Object { $_.DeviceID }) -join ','",
  ]);
  return stdout.trim();
}

try {
  await call("connect_device", { port });
  const hostLevel = { mode: "host_level", activeLevel: "low", idleLevel: "high", delayNs: 0, widthNs: 0 };
  const config = await call("configure_pin5_trigger_engine", hostLevel);
  const configValue = config.status?.config ?? config.config;
  if (configValue !== 10) {
    throw new Error(`host_level config encoded as ${configValue}, expected 10 (0x0A)`);
  }
  console.log("fire: RST low");
  await call("pin5_engine_control", { action: "fire" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log("reset: RST high");
  await call("pin5_engine_control", { action: "reset" });
  await call("disconnect_device");

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const cdc = await appCdcPort();
    if (cdc) {
      console.log(`application CDC back: ${cdc}`);
      await client.close();
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  console.log("application CDC did not return within 25 s");
  process.exit(1);
} finally {
  await client.close().catch(() => undefined);
}

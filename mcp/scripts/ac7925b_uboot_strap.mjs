// Force an AC7925B board into UBOOT through the AG32 logic-analyzer MCP server.
//
// Wiring (verified 2026-10-25, see fw repo doc/AC792N_COM22_FLASH.md): AG32
// PIN_5 -> AC7925B RES/RST, AG32 PIN_11 -> AC7925B BOOT. The documented strap
// holds RST low (PIN_5 host_level fire), drives BOOT low ~10 ms later, then
// releases RST high ~30 ms after fire while BOOT stays low, so the target
// boots UBOOT and Windows enumerates "WL83 UBOOT1.00".
//
// Everything is done through MCP tools: configure_pin5_trigger_engine performs
// the host_level fire/reset (0x89 02 / 0x89 04) and configure_pin11_static_level
// (firmware GEN_STATIC 0x8E) drives BOOT low / releases it. After UBOOT is
// enumerated the script releases BOOT again (the board pull-up then holds BOOT
// high) and verifies UBOOT stays online. It never starts a downloader itself.
//
// Usage: node scripts/ac7925b_uboot_strap.mjs [COM port] [attempts]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const port = process.argv[2] ?? "COM33";
const attempts = Number(process.argv[3] ?? 3);

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const client = new Client({ name: "ac7925b-uboot-strap", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));

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

async function ubootPresent() {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*UBOOT*' -and $_.Status -eq 'OK' } | Select-Object -First 1 -ExpandProperty FriendlyName",
  ]);
  return stdout.trim();
}

try {
  await call("connect_device", { port });
  console.log("device:", JSON.stringify(await call("get_device_info")));

  // Baseline: BOOT released (high via the board pull-up), PIN_5 engine idle high.
  await call("configure_pin11_static_level", { level: "off" });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`strap attempt ${attempt}/${attempts}: host_level fire, +10 ms BOOT low, +30 ms reset`);
    // Documented sequence (AC792N_COM22_FLASH.md, BOOT/RST hard-strap recovery):
    // PIN_5 host_level config 0x0A (active low, idle high, square off), delay=0,
    // width=0; fire drives RST low and holds it; BOOT goes low ~10 ms later;
    // reset releases RST high ~30 ms after fire while BOOT stays low.
    const hostLevel = { mode: "host_level", activeLevel: "low", idleLevel: "high", delayNs: 0, widthNs: 0 };
    const config = await call("configure_pin5_trigger_engine", hostLevel);
    const configValue = config.status?.config ?? config.config;
    if (configValue !== 10) {
      throw new Error(`host_level config encoded as ${configValue}, expected 10 (0x0A) per the flash document`);
    }
    const fired = await call("pin5_engine_control", { action: "fire" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const boot = await call("configure_pin11_static_level", { level: "low" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const released = await call("pin5_engine_control", { action: "reset" });
    console.log("fired:", JSON.stringify(fired.status ?? fired));
    console.log("boot:", JSON.stringify(boot));
    console.log("released:", JSON.stringify(released.status ?? released));
    // No further reads on this connection: the fire sequence can leave an
    // asynchronous PIN_5 status frame in the stream. Disconnect resets it.
    await call("disconnect_device");

    let uboot = "";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      uboot = await ubootPresent();
      if (uboot) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    if (!uboot) {
      console.log("UBOOT did not enumerate; the board rebooted normally. Settling before retry...");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await call("connect_device", { port });
      await call("configure_pin11_static_level", { level: "off" });
      continue;
    }

    console.log(`UBOOT enumerated: ${uboot}`);
    // Release BOOT before any download attempt; the pull-up holds BOOT high.
    await call("connect_device", { port });
    await call("configure_pin11_static_level", { level: "off" });
    await call("disconnect_device");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const still = await ubootPresent();
    if (!still) {
      console.log("UBOOT disappeared after BOOT release. Do NOT start the downloader.");
      process.exit(1);
    }
    console.log("BOOT released; UBOOT still online. Ready for isd_download.exe.");
    await client.close();
    process.exit(0);
  }

  console.log("All strap attempts exhausted without UBOOT enumeration.");
  process.exit(1);
} finally {
  await client.close().catch(() => undefined);
}

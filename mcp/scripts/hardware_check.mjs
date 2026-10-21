import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const command = process.execPath;
const args = [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")];
const client = new Client({ name: "ag32-hardware-check", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command, args }));

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  console.log(`\n=== ${name} ===`);
  console.log(text);
}
await call("list_devices", {});
const listResult = await client.callTool({ name: "list_devices", arguments: {} });
const list = JSON.parse(listResult.content[0].text);
const selected = list.selected;
if (!selected) {
  console.log("\nNo AG32 Logic device found; hardware acceptance is not available.");
} else {
  await call("connect_device", { port: selected });
  await call("get_device_info", {});
  await call("configure_pin5_square_wave", { frequencyHz: 100000 });
  await call("capture", { sampleRateHz: 100000000, sampleCount: 8192 });
  await call("run_loopback_check", {});
  await call("disconnect_device", {});
}

await client.close();

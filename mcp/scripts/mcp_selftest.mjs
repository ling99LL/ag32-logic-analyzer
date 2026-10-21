import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const client = new Client({ name: "ag32-mcp-selftest", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));

const tools = await client.listTools();
const resources = await client.listResources();
const prompts = await client.listPrompts();
const requiredTools = [
  "list_devices",
  "connect_device",
  "disconnect_device",
  "get_device_info",
  "capture",
  "configure_pin5_square_wave",
  "configure_pin5_trigger_engine",
  "configure_pin11_waveform",
  "run_loopback_check",
];
const missingTools = requiredTools.filter((name) => !tools.tools.some((tool) => tool.name === name));
if (missingTools.length > 0) throw new Error(`Missing MCP tools: ${missingTools.join(", ")}`);
if (!resources.resources.some((resource) => resource.uri === "ag32-logic://guide/device-debugging")) {
  throw new Error("Missing device debugging resource");
}
if (!prompts.prompts.some((prompt) => prompt.name === "ag32_logic_debugging")) {
  throw new Error("Missing AG32 debugging prompt");
}

console.log(`MCP self-test PASS: ${tools.tools.length} tools, ${resources.resources.length} resources, ${prompts.prompts.length} prompts`);
await client.close();

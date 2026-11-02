import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DaemonClient } from "./daemon/client.js";
import {
  MAX_SAMPLE_COUNT,
  MAX_SAMPLE_RATE_HZ,
  MIN_SAMPLE_COUNT,
  MIN_SAMPLE_RATE_HZ,
  PIN11_RATE_CAP_MAX_HZ,
  PIN11_RATE_CAP_MIN_HZ,
  PIN5_SQUARE_MAX_HZ,
  PIN5_SQUARE_MIN_HZ,
  PIN5_TRIGGER_MODES,
  WAVE_TYPES,
} from "./protocol.js";
import type {
  CaptureFrame,
  CaptureTrigger,
  DeviceListResult,
  DeviceState,
  Pin5EngineConfig,
  Pin11Config,
  SynchronizedCaptureGroup,
} from "./shared/types.js";

const server = new McpServer(
  { name: "ag32-logic-studio-mcp", version: "0.2.0" },
  {
    instructions:
      "Control up to four AG32VF303 logic analyzers and their signal generators through the shared AG32 Logic Studio daemon. Existing tools use the active device unless deviceId is supplied. capture_synchronized coordinates multiple devices from the host and is not a hardware-timed common-trigger capture. CH1-CH4 are inputs on PIN_7-10. PIN_5 is the digital output and PIN_11 is the DAC analog output. This server does not build or flash firmware.",
  },
);

const daemon = new DaemonClient({
  role: "mcp",
  name: "AG32 Logic Studio MCP",
  autoStart: true,
});

const portSchema = z.string().min(1).describe("Serial port path, for example COM33.");
const channelSchema = z.enum(["CH1", "CH2", "CH3", "CH4"]);
const deviceIdSchema = z.string().min(1).optional()
  .describe("Connected deviceId. Omit it to address the current active device.");

server.tool(
  "list_devices",
  "List serial ports and identify AG32 Logic devices by SUMP ID 1ALS.",
  { preferPort: portSchema.optional() },
  async ({ preferPort }) => {
    const result = await daemon.request<DeviceListResult>("list_devices", { preferPort });
    return textResult(result);
  },
);

server.tool("connect_device", "Connect one AG32 Logic USB CDC port. Up to four devices can stay connected; deviceIndex 1-4 also selects the one-hot LED identity.", {
  port: portSchema,
  deviceIndex: z.number().int().min(1).max(4).optional()
    .describe("Optional one-hot LED identity: device 1 lights LED1, device 4 lights LED4."),
  alias: z.string().min(1).max(32).optional().describe("Optional human-readable device alias."),
}, async ({ port, deviceIndex, alias }) => {
  const device = await daemon.request<DeviceState>("connect", { port, deviceIndex, alias });
  return textResult(device);
});

server.tool("disconnect_device", "Close one AG32 Logic serial connection.", {
  deviceId: deviceIdSchema,
}, async ({ deviceId }) => {
  const result = await daemon.request("disconnect", { deviceId });
  return textResult(result);
});

server.tool("disconnect_all_devices", "Close every connected AG32 Logic serial connection.", {}, async () => {
  const result = await daemon.request("disconnect_all");
  return textResult(result);
});

server.tool("set_active_device", "Select which connected device is used by calls that omit deviceId.", {
  deviceId: z.string().min(1),
}, async ({ deviceId }) => {
  const device = await daemon.request<DeviceState>("set_active_device", { deviceId });
  return textResult(device);
});

server.tool("get_device_info", "Read firmware, PIN_11 and PIN_5 status for one device.", {
  deviceId: deviceIdSchema,
}, async ({ deviceId }) => {
  const device = await daemon.request<DeviceState>("get_device_info", { deviceId });
  return textResult({
    deviceId: device.deviceId,
    alias: device.alias,
    identity: device.identity,
    identityStable: device.identityStable,
    port: device.port,
    connectedAt: device.connectedAt,
    info: device.info,
    pin5: device.pin5,
    pin11Static: device.pin11Static,
    deviceIndex: device.deviceIndex,
  });
});

server.tool(
  "capture",
  "Capture CH1-CH4 through the shared daemon and persist samples.bin, capture.vcd and manifest.json.",
  {
    deviceId: deviceIdSchema,
    sampleRateHz: z
      .number()
      .int()
      .min(MIN_SAMPLE_RATE_HZ)
      .max(MAX_SAMPLE_RATE_HZ)
      .describe("Sampling rate in Hz. The hardware clock is 100 MHz and the divider produces discrete rates."),
    sampleCount: z.number().int().min(MIN_SAMPLE_COUNT).max(MAX_SAMPLE_COUNT).default(8192)
      .describe("Number of samples. Values are normalized down to a multiple of 4."),
    pretriggerPercent: z.number().min(0).max(99).optional()
      .describe("Optional pre-trigger percentage. Zero gives a pure post-trigger capture."),
    trigger: z
      .object({
        channels: z.array(channelSchema).min(1),
        highChannels: z.array(channelSchema).min(1),
      })
      .optional()
      .describe("Legacy level trigger. Channels absent from highChannels trigger low."),
    triggerMode: z.enum(["immediate", "level", "edge"]).optional(),
    edges: z
      .array(z.object({ channel: channelSchema, direction: z.enum(["rising", "falling"]) }))
      .optional()
      .describe("Edge trigger selections. Any selected edge triggers the capture."),
  },
  async ({ deviceId, sampleRateHz, sampleCount, pretriggerPercent, trigger, triggerMode, edges }) => {
    const normalizedTrigger = buildTrigger(triggerMode, trigger, edges);
    const frame = await daemon.request<CaptureFrame>("capture", {
      deviceId,
      sampleRateHz,
      sampleCount,
      pretriggerPercent: pretriggerPercent ?? 0,
      trigger: normalizedTrigger,
      persist: true,
    });
    return textResult({
      requestedSampleRateHz: frame.requestedSampleRateHz,
      actualSampleRateHz: frame.actualSampleRateHz,
      divider: frame.divider,
      sampleCount: frame.sampleCount,
      pretriggerPercent: frame.pretriggerPercent,
      trigger: frame.trigger,
      activeChannels: frame.activeChannels,
      channels: frame.channels,
      physicalWaveform: frame.activeChannels.length > 0 ? "ACTIVE" : "NO_ACTIVITY",
      artifacts: frame.artifacts,
    });
  },
);

server.tool(
  "capture_synchronized",
  "Capture from two to four connected devices in parallel. This is host-coordinated software synchronization, not a shared hardware clock or common external trigger.",
  {
    deviceIds: z.array(z.string().min(1)).min(1).max(4).optional()
      .describe("Connected deviceIds to capture. Omit to use all connected devices."),
    sampleRateHz: z.number().int().min(MIN_SAMPLE_RATE_HZ).max(MAX_SAMPLE_RATE_HZ),
    sampleCount: z.number().int().min(MIN_SAMPLE_COUNT).max(MAX_SAMPLE_COUNT).default(8192),
    pretriggerPercent: z.number().min(0).max(99).optional(),
    trigger: z
      .object({
        channels: z.array(channelSchema).min(1),
        highChannels: z.array(channelSchema).min(1),
      })
      .optional(),
    triggerMode: z.enum(["immediate", "level", "edge"]).optional(),
    edges: z
      .array(z.object({ channel: channelSchema, direction: z.enum(["rising", "falling"]) }))
      .optional(),
  },
  async ({ deviceIds, sampleRateHz, sampleCount, pretriggerPercent, trigger, triggerMode, edges }) => {
    const group = await daemon.request<SynchronizedCaptureGroup>("capture_synchronized", {
      deviceIds,
      request: {
        sampleRateHz,
        sampleCount,
        pretriggerPercent: pretriggerPercent ?? 0,
        trigger: buildTrigger(triggerMode, trigger, edges),
        persist: true,
      },
    });
    return textResult({
      ...group,
      frames: group.frames.map((entry) => ({
        deviceId: entry.deviceId,
        alias: entry.alias,
        hostReadyAt: entry.hostReadyAt,
        hostRequestAt: entry.hostRequestAt,
        hostStartAt: entry.hostStartAt,
        hostCompleteAt: entry.hostCompleteAt,
        frame: summarizeFrame(entry.frame),
      })),
    });
  },
);

server.tool(
  "configure_pin5_square_wave",
  "Configure PIN_5 as a 50% duty-cycle digital square wave.",
  {
    deviceId: deviceIdSchema,
    frequencyHz: z.number().int().min(PIN5_SQUARE_MIN_HZ).max(PIN5_SQUARE_MAX_HZ)
      .describe("Frequency in Hz from 1 Hz to 100 MHz."),
  },
  async ({ deviceId, frequencyHz }) => {
    const device = await daemon.request<DeviceState>("configure_pin5_square", { deviceId, frequencyHz });
    return textResult({ pin: "PIN_5", frequencyHz, status: device.pin5 });
  },
);

server.tool(
  "configure_pin5_trigger_engine",
  "Configure the PIN_5 delayed or host-triggered level and pulse engine.",
  {
    deviceId: deviceIdSchema,
    mode: z.enum(PIN5_TRIGGER_MODES).describe("delayed_level, delayed_pulse, host_level, or host_pulse."),
    activeLevel: z.enum(["high", "low"]).default("high"),
    idleLevel: z.enum(["high", "low"]).default("low"),
    delayNs: z.number().min(0).max(42_900_000_000).default(0),
    widthNs: z.number().min(0).max(42_900_000_000).default(0),
    action: z.enum(["arm", "fire", "reset"]).optional(),
  },
  async (input) => {
    const device = await daemon.request<DeviceState>("configure_pin5_engine", input as Pin5EngineConfig & {
      deviceId?: string;
    });
    return textResult({ pin: "PIN_5", requested: input, status: device.pin5 });
  },
);

server.tool(
  "pin5_engine_control",
  "Send only the PIN_5 engine control word (arm/fire/reset) without rewriting config, delay or width.",
  {
    deviceId: deviceIdSchema,
    action: z.enum(["arm", "fire", "reset"]).describe("Single engine control action to send."),
  },
  async ({ deviceId, action }) => {
    const device = await daemon.request<DeviceState>("pin5_engine_control", { deviceId, action });
    return textResult({ pin: "PIN_5", action, status: device.pin5 });
  },
);

server.tool(
  "configure_pin11_waveform",
  "Configure PIN_11 DAC0 waveform, frequency, amplitude and output enable.",
  {
    deviceId: deviceIdSchema,
    waveform: z.enum(WAVE_TYPES).describe("sine, square, sawtooth, or triangle."),
    frequencyHz: z.number().int().min(1).max(PIN11_RATE_CAP_MAX_HZ)
      .describe("Requested frequency. The daemon clamps it to the DAC rate cap for the selected waveform."),
    amplitudePercent: z.number().int().min(1).max(100).default(100),
    enabled: z.boolean().default(false).describe("PIN_11 output enable. Defaults to false for safety."),
    rateCapHz: z.number().int().min(PIN11_RATE_CAP_MIN_HZ).max(PIN11_RATE_CAP_MAX_HZ).optional(),
  },
  async (input) => {
    const device = await daemon.request<DeviceState>("configure_pin11", input as Pin11Config & {
      deviceId?: string;
    });
    return textResult({ pin: "PIN_11", info: device.info, staticMode: device.pin11Static });
  },
);

server.tool(
  "configure_pin11_static_level",
  "Drive PIN_11 to off/high-Z, static low, or static high through GEN_STATIC.",
  {
    deviceId: deviceIdSchema,
    level: z.enum(["off", "low", "high"]).describe("off = DAC0 off, low = static low, high = full-scale high."),
  },
  async ({ deviceId, level }) => {
    const mode = { off: 0, low: 1, high: 2 } as const;
    const device = await daemon.request<DeviceState>("configure_pin11_static", {
      deviceId,
      mode: mode[level],
    });
    return textResult({ pin: "PIN_11", level, applied: true, device });
  },
);

server.tool("safe_idle", "Set PIN_11 off and PIN_5 to a non-toggling low level.", {
  deviceId: deviceIdSchema,
}, async ({ deviceId }) => {
  const device = await daemon.request<DeviceState>("safe_idle", { deviceId });
  return textResult({ device, note: "PIN_5 cannot enter high impedance; it outputs low." });
});

server.tool("safe_idle_all", "Set every connected device to the safe idle output state.", {}, async () => {
  const devices = await daemon.request<DeviceState[]>("safe_idle_all");
  return textResult({ devices, note: "PIN_5 cannot enter high impedance; it outputs low." });
});

server.tool("get_latest_capture", "Read metadata for the latest capture performed by the desktop app or MCP.", {
  deviceId: deviceIdSchema,
  group: z.boolean().optional().describe("Set true to read the latest synchronized group."),
}, async ({ deviceId, group }) => {
  const frame = await daemon.request<CaptureFrame | SynchronizedCaptureGroup | null>(
    "get_latest_capture",
    { deviceId, group },
  );
  if (!frame) return textResult(null);
  if ("frames" in frame) return textResult(frame);
  const { samplesBase64: _samples, ...summary } = frame;
  return textResult(summary);
});

server.tool(
  "run_loopback_check",
  "Run a protocol-level self-test and physical channel activity scan. Physical PASS requires a jumper.",
  { deviceId: deviceIdSchema },
  async ({ deviceId }) => {
    const frame = await daemon.request<CaptureFrame>("capture", {
      deviceId,
      sampleRateHz: 100_000_000,
      sampleCount: 8192,
      pretriggerPercent: 0,
      trigger: { mode: "immediate" },
      persist: false,
    });
    const device = await daemon.request<DeviceState>("get_device_info", { deviceId });
    return textResult({
      protocol: "PASS",
      physical: frame.activeChannels.length > 0 ? "ACTIVE" : "SKIP_NO_JUMPER",
      activeChannels: frame.activeChannels,
      info: device.info,
      pin5: device.pin5,
      channels: frame.channels,
      note: "Protocol PASS does not prove physical waveform routing. A jumper from PIN_5 or PIN_11 to CH1-CH4 is required.",
    });
  },
);

server.resource(
  "device-debugging-guide",
  "ag32-logic://guide/device-debugging",
  { mimeType: "text/markdown" },
  async () => ({
    contents: [
      {
        uri: "ag32-logic://guide/device-debugging",
        mimeType: "text/markdown",
        text: [
          "# AG32 Logic Studio device debugging",
          "",
          "- Inputs: CH1=PIN_7, CH2=PIN_8, CH3=PIN_9, CH4=PIN_10.",
          "- Digital output: PIN_5, square wave 1 Hz to 100 MHz, or delayed/host-triggered level and pulse engine.",
          "- Analog output: PIN_11, DAC0 sine/square/sawtooth/triangle. Default calibrated rate cap is 5 MSa/s.",
          "- Desktop UI and MCP share one daemon. MCP command transactions are prioritized, but capture ownership is granted one frame at a time.",
          "- A host-assigned deviceIndex 1-4 lights exactly LED1-LED4 and overrides normal status LED patterns.",
          "- Closing a client does not change signal outputs. Call safe_idle explicitly when needed.",
          "- PIN_11 can turn off. PIN_5 cannot enter high impedance; safe_idle drives it low and stops toggling.",
          "- PulseView is an exclusive fallback and must not run while the daemon owns the CDC port.",
        ].join("\n"),
      },
    ],
  }),
);

server.prompt("ag32_logic_debugging", "Operational workflow for another AI using this MCP.", {}, async () => ({
  messages: [
    {
      role: "user",
      content: {
        type: "text",
        text: [
          "Debug the AG32 logic analyzer end to end:",
          "1. Call list_devices and select the port that answers with SUMP ID 1ALS.",
          "2. Call connect_device with an optional deviceIndex 1-4 and read firmware status with get_device_info.",
          "3. Configure PIN_5 or PIN_11 as needed. PIN_11 output must be explicitly enabled.",
          "4. Call capture. Check activeChannels and per-channel measurements; use the returned VCD artifact for detailed waveform inspection.",
          "5. For loopback, physically jumper the selected output to CH1-CH4 first. Report protocol PASS from physical activity separately.",
          "6. Never use this server to build, flash, or modify firmware/CPLD logic.",
          "7. Use safe_idle to stop PIN_11 and drive PIN_5 low; do not claim PIN_5 high impedance.",
        ].join("\n"),
      },
    },
  ],
}));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function buildTrigger(
  mode: "immediate" | "level" | "edge" | undefined,
  trigger: { channels: ("CH1" | "CH2" | "CH3" | "CH4")[]; highChannels: ("CH1" | "CH2" | "CH3" | "CH4")[] } | undefined,
  edges: Array<{ channel: "CH1" | "CH2" | "CH3" | "CH4"; direction: "rising" | "falling" }> | undefined,
): CaptureTrigger {
  if (mode === "edge" || (!trigger && edges)) return { mode: "edge", edges: edges ?? [] };
  if (mode === "immediate") return { mode: "immediate" };
  if (trigger) return { mode: "level", ...trigger };
  return { mode: "immediate" };
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function summarizeFrame(frame: CaptureFrame) {
  const { samplesBase64: _samples, ...summary } = frame;
  return summary;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

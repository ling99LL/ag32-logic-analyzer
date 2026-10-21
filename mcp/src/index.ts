import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  Ag32SerialDevice,
  listSerialPorts,
  probeSumpId,
  readInfoFrame,
} from "./device.js";
import {
  Ag32Session,
  triggerMask,
} from "./session.js";
import {
  MAX_SAMPLE_COUNT,
  MAX_SAMPLE_RATE_HZ,
  MIN_SAMPLE_COUNT,
  MIN_SAMPLE_RATE_HZ,
  PIN11_RATE_CAP_MAX_HZ,
  PIN11_RATE_CAP_MIN_HZ,
  PIN5_SQUARE_MAX_HZ,
  PIN5_SQUARE_MIN_HZ,
  PIN5_TICK_BASE_NS,
  PIN5_TRIGGER_MODES,
  PIN5_CONTROL_BITS,
  WAVE_TYPES,
  OPS,
  encodePin5Config,
  encodeTimeNs,
  makeExtendedFrame,
  type Pin5TriggerMode,
  type WaveType,
} from "./protocol.js";
import { analyzeSamples, exportVcd, findActiveChannels } from "./analysis.js";

const server = new McpServer(
  { name: "ag32-logic-mcp", version: "0.1.0" },
  {
    instructions:
      "Control the AG32VF303 logic analyzer and signal generator. CH1-CH4 are inputs on PIN_7-10. PIN_5 is the digital output and PIN_11 is the DAC analog output. This server does not build or flash firmware.",
  },
);

const session = new Ag32Session();

const portSchema = z.string().min(1).describe("Serial port path, for example COM33. Omit to use the detected AG32 port.");

server.tool(
  "list_devices",
  "List serial ports and identify the AG32 Logic device by SUMP ID 1ALS.",
  { preferPort: portSchema.optional() },
  async ({ preferPort }) => {
    const ports = await listSerialPorts();
    const ordered = preferPort ? [preferPort, ...ports.filter((port) => port !== preferPort)] : ports;
    const found: Array<{ port: string; firmware?: string; sumpId?: boolean; error?: string }> = [];
    for (const port of ordered) {
      if (session.connectedPort === port) {
        const info = await session.getInfo();
        found.push({ port, sumpId: true, firmware: `v${info.firmware.major}.${info.firmware.minor}` });
        continue;
      }
      const device = await Ag32SerialDevice.open(port);
      if (!device) {
        found.push({ port, error: "Port unavailable or busy" });
        continue;
      }
      try {
        const sumpId = await probeSumpId(device);
        const info = sumpId ? await readInfoFrame(device) : undefined;
        found.push({
          port,
          sumpId,
          firmware: info ? `v${info.firmware.major}.${info.firmware.minor}` : undefined,
        });
      } catch (error) {
        found.push({ port, error: error instanceof Error ? error.message : String(error) });
      } finally {
        await device.close().catch(() => undefined);
      }
    }
    const matched = found.find((item) => item.sumpId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ selected: matched?.port ?? null, devices: found }, null, 2),
        },
      ],
    };
  },
);

server.tool("connect_device", "Connect to the AG32 Logic USB CDC port.", { port: portSchema }, async ({ port }) => {
  const info = await session.connect(port);
  return { content: [{ type: "text", text: JSON.stringify({ connected: true, port, info }, null, 2) }] };
});

server.tool("disconnect_device", "Close the current AG32 Logic serial connection.", {}, async () => {
  await session.disconnect();
  return { content: [{ type: "text", text: JSON.stringify({ connected: false }) }] };
});

server.tool("get_device_info", "Read firmware, PIN_11, PIN_5 and DAC status from the connected device.", {}, async () => {
  const info = await session.getInfo();
  const pin5 = await session.getPin5Status();
  return { content: [{ type: "text", text: JSON.stringify({ port: session.connectedPort, info, pin5 }, null, 2) }] };
});

server.tool(
  "capture",
  "Capture CH1-CH4 and write samples.bin, capture.vcd and manifest.json under mcp/runs.",
  {
    sampleRateHz: z
      .number()
      .int()
      .min(MIN_SAMPLE_RATE_HZ)
      .max(MAX_SAMPLE_RATE_HZ)
      .describe("Sampling rate in Hz. The hardware clock is 100 MHz and the divider produces discrete rates."),
    sampleCount: z.number().int().min(MIN_SAMPLE_COUNT).max(MAX_SAMPLE_COUNT).default(8192)
      .describe("Number of samples. Values are normalized down to a multiple of 4."),
    trigger: z
      .object({
        channels: z.array(z.enum(["CH1", "CH2", "CH3", "CH4"])).min(1),
        highChannels: z.array(z.enum(["CH1", "CH2", "CH3", "CH4"])).min(1),
      })
      .optional()
      .describe("Optional level trigger. Channels listed but absent from highChannels trigger low."),
  },
  async ({ sampleRateHz, sampleCount, trigger }) => {
    const maskValue = trigger ? triggerMask(trigger.channels, trigger.highChannels) : { mask: 0, value: 0 };
    const result = await session.capture({
      sampleRateHz,
      sampleCount,
      triggerMask: maskValue.mask,
      triggerValue: maskValue.value,
    });
    const measurements = analyzeSamples(result.samples, result.actualSampleRateHz);
    const activeChannels = findActiveChannels(measurements);
    const vcd = exportVcd(result.samples, result.actualSampleRateHz);
    const metadata = {
      device: "AG32VF303 Logic Analyzer",
      capturedAt: new Date().toISOString(),
      requestedSampleRateHz: sampleRateHz,
      actualSampleRateHz: result.actualSampleRateHz,
      divider: result.divider,
      sampleCount: result.sampleCount,
      trigger: trigger ?? null,
      activeChannels,
      channels: measurements,
    };
    const artifacts = await session.writeRunArtifacts({
      samples: result.samples,
      sampleRateHz: result.actualSampleRateHz,
      vcd,
      analysis: measurements,
      metadata,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...metadata,
            physicalWaveform: activeChannels.length > 0 ? "ACTIVE" : "NO_ACTIVITY",
            artifacts,
          }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "configure_pin5_square_wave",
  "Configure PIN_5 as a 50% duty-cycle digital square wave.",
  {
    frequencyHz: z.number().int().min(PIN5_SQUARE_MIN_HZ).max(PIN5_SQUARE_MAX_HZ)
      .describe("Frequency in Hz from 1 Hz to 100 MHz."),
  },
  async ({ frequencyHz }) => {
    const status = await session.configurePin5SquareWave(frequencyHz);
    return { content: [{ type: "text", text: JSON.stringify({ pin: "PIN_5", frequencyHz, status }, null, 2) }] };
  },
);

server.tool(
  "configure_pin5_trigger_engine",
  "Configure PIN_5 delayed/host-triggered level or pulse engine.",
  {
    mode: z.enum(PIN5_TRIGGER_MODES).describe("delayed_level, delayed_pulse, host_level, or host_pulse."),
    activeLevel: z.enum(["high", "low"]).default("high"),
    idleLevel: z.enum(["high", "low"]).default("low"),
    delayNs: z.number().min(0).max(42_900_000_000).default(0),
    widthNs: z.number().min(0).max(42_900_000_000).default(0),
    action: z.enum(["arm", "fire", "reset"]).optional(),
  },
  async (input) => {
    const delay = encodeTimeNs(input.delayNs);
    const width = encodeTimeNs(input.widthNs);
    const prescale = Math.max(delay.prescale, width.prescale);
    const tickNs = PIN5_TICK_BASE_NS * [1, 10, 100, 1000][prescale];
    const configValue = encodePin5Config({
      mode: input.mode as Pin5TriggerMode,
      activeLevel: input.activeLevel,
      idleLevel: input.idleLevel,
      prescale,
    });
    const status = await session.configurePin5Trigger({
      configValue,
      delayTicks: Math.round(input.delayNs / tickNs),
      widthTicks: Math.round(input.widthNs / tickNs),
      action: input.action,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ pin: "PIN_5", requested: input, tickNs, configValue, status }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "configure_pin11_waveform",
  "Configure PIN_11 DAC0 waveform, frequency, amplitude, and output enable.",
  {
    waveform: z.enum(WAVE_TYPES).describe("sine, square, sawtooth, or triangle."),
    frequencyHz: z.number().int().min(1).max(PIN11_RATE_CAP_MAX_HZ)
      .describe("Requested frequency in Hz. The server clamps it to the DAC rate cap for the selected waveform."),
    amplitudePercent: z.number().int().min(1).max(100).default(100),
    enabled: z.boolean().default(false).describe("PIN_11 output enable. Defaults to false for safety."),
    rateCapHz: z.number().int().min(PIN11_RATE_CAP_MIN_HZ).max(PIN11_RATE_CAP_MAX_HZ).optional()
      .describe("Optional DAC sample-rate cap. Leave unset to use the calibrated device value, normally 5 MSa/s."),
  },
  async ({ waveform, frequencyHz, amplitudePercent, enabled, rateCapHz }) => {
    if (rateCapHz) {
      await session.serialOrThrow.write(makeExtendedFrame(OPS.rateCap, rateCapHz));
    }
    const info = await session.configurePin11Waveform({
      waveform: waveform as WaveType,
      frequencyHz,
      amplitudePercent,
      enabled,
    });
    return { content: [{ type: "text", text: JSON.stringify({ pin: "PIN_11", info }, null, 2) }] };
  },
);

server.tool(
  "run_loopback_check",
  "Run a protocol-level self-test and a physical-channel activity scan. Physical PASS requires a jumper from an output to an input.",
  {},
  async () => {
    const info = await session.getInfo();
    const captureResult = await session.capture({
      sampleRateHz: 100_000_000,
      sampleCount: 8192,
      triggerMask: 0,
      triggerValue: 0,
    });
    const measurements = analyzeSamples(captureResult.samples, captureResult.actualSampleRateHz);
    const activeChannels = findActiveChannels(measurements);
    const pin5 = await session.getPin5Status();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            protocol: "PASS",
            physical: activeChannels.length > 0 ? "ACTIVE" : "SKIP_NO_JUMPER",
            activeChannels,
            info,
            pin5,
            channels: measurements,
            note: "Protocol PASS does not prove physical waveform routing. A jumper from PIN_5 or PIN_11 to CH1-CH4 is required for physical validation.",
          }, null, 2),
        },
      ],
    };
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
          "# AG32 Logic device debugging",
          "",
          "- Inputs: CH1=PIN_7, CH2=PIN_8, CH3=PIN_9, CH4=PIN_10. Weak pull-downs are active when no signal is connected.",
          "- Digital output: PIN_5, square wave 1 Hz to 100 MHz, or delayed/host-triggered level and pulse engine.",
          "- Analog output: PIN_11, DAC0 sine/square/sawtooth/triangle. Default calibrated rate cap is 5 MSa/s; waveform frequency limits are cap/8, cap/2, cap/4, cap/8 respectively.",
          "- The USB CDC port is shared with PulseView. Close PulseView before connecting the MCP, and disconnect the MCP before using PulseView.",
          "- Capture rate is 100 MHz/(divider+1), so exact requested rates may be rounded to a hardware-realizable rate.",
          "- Run list_devices, connect_device, configure the signal source, capture, and then inspect the channel measurements and generated VCD.",
          "- If a capture reports NO_ACTIVITY, first check the physical jumper, then verify the signal source status. Do not treat a protocol response as proof of physical output.",
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
          "2. Call connect_device on that port and read firmware status with get_device_info.",
          "3. Configure PIN_5 or PIN_11 as needed. PIN_11 output must be explicitly enabled.",
          "4. Call capture. Check activeChannels and per-channel edge/frequency measurements; use the VCD artifact for waveform inspection.",
          "5. For loopback, physically jumper the selected output to one of CH1-CH4 first. Report protocol PASS separately from physical activity, and state SKIP_NO_JUMPER when no channel is active.",
          "6. Never use this server to build, flash, or modify firmware/CPLD logic.",
        ].join("\n"),
      },
    },
  ],
}));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

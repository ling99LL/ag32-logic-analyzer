import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ag32SerialDevice,
  readInfoFrame,
  readPin5StatusFrame,
  probeSumpId,
  type SerialLike,
} from "./device.js";
import {
  OPS,
  PIN5_CONTROL_BITS,
  ProtocolError,
  channelBits,
  dividerToSampleRate,
  makeDividerFrame,
  makeExtendedFrame,
  makeMaskFrame,
  makeReadCountFrame,
  normalizeSampleCount,
  encodePin5Config,
  encodeTimeNs,
  PIN5_PRESCALES,
  PIN5_TICK_BASE_NS,
  WAVE_TYPE_CODES,
  parseInfoFrame,
  pin11FrequencyLimit,
  sampleRateToDivider,
  type WaveType,
} from "./protocol.js";
import type {
  CaptureRequest,
  CaptureTrigger,
  ChannelName,
  FirmwareInfo,
  Pin5Status,
  Pin5EngineConfig,
  Pin11Config,
} from "./shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const runsRoot = path.resolve(__dirname, "../runs");

export class CaptureAbortedError extends ProtocolError {
  constructor(message = "Capture was aborted to yield the device") {
    super(message);
    this.name = "CaptureAbortedError";
  }
}

export class Ag32Session {
  private serial: SerialLike | null = null;
  private portPath: string | null = null;

  get connectedPort(): string | null {
    return this.portPath;
  }

  get serialOrThrow(): SerialLike {
    if (!this.serial) throw new ProtocolError("Device is not connected. Call connect_device first.");
    return this.serial;
  }

  async connect(portPath: string): Promise<ReturnType<typeof parseInfoFrame>> {
    if (this.serial && this.portPath === portPath) return readInfoFrame(this.serial);
    await this.disconnect();
    const device = await Ag32SerialDevice.open(portPath);
    if (!device) throw new ProtocolError(`Port ${portPath} is unavailable or busy`);
    try {
      const ok = await probeSumpId(device);
      if (!ok) throw new ProtocolError(`Port ${portPath} did not answer with SUMP ID 1ALS`);
      const info = await readInfoFrame(device);
      this.serial = device;
      this.portPath = portPath;
      return info;
    } catch (error) {
      await device.close().catch(() => undefined);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.serial) return;
    const serial = this.serial;
    this.serial = null;
    this.portPath = null;
    await serial.close();
  }

  async setDeviceIndex(deviceIndex: 0 | 1 | 2 | 3 | 4): Promise<ReturnType<typeof parseInfoFrame>> {
    const serial = this.serialOrThrow;
    await serial.write(makeExtendedFrame(OPS.deviceIndex, deviceIndex));
    await serial.flush();
    const info = await readInfoFrame(serial);
    if (info.deviceIndex !== (deviceIndex || null)) {
      throw new ProtocolError(
        `Firmware did not accept device index ${deviceIndex}; update to firmware v1.2 or newer`,
      );
    }
    return info;
  }

  async getInfo(): Promise<ReturnType<typeof parseInfoFrame>> {
    return readInfoFrame(this.serialOrThrow);
  }

  async getPin5Status(): Promise<ReturnType<typeof readPin5StatusFrame>> {
    return readPin5StatusFrame(this.serialOrThrow);
  }

  async configurePin11Waveform(input: {
    waveform: WaveType;
    frequencyHz: number;
    amplitudePercent: number;
    enabled: boolean;
  }): Promise<ReturnType<typeof parseInfoFrame>> {
    const serial = this.serialOrThrow;
    const info = await readInfoFrame(serial);
    const cap = Math.min(input.frequencyHz, pin11FrequencyLimit(info.rateCapHz, input.waveform));
    const waveValue =
      (input.enabled ? 1 << 16 : 0) |
      (Math.round(input.amplitudePercent) << 8) |
      WAVE_TYPE_CODES[input.waveform];
    await serial.write(makeExtendedFrame(OPS.wave, waveValue));
    await serial.write(makeExtendedFrame(OPS.frequency, Math.max(1, cap)));
    await serial.write(makeExtendedFrame(OPS.getInfo, 0));
    await serial.flush();
    return readInfoFrame(serial);
  }

  async configurePin11(input: Pin11Config): Promise<ReturnType<typeof parseInfoFrame>> {
    if (input.rateCapHz) {
      await this.serialOrThrow.write(makeExtendedFrame(OPS.rateCap, input.rateCapHz));
    }
    return this.configurePin11Waveform(input);
  }

  async configurePin11Static(mode: 0 | 1 | 2 | "off" | "low" | "high"): Promise<void> {
    const serial = this.serialOrThrow;
    const value = typeof mode === "string" ? { off: 0, low: 1, high: 2 }[mode] : mode;
    await serial.write(makeExtendedFrame(OPS.pin11Static, value));
  }

  async configurePin5SquareWave(frequencyHz: number): Promise<ReturnType<typeof readPin5StatusFrame>> {
    const serial = this.serialOrThrow;
    await serial.write(makeExtendedFrame(OPS.pin5Config, 1 << 8));
    await serial.write(makeExtendedFrame(OPS.pin5SquareFrequency, Math.round(frequencyHz)));
    await serial.write(makeExtendedFrame(OPS.pin5Query, 0));
    await serial.flush();
    return readPin5StatusFrame(serial);
  }

  async configurePin5Trigger(input: {
    configValue: number;
    delayTicks: number;
    widthTicks: number;
    action?: "arm" | "fire" | "reset";
  }): Promise<Pin5Status> {
    const serial = this.serialOrThrow;
    await serial.write(makeExtendedFrame(OPS.pin5Config, input.configValue));
    await serial.write(makeExtendedFrame(OPS.pin5Delay, input.delayTicks));
    await serial.write(makeExtendedFrame(OPS.pin5Width, input.widthTicks));
    if (input.action) {
      await serial.write(makeExtendedFrame(OPS.pin5Control, PIN5_CONTROL_BITS[input.action]));
    }
    await serial.write(makeExtendedFrame(OPS.pin5Query, 0));
    await serial.flush();
    return readPin5StatusFrame(serial);
  }

  async pin5EngineControl(action: "arm" | "fire" | "reset"): Promise<Pin5Status> {
    const serial = this.serialOrThrow;
    await serial.write(makeExtendedFrame(OPS.pin5Control, PIN5_CONTROL_BITS[action]));
    await serial.flush();
    return readPin5StatusFrame(serial);
  }

  async configurePin5Engine(input: Pin5EngineConfig): Promise<Pin5Status> {
    const delay = encodeTimeNs(input.delayNs);
    const width = encodeTimeNs(input.widthNs);
    const prescale = Math.max(delay.prescale, width.prescale);
    const tickNs = PIN5_TICK_BASE_NS * PIN5_PRESCALES[prescale];
    const configValue = encodePin5Config({
      mode: input.mode,
      activeLevel: input.activeLevel,
      idleLevel: input.idleLevel,
      prescale,
    });
    return this.configurePin5Trigger({
      configValue,
      delayTicks: Math.round(input.delayNs / tickNs),
      widthTicks: Math.round(input.widthNs / tickNs),
      action: input.action,
    });
  }

  async safeIdle(): Promise<{ info: FirmwareInfo; pin5: Pin5Status }> {
    await this.configurePin11Static(0);
    const pin5 = await this.configurePin5Engine({
      mode: "host_level",
      activeLevel: "low",
      idleLevel: "low",
      delayNs: 0,
      widthNs: 0,
      action: "reset",
    });
    const info = await this.getInfo();
    return { info, pin5 };
  }

  async capture(input: {
    sampleRateHz: number;
    sampleCount: number;
    pretriggerPercent?: number;
    trigger?: CaptureTrigger;
  }, options?: {
    registerAbort?: (abort: () => Promise<void>) => void;
  }): Promise<{
    samples: Buffer;
    divider: number;
    actualSampleRateHz: number;
    sampleCount: number;
    triggerMask: number;
    triggerValue: number;
    pretriggerPercent: number;
  }> {
    const serial = this.serialOrThrow;
    const sampleCount = normalizeSampleCount(input.sampleCount);
    const divider = sampleRateToDivider(input.sampleRateHz);
    const pretriggerPercent = Math.max(0, Math.min(99, input.pretriggerPercent ?? 0));
    const trigger = normalizeTrigger(input.trigger);
    await serial.flush();
    await serial.write(makeDividerFrame(divider));
    await serial.write(makeReadCountFrame(sampleCount, pretriggerPercent));
    await serial.write(makeMaskFrame(0xc0, trigger.mask));
    await serial.write(makeMaskFrame(0xc1, trigger.value));
    await serial.flush();

    let abortPromise: Promise<void> | null = null;
    let aborted = false;
    const abort = (): Promise<void> => {
      if (abortPromise) return abortPromise;
      aborted = true;
      abortPromise = (async () => {
        await serial.write(Buffer.from([0x00])).catch(() => undefined);
        serial.cancelReads?.(new CaptureAbortedError());
        await new Promise((resolve) => setTimeout(resolve, 30));
        await serial.flush().catch(() => undefined);
      })();
      return abortPromise;
    };
    options?.registerAbort?.(abort);

    try {
      await serial.write(Buffer.from([0x01]));
      const samples = await this.readCapture(serial, sampleCount, 8000);
      return {
        samples,
        divider,
        actualSampleRateHz: dividerToSampleRate(divider),
        sampleCount,
        triggerMask: trigger.mask,
        triggerValue: trigger.value,
        pretriggerPercent,
      };
    } catch (error) {
      if (aborted && abortPromise) {
        await abortPromise;
        throw new CaptureAbortedError();
      }
      throw error;
    }
  }

  private async readCapture(serial: SerialLike, count: number, timeoutMs: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let received = 0;
    const deadline = Date.now() + timeoutMs;
    while (received < count) {
      if (Date.now() > deadline) throw new ProtocolError(`Capture timed out after ${timeoutMs} ms`);
      const chunk = await serial.read(count - received);
      if (chunk.length > 0) {
        chunks.push(chunk);
        received += chunk.length;
      }
    }
    return Buffer.concat(chunks);
  }

  async writeRunArtifacts(input: {
    samples: Buffer;
    sampleRateHz: number;
    vcd: string;
    analysis: unknown;
    metadata: Record<string, unknown>;
  }): Promise<{ directory: string; manifestPath: string; samplesPath: string; vcdPath: string }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const directory = path.join(runsRoot, stamp);
    await fs.mkdir(directory, { recursive: true });
    const manifestPath = path.join(directory, "manifest.json");
    const samplesPath = path.join(directory, "samples.bin");
    const vcdPath = path.join(directory, "capture.vcd");
    await Promise.all([
      fs.writeFile(manifestPath, `${JSON.stringify(input.metadata, null, 2)}\n`, "utf8"),
      fs.writeFile(samplesPath, input.samples),
      fs.writeFile(vcdPath, input.vcd, "utf8"),
    ]);
    return { directory, manifestPath, samplesPath, vcdPath };
  }
}

export function normalizeTrigger(trigger?: CaptureTrigger): { mask: number; value: number } {
  if (!trigger || trigger.mode === "immediate") return { mask: 0, value: 0 };
  if (trigger.mode === "edge") {
    const edges = trigger.edges ?? [];
    const channels = edges.map((edge) => edge.channel);
    let value = 0;
    for (const edge of edges) {
      if (edge.direction === "rising") value |= channelBits([edge.channel]);
    }
    if (channels.length === 0) return { mask: 0, value: 0 };
    return { mask: channelBits(channels) | 0x10, value };
  }
  return triggerMask(trigger.channels ?? [], trigger.highChannels ?? []);
}

export function triggerMask(
  channels: readonly ChannelName[],
  highChannels: readonly ChannelName[],
): { mask: number; value: number } {
  const mask = channelBits(channels);
  const highMask = channelBits(highChannels);
  if (mask === 0) return { mask: 0, value: 0 };
  if (highMask & ~mask) {
    const invalid = [...highChannels].filter((channel) => !channels.includes(channel));
    throw new ProtocolError(`High-level trigger channels are not enabled: ${invalid.join(", ")}`);
  }
  return { mask, value: highMask };
}

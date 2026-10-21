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
  WAVE_TYPE_CODES,
  parseInfoFrame,
  pin11FrequencyLimit,
  sampleRateToDivider,
  type WaveType,
} from "./protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const runsRoot = path.resolve(__dirname, "../runs");

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
  }): Promise<ReturnType<typeof readPin5StatusFrame>> {
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

  async capture(input: {
    sampleRateHz: number;
    sampleCount: number;
    triggerMask: number;
    triggerValue: number;
  }): Promise<{ samples: Buffer; divider: number; actualSampleRateHz: number; sampleCount: number }> {
    const serial = this.serialOrThrow;
    const sampleCount = normalizeSampleCount(input.sampleCount);
    const divider = sampleRateToDivider(input.sampleRateHz);
    await serial.flush();
    await serial.write(makeDividerFrame(divider));
    await serial.write(makeReadCountFrame(sampleCount));
    await serial.write(makeMaskFrame(0xc0, input.triggerMask));
    await serial.write(makeMaskFrame(0xc1, input.triggerValue));
    await serial.flush();
    await serial.write(Buffer.from([0x01]));
    const samples = await this.readCapture(serial, sampleCount, 8000);
    return { samples, divider, actualSampleRateHz: dividerToSampleRate(divider), sampleCount };
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

export function triggerMask(channels: readonly string[], highChannels: readonly string[]): { mask: number; value: number } {
  const mask = channelBits(channels);
  const highMask = channelBits(highChannels);
  if (mask === 0) return { mask: 0, value: 0 };
  if (highMask & ~mask) {
    const invalid = [...highChannels].filter((channel) => !channels.includes(channel));
    throw new ProtocolError(`High-level trigger channels are not enabled: ${invalid.join(", ")}`);
  }
  return { mask, value: highMask };
}

export const SUMP_BAUD_RATE = 115200;
export const SUMP_ID = "1ALS";
export const CLOCK_HZ = 100_000_000;
export const MIN_SAMPLE_COUNT = 4;
export const MAX_SAMPLE_COUNT = 8192;
export const MIN_SAMPLE_RATE_HZ = 12_207; // 100 MHz / 8192
export const MAX_SAMPLE_RATE_HZ = 100_000_000;
export const PIN5_SQUARE_MIN_HZ = 1;
export const PIN5_SQUARE_MAX_HZ = 100_000_000;
export const PIN11_DEFAULT_RATE_CAP_HZ = 5_000_000;
export const PIN11_RATE_CAP_MIN_HZ = 1526;
export const PIN11_RATE_CAP_MAX_HZ = 100_000_000;

export const OPS = {
  divider: 0x80,
  readCount: 0x81,
  flags: 0x82,
  testDivider: 0x83,
  wave: 0x84,
  frequency: 0x85,
  pin5Config: 0x86,
  pin5Delay: 0x87,
  pin5Width: 0x88,
  pin5Control: 0x89,
  pin5SquareFrequency: 0x8a,
  rateCap: 0x8b,
  getInfo: 0x8c,
  pin5Query: 0x8d,
} as const;

export const CHANNELS = [
  { boardName: "CH1", bit: 0, pin: "PIN_7" },
  { boardName: "CH2", bit: 1, pin: "PIN_8" },
  { boardName: "CH3", bit: 2, pin: "PIN_9" },
  { boardName: "CH4", bit: 3, pin: "PIN_10" },
] as const;

export const WAVE_TYPES = ["sine", "square", "sawtooth", "triangle"] as const;
export type WaveType = (typeof WAVE_TYPES)[number];
export const WAVE_TYPE_CODES: Record<WaveType, number> = {
  sine: 0,
  square: 1,
  sawtooth: 2,
  triangle: 3,
};
export const PIN5_CONTROL_BITS = {
  arm: 1,
  fire: 2,
  reset: 4,
} as const;
export const WAVE_MIN_POINTS: Record<WaveType, number> = {
  sine: 8,
  square: 2,
  sawtooth: 4,
  triangle: 8,
};

export const PIN5_TRIGGER_MODES = [
  "delayed_level",
  "delayed_pulse",
  "host_level",
  "host_pulse",
] as const;
export type Pin5TriggerMode = (typeof PIN5_TRIGGER_MODES)[number];
export const PIN5_PRESCALES = [1, 10, 100, 1000] as const;
export const PIN5_TICK_BASE_NS = 10;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function uint32(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ProtocolError(`Value must be an integer in 0..4294967295: ${value}`);
  }
  return value;
}

export function makeExtendedFrame(op: number, value: number): Buffer {
  const payload = uint32(value);
  const frame = Buffer.allocUnsafe(5);
  frame[0] = op;
  frame.writeUInt32LE(payload, 1);
  return frame;
}

export function makeDividerFrame(divider: number): Buffer {
  const value = uint32(divider);
  const frame = Buffer.alloc(5);
  frame[0] = OPS.divider;
  frame[1] = value & 0xff;
  frame[2] = (value >> 8) & 0xff;
  frame[3] = (value >> 16) & 0xff;
  return frame;
}

export function makeReadCountFrame(sampleCount: number): Buffer {
  if (sampleCount % 4 !== 0 || sampleCount < MIN_SAMPLE_COUNT || sampleCount > MAX_SAMPLE_COUNT) {
    throw new ProtocolError("sampleCount must be a multiple of 4 in 4..8192");
  }
  const words = sampleCount / 4 - 1;
  const frame = Buffer.alloc(5);
  frame[0] = OPS.readCount;
  frame[1] = words & 0xff;
  frame[2] = (words >> 8) & 0xff;
  frame[3] = words & 0xff;
  frame[4] = (words >> 8) & 0xff;
  return frame;
}

export function makeMaskFrame(op: number, mask: number): Buffer {
  const value = uint32(mask);
  const frame = Buffer.alloc(5);
  frame[0] = op;
  frame.writeUInt32LE(value, 1);
  return frame;
}

export function sampleRateToDivider(sampleRateHz: number): number {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < MIN_SAMPLE_RATE_HZ || sampleRateHz > MAX_SAMPLE_RATE_HZ) {
    throw new ProtocolError(`sampleRateHz must be in ${MIN_SAMPLE_RATE_HZ}..${MAX_SAMPLE_RATE_HZ}`);
  }
  return Math.min(Math.floor(CLOCK_HZ / sampleRateHz) - 1, 0xffff);
}

export function dividerToSampleRate(divider: number): number {
  if (!Number.isInteger(divider) || divider < 0 || divider > 0xffff) {
    throw new ProtocolError("divider must be an integer in 0..65535");
  }
  return CLOCK_HZ / (divider + 1);
}

export function channelBits(channels: readonly string[]): number {
  let mask = 0;
  for (const name of channels) {
    const channel = CHANNELS.find((item) => item.boardName === name);
    if (!channel) throw new ProtocolError(`Unknown channel: ${name}`);
    mask |= 1 << channel.bit;
  }
  return mask;
}

export function normalizeSampleCount(count: number): number {
  const clamped = Math.max(MIN_SAMPLE_COUNT, Math.min(MAX_SAMPLE_COUNT, count));
  return clamped - (clamped % 4);
}

export function parseInfoFrame(payload: Buffer): {
  firmware: { major: number; minor: number };
  waveform: WaveType;
  amplitudePercent: number;
  requestedFrequencyHz: number;
  actualFrequencyHz: number;
  flags: number;
  tableLength: number;
  rateCapHz: number;
} {
  if (payload.length < 20) {
    throw new ProtocolError(`GET_INFO payload must be 20 bytes, received ${payload.length}`);
  }
  const typeCode = payload[2];
  const waveform = WAVE_TYPES[typeCode] as WaveType | undefined;
  if (!waveform) throw new ProtocolError(`Unknown waveform code: ${typeCode}`);
  return {
    firmware: { major: payload[0], minor: payload[1] },
    waveform,
    amplitudePercent: payload[3],
    requestedFrequencyHz: payload.readUInt32LE(4),
    actualFrequencyHz: payload.readUInt32LE(8),
    flags: payload[12],
    tableLength: 1 << payload[13],
    rateCapHz: payload.readUInt32LE(14) || PIN11_DEFAULT_RATE_CAP_HZ,
  };
}

export function parsePin5StatusFrame(payload: Buffer): {
  busy: boolean;
  done: boolean;
  outputHigh: boolean;
  remainingTicks: number;
  config: number;
  squareSelected: boolean;
  tickNs: number;
  remainingNs: number;
} {
  if (payload.length < 7) {
    throw new ProtocolError(`PIN_5 status payload must be 7 bytes, received ${payload.length}`);
  }
  const status = payload[0];
  const config = payload.readUInt16LE(5);
  const prescale = (config >> 4) & 0x03;
  const tickNs = PIN5_TICK_BASE_NS * PIN5_PRESCALES[prescale];
  const remainingTicks = payload.readUInt32LE(1);
  return {
    busy: Boolean(status & 1),
    done: Boolean(status & 2),
    outputHigh: Boolean(status & 4),
    remainingTicks,
    config,
    squareSelected: Boolean(config & 0x100),
    tickNs,
    remainingNs: remainingTicks * tickNs,
  };
}

export function encodeTimeNs(timeNs: number): { prescale: number; ticks: number; tickNs: number } {
  if (!Number.isFinite(timeNs) || timeNs < 0) throw new ProtocolError("timeNs must be non-negative");
  for (let index = 0; index < PIN5_PRESCALES.length; index += 1) {
    const tickNs = PIN5_TICK_BASE_NS * PIN5_PRESCALES[index];
    if (timeNs / tickNs <= 0xffffffff) {
      return { prescale: index, ticks: Math.min(Math.round(timeNs / tickNs), 0xffffffff), tickNs };
    }
  }
  return { prescale: 3, ticks: 0xffffffff, tickNs: PIN5_TICK_BASE_NS * PIN5_PRESCALES[3] };
}

export function encodePin5Config(input: {
  mode: Pin5TriggerMode;
  activeLevel: "high" | "low";
  idleLevel: "high" | "low";
  prescale: number;
}): number {
  const mode = PIN5_TRIGGER_MODES.indexOf(input.mode);
  if (mode < 0) throw new ProtocolError(`Unknown PIN_5 mode: ${input.mode}`);
  if (!Number.isInteger(input.prescale) || input.prescale < 0 || input.prescale > 3) {
    throw new ProtocolError("prescale index must be in 0..3");
  }
  return (
    mode |
    (input.activeLevel === "high" ? 0x04 : 0) |
    (input.idleLevel === "high" ? 0x08 : 0) |
    (input.prescale << 4)
  );
}

export function pin11FrequencyLimit(rateCapHz: number, waveform: WaveType): number {
  return Math.floor(rateCapHz / WAVE_MIN_POINTS[waveform]);
}

export function channelMaskFromBits(mask: number): string[] {
  return CHANNELS.filter((channel) => mask & (1 << channel.bit)).map((channel) => channel.boardName);
}

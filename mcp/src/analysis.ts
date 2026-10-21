import { CHANNELS } from "./protocol.js";

export interface ChannelMeasurement {
  channel: string;
  pin: string;
  bit: number;
  highCount: number;
  lowCount: number;
  edgeCount: number;
  firstEdgeIndex: number | null;
  lastEdgeIndex: number | null;
  firstEdgeTimeNs: number | null;
  lastEdgeTimeNs: number | null;
  estimatedFrequencyHz: number | null;
}

export function analyzeSamples(samples: Uint8Array, sampleRateHz: number): ChannelMeasurement[] {
  const samplePeriodNs = 1_000_000_000 / sampleRateHz;
  return CHANNELS.map((channel) => {
    let highCount = 0;
    let edgeCount = 0;
    let firstEdgeIndex: number | null = null;
    let lastEdgeIndex: number | null = null;
    let previous = (samples[0] ?? 0) & (1 << channel.bit) ? 1 : 0;
    if (previous === 1) highCount += 1;

    for (let index = 1; index < samples.length; index += 1) {
      const current = (samples[index] ?? 0) & (1 << channel.bit) ? 1 : 0;
      if (current === 1) highCount += 1;
      if (current !== previous) {
        if (firstEdgeIndex === null) firstEdgeIndex = index;
        lastEdgeIndex = index;
        edgeCount += 1;
      }
      previous = current;
    }

    const frequency =
      edgeCount >= 2 && samples.length > 1
        ? (edgeCount / 2 / samples.length) * sampleRateHz
        : null;

    return {
      channel: channel.boardName,
      pin: channel.pin,
      bit: channel.bit,
      highCount,
      lowCount: samples.length - highCount,
      edgeCount,
      firstEdgeIndex,
      lastEdgeIndex,
      firstEdgeTimeNs: firstEdgeIndex === null ? null : firstEdgeIndex * samplePeriodNs,
      lastEdgeTimeNs: lastEdgeIndex === null ? null : lastEdgeIndex * samplePeriodNs,
      estimatedFrequencyHz: frequency,
    };
  });
}

export function findActiveChannels(measurements: ChannelMeasurement[], minimumEdges = 3): string[] {
  return measurements.filter((item) => item.edgeCount >= minimumEdges).map((item) => item.channel);
}

export function exportVcd(samples: Uint8Array, sampleRateHz: number): string {
  const samplePeriodNs = 1_000_000_000 / sampleRateHz;
  const symbols = ["!", '"', "#", "$"];
  const lines = [
    "$version",
    "  AG32 Logic Analyzer MCP VCD Export",
    "$end",
    "$timescale 1ns $end",
    "$scope module ag32_cpld_la $end",
    ...CHANNELS.map((channel, index) => `$var wire 1 ${symbols[index]} ${channel.boardName}_${channel.pin} $end`),
    "$upscope $end",
    "$enddefinitions $end",
    "$dumpvars",
    ...CHANNELS.map((channel, index) => `${(samples[0] ?? 0) & (1 << channel.bit) ? 1 : 0}${symbols[index]}`),
    "$end",
  ];

  const last = CHANNELS.map((channel, index) => (samples[0] ?? 0) & (1 << channel.bit) ? 1 : 0);
  let currentTime = 0;
  for (const sample of samples) {
    for (const channel of CHANNELS) {
      const value = sample & (1 << channel.bit) ? 1 : 0;
      if (value !== last[channel.bit]) {
        lines.push(`#${currentTime}`);
        lines.push(`${value}${symbols[channel.bit]}`);
        last[channel.bit] = value;
      }
    }
    currentTime += samplePeriodNs;
  }
  lines.push(`#${currentTime}`);
  return `${lines.join("\n")}\n`;
}

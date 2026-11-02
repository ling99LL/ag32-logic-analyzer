import type {
  AppSettings,
  DeviceState,
  Pin5EngineConfig,
  Pin11Config,
} from "../shared/types.js";

export type Pin5OutputSource = "square" | "engine";
export type Pin11OutputMode = "waveform" | "off" | "low" | "high";

export interface Pin5OutputDraft {
  source: Pin5OutputSource;
  squareFrequencyHz: number;
  engine: Pin5EngineConfig;
}

export interface Pin11OutputDraft extends Pin11Config {
  mode: Pin11OutputMode;
}

export interface OutputDraft {
  pin5: Pin5OutputDraft;
  pin11: Pin11OutputDraft;
}

export function createOutputDraft(
  settings: AppSettings,
  device: DeviceState,
): OutputDraft {
  const pin11Mode: Pin11OutputMode = device.info?.flags && device.info.flags & 1
    ? "waveform"
    : device.pin11Static === 1
      ? "low"
      : device.pin11Static === 2
        ? "high"
        : "off";
  return {
    pin5: {
      source: device.pin5?.squareSelected === false ? "engine" : "square",
      squareFrequencyHz: settings.pin5SquareHz,
      engine: { ...settings.pin5Engine, action: undefined },
    },
    pin11: {
      waveform: device.info?.waveform ?? settings.pin11.waveform,
      frequencyHz: device.info && device.info.requestedFrequencyHz > 0
        ? device.info.requestedFrequencyHz
        : settings.pin11.frequencyHz,
      amplitudePercent: device.info && device.info.amplitudePercent > 0
        ? device.info.amplitudePercent
        : settings.pin11.amplitudePercent,
      enabled: Boolean(device.info?.flags && device.info.flags & 1),
      rateCapHz: device.info?.rateCapHz ?? settings.pin11.rateCapHz,
      mode: pin11Mode,
    },
  };
}

export function cloneOutputDraft(draft: OutputDraft): OutputDraft {
  return {
    pin5: {
      ...draft.pin5,
      engine: { ...draft.pin5.engine },
    },
    pin11: { ...draft.pin11 },
  };
}

export function outputDomainSignature(
  draft: OutputDraft,
  domain: keyof OutputDraft,
): string {
  return JSON.stringify(draft[domain]);
}

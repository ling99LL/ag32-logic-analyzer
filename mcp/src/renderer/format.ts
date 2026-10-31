export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatFrequency(hz: number | null | undefined): string {
  if (hz === null || hz === undefined || !Number.isFinite(hz)) return "--";
  if (hz >= 1e9) return `${(hz / 1e9).toFixed(3)} GHz`;
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

export function formatTime(ns: number | null | undefined): string {
  if (ns === null || ns === undefined || !Number.isFinite(ns)) return "--";
  if (Math.abs(ns) >= 1e9) return `${(ns / 1e9).toFixed(3)} s`;
  if (Math.abs(ns) >= 1e6) return `${(ns / 1e6).toFixed(3)} ms`;
  if (Math.abs(ns) >= 1e3) return `${(ns / 1e3).toFixed(3)} µs`;
  return `${ns.toFixed(1)} ns`;
}

export function formatTimeValue(value: number, unit: "ns" | "us" | "ms" | "s"): number {
  const scale = { ns: 1, us: 1e3, ms: 1e6, s: 1e9 }[unit];
  return value / scale;
}

export function parseTimeValue(value: number, unit: "ns" | "us" | "ms" | "s"): number {
  const scale = { ns: 1, us: 1e3, ms: 1e6, s: 1e9 }[unit];
  return value * scale;
}

export function sampleRateChoices(): number[] {
  return [
    100_000_000,
    50_000_000,
    20_000_000,
    10_000_000,
    5_000_000,
    1_000_000,
    500_000,
    100_000,
    50_000,
    20_000,
    12_207,
  ];
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

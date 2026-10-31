import { useEffect, useState } from "react";
import {
  Activity,
  CircleOff,
  Flame,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Timer,
  Zap,
} from "lucide-react";
import type {
  AppSettings,
  DeviceState,
  Pin5EngineConfig,
  Pin11Config,
  WaveType,
} from "../../shared/types.js";
import { formatFrequency } from "../format.js";

interface Props {
  settings: AppSettings;
  device: DeviceState;
  disabled: boolean;
  updateSettings: (recipe: (current: AppSettings) => AppSettings) => void;
  configurePin5Square: (frequencyHz: number) => void;
  configurePin5Engine: (config: Pin5EngineConfig) => void;
  configurePin11: (config: Pin11Config) => void;
  configurePin11Static: (mode: 0 | 1 | 2) => void;
}

const WAVE_LABELS: Record<WaveType, string> = {
  sine: "正弦",
  square: "方波",
  sawtooth: "锯齿",
  triangle: "三角",
};

const PIN5_MODES: Array<{ value: Pin5EngineConfig["mode"]; label: string }> = [
  { value: "delayed_level", label: "延时 → 电平" },
  { value: "delayed_pulse", label: "延时 → 脉冲" },
  { value: "host_level", label: "主机 → 电平" },
  { value: "host_pulse", label: "主机 → 脉冲" },
];

export function SignalSources({
  settings,
  device,
  disabled,
  updateSettings,
  configurePin5Square,
  configurePin5Engine,
  configurePin11,
  configurePin11Static,
}: Props) {
  const [pin5Source, setPin5Source] = useState<"square" | "engine">(
    device.pin5?.squareSelected === false ? "engine" : "square",
  );
  const [squareUnit, setSquareUnit] = useState<"Hz" | "kHz" | "MHz">("kHz");
  const [delayUnit, setDelayUnit] = useState<"us" | "ms" | "s">("ms");
  const [widthUnit, setWidthUnit] = useState<"us" | "ms" | "s">("ms");
  const [pin11Unit, setPin11Unit] = useState<"Hz" | "kHz" | "MHz">("kHz");
  const [rateCapMhz, setRateCapMhz] = useState(
    ((settings.pin11.rateCapHz ?? 5_000_000) / 1e6).toFixed(1),
  );

  const engine = settings.pin5Engine;
  const pin11 = settings.pin11;
  const pin11Limit = pin11RateLimit(settings.pin11.rateCapHz ?? 5_000_000, pin11.waveform);

  useEffect(() => {
    if (device.pin5?.squareSelected === false) setPin5Source("engine");
    if (device.pin5?.squareSelected === true) setPin5Source("square");
  }, [device.pin5?.squareSelected]);

  useEffect(() => {
    if (settings.pin11.rateCapHz) setRateCapMhz((settings.pin11.rateCapHz / 1e6).toFixed(1));
  }, [settings.pin11.rateCapHz]);

  return (
    <div className="source-stack">
      <section className="control-section">
        <div className="section-heading">
          <span className="section-icon digital"><Radio size={16} /></span>
          <div>
            <h2>数字输出 PIN_5</h2>
            <p>数字方波或触发/脉冲引擎</p>
          </div>
          <StatusDot active={Boolean(device.pin5)} />
        </div>

        <Segmented
          value={pin5Source}
          options={[
            { value: "square", label: "数字方波" },
            { value: "engine", label: "触发引擎" },
          ]}
          onChange={(value) => setPin5Source(value as "square" | "engine")}
        />

        {pin5Source === "square" ? (
          <div className="control-block">
            <FieldLabel icon={<Activity size={13} />} label="频率" />
            <div className="compound-field">
              <input
                type="number"
                min={0.000001}
                step="any"
                value={fromNano(settings.pin5SquareHz, squareUnit)}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  updateSettings((current) => ({
                    ...current,
                    pin5SquareHz: toNano(value, squareUnit),
                  }));
                }}
              />
              <select
                value={squareUnit}
                onChange={(event) => setSquareUnit(event.target.value as typeof squareUnit)}
              >
                <option>Hz</option>
                <option>kHz</option>
                <option>MHz</option>
              </select>
            </div>
            <div className="range-note">
              1 Hz 至 100 MHz · 实际由 100 MHz 双段分频生成
            </div>
            <button
              className="primary-button full"
              disabled={disabled}
              onClick={() => configurePin5Square(settings.pin5SquareHz)}
            >
              <Zap size={15} />
              应用数字方波
            </button>
          </div>
        ) : (
          <div className="control-block">
            <FieldLabel icon={<SlidersHorizontal size={13} />} label="引擎模式" />
            <select
              className="full-select"
              value={engine.mode}
              onChange={(event) => updateEngine({ mode: event.target.value as Pin5EngineConfig["mode"] })}
            >
              {PIN5_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </select>

            <div className="two-column-fields">
              <div>
                <FieldLabel label="有效电平" />
                <Segmented
                  compact
                  value={engine.activeLevel}
                  options={[{ value: "high", label: "高" }, { value: "low", label: "低" }]}
                  onChange={(value) => updateEngine({ activeLevel: value as "high" | "low" })}
                />
              </div>
              <div>
                <FieldLabel label="空闲电平" />
                <Segmented
                  compact
                  value={engine.idleLevel}
                  options={[{ value: "high", label: "高" }, { value: "low", label: "低" }]}
                  onChange={(value) => updateEngine({ idleLevel: value as "high" | "low" })}
                />
              </div>
            </div>

            <FieldLabel icon={<Timer size={13} />} label="延时" />
            <div className="compound-field">
              <input
                type="number"
                min={0}
                step="any"
                value={fromNano(engine.delayNs, delayUnit)}
                onChange={(event) => updateEngine({ delayNs: toNano(Number(event.target.value), delayUnit) })}
              />
              <select value={delayUnit} onChange={(event) => setDelayUnit(event.target.value as typeof delayUnit)}>
                <option value="us">µs</option>
                <option value="ms">ms</option>
                <option value="s">s</option>
              </select>
            </div>

            <FieldLabel label="脉宽" />
            <div className="compound-field">
              <input
                type="number"
                min={0}
                step="any"
                value={fromNano(engine.widthNs, widthUnit)}
                onChange={(event) => updateEngine({ widthNs: toNano(Number(event.target.value), widthUnit) })}
              />
              <select value={widthUnit} onChange={(event) => setWidthUnit(event.target.value as typeof widthUnit)}>
                <option value="us">µs</option>
                <option value="ms">ms</option>
                <option value="s">s</option>
              </select>
            </div>

            <div className="button-row">
              <button className="primary-button" disabled={disabled} onClick={() => configurePin5Engine({ ...engine })}>
                <Send size={14} />
                应用
              </button>
              <button className="secondary-button" disabled={disabled} onClick={() => configurePin5Engine({ ...engine, action: "arm" })}>
                <Play size={14} />
                布防
              </button>
              <button className="secondary-button" disabled={disabled} onClick={() => configurePin5Engine({ ...engine, action: "fire" })}>
                <Flame size={14} />
                触发
              </button>
              <button className="icon-button bordered" title="复位触发引擎" disabled={disabled} onClick={() => configurePin5Engine({ ...engine, action: "reset" })}>
                <RotateCcw size={15} />
              </button>
            </div>

            <div className="live-status">
              <span className={device.pin5?.busy ? "status-dot busy" : "status-dot"} />
              <span>
                {device.pin5?.busy
                  ? `运行中 · 剩余 ${formatDuration(device.pin5.remainingNs)}`
                  : device.pin5?.done
                    ? "引擎已完成"
                    : "引擎空闲"}
              </span>
              <strong>{device.pin5?.outputHigh ? "HIGH" : "LOW"}</strong>
            </div>
          </div>
        )}
      </section>

      <section className="control-section">
        <div className="section-heading">
          <span className="section-icon analog"><Activity size={16} /></span>
          <div>
            <h2>模拟输出 PIN_11</h2>
            <p>10 bit DAC0 · DMA 循环波表</p>
          </div>
          <StatusDot active={Boolean(device.info?.flags && device.info.flags & 1)} />
        </div>

        <FieldLabel label="波形" />
        <div className="wave-picker">
          {(Object.keys(WAVE_LABELS) as WaveType[]).map((waveform) => (
            <button
              key={waveform}
              className={pin11.waveform === waveform ? "wave-choice active" : "wave-choice"}
              onClick={() => updatePin11({ waveform })}
            >
              <WavePreview waveform={waveform} />
              <span>{WAVE_LABELS[waveform]}</span>
            </button>
          ))}
        </div>

        <FieldLabel icon={<Activity size={13} />} label="频率" />
        <div className="compound-field">
          <input
            type="number"
            min={0.001}
            step="any"
            value={fromNano(pin11.frequencyHz, pin11Unit)}
            onChange={(event) => updatePin11({ frequencyHz: toNano(Number(event.target.value), pin11Unit) })}
          />
          <select value={pin11Unit} onChange={(event) => setPin11Unit(event.target.value as typeof pin11Unit)}>
            <option>Hz</option>
            <option>kHz</option>
            <option>MHz</option>
          </select>
        </div>
        <div className="range-note">当前波形上限 {formatFrequency(pin11Limit)}</div>

        <div className="slider-heading">
          <FieldLabel label="幅度" />
          <strong>{pin11.amplitudePercent}%</strong>
        </div>
        <input
          className="range-input"
          type="range"
          min={1}
          max={100}
          value={pin11.amplitudePercent}
          onChange={(event) => updatePin11({ amplitudePercent: Number(event.target.value) })}
        />

        <details className="advanced-details">
          <summary>DAC 高级参数</summary>
          <FieldLabel label="采样率上限" />
          <div className="compound-field">
            <input
              type="number"
              min={0.001526}
              step="0.1"
              value={rateCapMhz}
              onChange={(event) => {
                setRateCapMhz(event.target.value);
                updatePin11({ rateCapHz: Math.max(1526, Number(event.target.value) * 1e6) });
              }}
            />
            <span className="unit-fixed">MSa/s</span>
          </div>
          <p>默认 5 MSa/s。提高后可能因 DMA 握手产生频率误差。</p>
        </details>

        <label className="switch-row">
          <span>
            <strong>输出使能</strong>
            <small>启动时始终默认关闭</small>
          </span>
          <input
            type="checkbox"
            checked={pin11.enabled}
            onChange={(event) => updatePin11({ enabled: event.target.checked })}
          />
          <i />
        </label>

        <button
          className="primary-button full"
          disabled={disabled}
          onClick={() => configurePin11({
            ...pin11,
            rateCapHz: Math.max(1526, Number(rateCapMhz) * 1e6),
          })}
        >
          <Activity size={15} />
          应用模拟波形
        </button>

        <div className="static-output-row">
          <span>静态输出</span>
          <button className="icon-button bordered" title="关闭 PIN_11" disabled={disabled} onClick={() => configurePin11Static(0)}>
            <CircleOff size={15} />
          </button>
          <button className="text-button" disabled={disabled} onClick={() => configurePin11Static(1)}>LOW</button>
          <button className="text-button" disabled={disabled} onClick={() => configurePin11Static(2)}>HIGH</button>
        </div>
      </section>
    </div>
  );

  function updateEngine(patch: Partial<Pin5EngineConfig>): void {
    updateSettings((current) => ({
      ...current,
      pin5Engine: { ...current.pin5Engine, ...patch },
    }));
  }

  function updatePin11(patch: Partial<Pin11Config>): void {
    updateSettings((current) => ({
      ...current,
      pin11: { ...current.pin11, ...patch },
    }));
  }
}

function FieldLabel({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <label className="field-label">
      {icon}
      {label}
    </label>
  );
}

export function Segmented({
  value,
  options,
  onChange,
  compact = false,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "segmented compact" : "segmented"}>
      {options.map((option) => (
        <button
          key={option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return <span className={active ? "source-status active" : "source-status"} title={active ? "输出已配置" : "输出未启用"} />;
}

function WavePreview({ waveform }: { waveform: WaveType }) {
  const paths: Record<WaveType, string> = {
    sine: "M1 10 C4 1 7 1 10 10 S16 19 19 10",
    square: "M1 16 L1 4 L10 4 L10 16 L19 16 L19 4",
    sawtooth: "M1 16 L10 4 L10 16 L19 4",
    triangle: "M1 16 L6 4 L14 16 L19 4",
  };
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d={paths[waveform]} />
    </svg>
  );
}

function pin11RateLimit(rateCapHz: number, waveform: WaveType): number {
  const points = { sine: 8, square: 2, sawtooth: 4, triangle: 8 }[waveform];
  return Math.floor(rateCapHz / points);
}

function fromNano(value: number, unit: "Hz" | "kHz" | "MHz" | "us" | "ms" | "s"): number {
  const scale = {
    Hz: 1,
    kHz: 1e3,
    MHz: 1e6,
    us: 1e3,
    ms: 1e6,
    s: 1e9,
  }[unit];
  const result = value / scale;
  return Number(result.toFixed(result >= 100 ? 0 : 3));
}

function toNano(value: number, unit: "Hz" | "kHz" | "MHz" | "us" | "ms" | "s"): number {
  const scale = {
    Hz: 1,
    kHz: 1e3,
    MHz: 1e6,
    us: 1e3,
    ms: 1e6,
    s: 1e9,
  }[unit];
  return Math.max(0, value * scale);
}

function formatDuration(ns: number): string {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(0)} ns`;
}

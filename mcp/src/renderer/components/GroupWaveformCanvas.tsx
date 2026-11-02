import { useEffect, useMemo, useRef, useState } from "react";
import { GitCompareArrows, Info, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type {
  CaptureFrame,
  ChannelName,
  SynchronizedCaptureGroup,
} from "../../shared/types.js";
import { formatTime } from "../format.js";

const CHANNELS: ChannelName[] = ["CH1", "CH2", "CH3", "CH4"];
const COLORS: Record<ChannelName, string> = {
  CH1: "#157ad6",
  CH2: "#e09a16",
  CH3: "#9a5ac7",
  CH4: "#159776",
};

interface Props {
  group: SynchronizedCaptureGroup;
  visibility: Record<ChannelName, boolean>;
}

export function GroupWaveformCanvas({ group, visibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 520 });
  const [viewport, setViewport] = useState({ start: 0, end: 1 });
  const decoded = useMemo(() => group.frames.map((entry) => ({
    entry,
    samples: decode(entry.frame),
  })), [group.id]);

  useEffect(() => {
    setViewport({ start: 0, end: 1 });
  }, [group.id]);

  useEffect(() => {
    if (!wrapperRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(320, Math.floor(entry.contentRect.width)),
        height: Math.max(360, Math.floor(entry.contentRect.height)),
      });
    });
    observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    draw(canvasRef.current, group, decoded, visibility, viewport, size);
  }, [decoded, group, size, viewport, visibility]);

  function zoom(factor: number): void {
    setViewport((current) => {
      const span = Math.min(1, Math.max(0.002, (current.end - current.start) * factor));
      const center = (current.start + current.end) / 2;
      let start = center - span / 2;
      if (start < 0) start = 0;
      if (start + span > 1) start = 1 - span;
      return { start, end: start + span };
    });
  }

  return (
    <div className="waveform-shell group-waveform">
      <div className="waveform-toolbar">
        <div className="group-summary">
          <GitCompareArrows size={15} />
          <strong>{group.frames.length} 台设备联合视图</strong>
          <span>主机请求偏差 {group.maxStartSkewMs.toFixed(1)} ms</span>
          <span className="software-sync-badge">软件同步</span>
        </div>
        <div className="toolbar-actions">
          <span className="group-sync-note" title={group.note}>
            <Info size={14} />非设备触发偏差
          </span>
          <button className="icon-button" title="放大" onClick={() => zoom(0.7)}>
            <ZoomIn size={16} />
          </button>
          <button className="icon-button" title="缩小" onClick={() => zoom(1.4)}>
            <ZoomOut size={16} />
          </button>
          <button
            className="icon-button"
            title="显示全部"
            onClick={() => setViewport({ start: 0, end: 1 })}
          >
            <Maximize2 size={16} />
          </button>
        </div>
      </div>
      <div
        ref={wrapperRef}
        className="group-waveform-wrap"
        onWheel={(event) => {
          event.preventDefault();
          zoom(event.deltaY < 0 ? 0.82 : 1.22);
        }}
      >
        <canvas ref={canvasRef} className="waveform-canvas" />
      </div>
    </div>
  );
}

function draw(
  canvas: HTMLCanvasElement | null,
  group: SynchronizedCaptureGroup,
  decoded: Array<{ entry: SynchronizedCaptureGroup["frames"][number]; samples: Uint8Array }>,
  visibility: Record<ChannelName, boolean>,
  viewport: { start: number; end: number },
  size: { width: number; height: number },
): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(size.width * dpr);
  canvas.height = Math.floor(size.height * dpr);
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  const background = color("--wave-bg", "#fff");
  const grid = color("--wave-grid", "#e9edf3");
  const text = color("--wave-text", "#263244");
  const muted = color("--wave-muted", "#8992a3");
  const trigger = color("--amber", "#d58b20");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size.width, size.height);

  const left = 92;
  const right = 18;
  const top = 28;
  const bottom = 24;
  const plotWidth = Math.max(20, size.width - left - right);
  const plotHeight = Math.max(40, size.height - top - bottom);
  const visibleChannels = CHANNELS.filter((channel) => visibility[channel]);
  const lanes = Math.max(1, visibleChannels.length);
  const deviceHeight = plotHeight / Math.max(1, decoded.length);
  const laneHeight = deviceHeight / lanes;

  for (let tick = 0; tick <= 6; tick += 1) {
    const x = left + (plotWidth * tick) / 6;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, top + plotHeight);
    ctx.stroke();
    const frame = group.frames[0]?.frame;
    if (frame && tick < 6) {
      const durationNs = (frame.sampleCount / frame.actualSampleRateHz) * 1e9;
      const time = durationNs * (viewport.start + (viewport.end - viewport.start) * tick / 6);
      ctx.fillStyle = muted;
      ctx.font = '10px "Cascadia Mono", Consolas, monospace';
      ctx.fillText(axisLabel(time), x + 4, 15);
    }
  }

  decoded.forEach(({ entry, samples }, deviceIndex) => {
    const deviceTop = top + deviceIndex * deviceHeight;
    if (deviceIndex > 0) {
      ctx.strokeStyle = color("--border", "#e5e8ef");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, deviceTop + 0.5);
      ctx.lineTo(left + plotWidth, deviceTop + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = text;
    ctx.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(entry.alias || entry.frame.deviceAlias || "设备", 10, deviceTop + 19);
    ctx.fillStyle = muted;
    ctx.font = '9px "Cascadia Mono", Consolas, monospace';
    ctx.fillText(entry.frame.deviceId?.slice(-13) ?? "", 10, deviceTop + 34);

    visibleChannels.forEach((channel, laneIndex) => {
      const center = deviceTop + laneHeight * laneIndex + laneHeight / 2;
      const high = center - Math.min(13, laneHeight * 0.26);
      const low = center + Math.min(13, laneHeight * 0.26);
      ctx.fillStyle = muted;
      ctx.font = '9px "Cascadia Mono", Consolas, monospace';
      ctx.fillText(channel, 61, center + 3);
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(left, low + 6);
      ctx.lineTo(left + plotWidth, low + 6);
      ctx.stroke();
      drawDigital(
        ctx,
        samples,
        visibleChannels.indexOf(channel),
        COLORS[channel],
        left,
        top,
        plotWidth,
        plotHeight,
        viewport,
        high,
        low,
        deviceIndex,
        decoded.length,
        lanes,
      );
    });
  });

  const firstFrame = group.frames[0]?.frame;
  if (firstFrame && firstFrame.pretriggerPercent > 0) {
    const triggerX = left + plotWidth * (firstFrame.pretriggerPercent / 100);
    ctx.strokeStyle = trigger;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(triggerX, top);
    ctx.lineTo(triggerX, top + plotHeight);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawDigital(
  ctx: CanvasRenderingContext2D,
  samples: Uint8Array,
  channelIndex: number,
  color: string,
  left: number,
  top: number,
  plotWidth: number,
  plotHeight: number,
  viewport: { start: number; end: number },
  high: number,
  low: number,
  deviceIndex: number,
  deviceCount: number,
  laneCount: number,
): void {
  if (samples.length === 0) return;
  const first = Math.max(0, Math.floor(viewport.start * samples.length));
  const last = Math.min(samples.length, Math.ceil(viewport.end * samples.length));
  const span = Math.max(1, last - first);
  const bit = 1 << channelIndex;
  let previous = Boolean(samples[first] & bit);
  let y = previous ? high : low;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.35;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(left, y);
  for (let index = first + 1; index < last; index += 1) {
    const current = Boolean(samples[index] & bit);
    if (current === previous) continue;
    const x = left + ((index - first) / span) * plotWidth;
    ctx.lineTo(x, y);
    y = current ? high : low;
    ctx.lineTo(x, y);
    previous = current;
  }
  ctx.lineTo(left + ((last - first) / span) * plotWidth, y);
  ctx.stroke();
  void top;
  void plotHeight;
  void deviceIndex;
  void deviceCount;
  void laneCount;
}

function decode(frame: CaptureFrame): Uint8Array {
  const binary = atob(frame.samplesBase64);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

function axisLabel(ns: number): string {
  if (ns >= 1e9) return `${Number((ns / 1e9).toFixed(3))} s`;
  if (ns >= 1e6) return `${Number((ns / 1e6).toFixed(1))} ms`;
  if (ns >= 1e3) return `${Number((ns / 1e3).toFixed(1))} µs`;
  return `${Math.round(ns)} ns`;
}

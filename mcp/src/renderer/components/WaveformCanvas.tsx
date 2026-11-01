import { useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { CaptureFrame, ChannelName } from "../../shared/types.js";
import { formatTime } from "../format.js";

const CHANNEL_COLORS: Record<ChannelName, string> = {
  CH1: "#157ad6",
  CH2: "#e09a16",
  CH3: "#9a5ac7",
  CH4: "#159776",
};

const CHANNEL_LABELS: Record<ChannelName, string> = {
  CH1: "CH1 · PIN_7",
  CH2: "CH2 · PIN_8",
  CH3: "CH3 · PIN_9",
  CH4: "CH4 · PIN_10",
};

interface Viewport {
  start: number;
  end: number;
}

interface Props {
  frame: CaptureFrame | null;
  visibility: Record<ChannelName, boolean>;
}

export function WaveformCanvas({ frame, visibility }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ start: 0, end: 1 });
  const [size, setSize] = useState({ width: 900, height: 430 });
  const [cursor, setCursor] = useState<number | null>(null);
  const dragRef = useRef<{ x: number; start: number; end: number } | null>(null);

  const samples = useMemo(() => {
    if (!frame) return new Uint8Array();
    const binary = atob(frame.samplesBase64);
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      result[index] = binary.charCodeAt(index);
    }
    return result;
  }, [frame?.id, frame?.samplesBase64]);

  useEffect(() => {
    setViewport({ start: 0, end: 1 });
    setCursor(null);
  }, [frame?.id]);

  useEffect(() => {
    if (!wrapperRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      setSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(260, Math.floor(rect.height)),
      });
    });
    observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    drawWaveform(canvasRef.current, samples, frame, visibility, viewport, size, cursor);
  }, [cursor, frame, samples, size, viewport, visibility]);

  const visibleChannels = (Object.keys(visibility) as ChannelName[]).filter(
    (channel) => visibility[channel],
  );
  const cursorSample = cursor === null ? null : viewport.start * samples.length
    + cursor * samples.length * (viewport.end - viewport.start);
  const cursorTimeNs = frame && cursorSample !== null
    ? (cursorSample / frame.actualSampleRateHz) * 1e9
    : null;

  function zoom(factor: number): void {
    setViewport((current) => {
      const span = (current.end - current.start) * factor;
      const clampedSpan = Math.min(1, Math.max(0.001, span));
      const center = (current.start + current.end) / 2;
      let start = center - clampedSpan / 2;
      let end = center + clampedSpan / 2;
      if (start < 0) {
        start = 0;
        end = clampedSpan;
      }
      if (end > 1) {
        end = 1;
        start = 1 - clampedSpan;
      }
      return { start, end };
    });
  }

  return (
    <div className="waveform-shell">
      <div className="waveform-toolbar">
        <div className="waveform-summary"><span>时间窗口</span>
          <strong>{frame ? formatTime((frame.sampleCount / frame.actualSampleRateHz) * 1e9) : "--"}</strong>
          {frame && <span>{formatTime((frame.sampleCount / frame.actualSampleRateHz) * 1e9 / 10)} / div</span>}
        </div>
        <div className="toolbar-actions">
          {cursorTimeNs !== null && (
            <span className="cursor-readout">
              <Crosshair size={14} />
              T+{formatTime(cursorTimeNs)}
            </span>
          )}
          <button className="icon-button" title="放大" onClick={() => zoom(0.7)}>
            <ZoomIn size={16} />
          </button>
          <button className="icon-button" title="缩小" onClick={() => zoom(1.4)}>
            <ZoomOut size={16} />
          </button>
          <button className="icon-button" title="显示全部" onClick={() => setViewport({ start: 0, end: 1 })}>
            <Maximize2 size={16} />
          </button>
        </div>
      </div>
      <div ref={wrapperRef} className="waveform-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="waveform-canvas"
          onWheel={(event) => {
            event.preventDefault();
            zoom(event.deltaY < 0 ? 0.82 : 1.22);
          }}
          onPointerDown={(event) => {
            dragRef.current = { x: event.clientX, start: viewport.start, end: viewport.end };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          onPointerLeave={() => {
            dragRef.current = null;
          }}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const plotLeft = 78;
            const plotRight = 18;
            const plotWidth = Math.max(1, rect.width - plotLeft - plotRight);
            const x = Math.max(0, Math.min(1, (event.clientX - rect.left - plotLeft) / plotWidth));
            setCursor(x);
            if (!dragRef.current) return;
            const delta = (dragRef.current.x - event.clientX) / plotWidth;
            const span = dragRef.current.end - dragRef.current.start;
            let start = dragRef.current.start + delta * span;
            let end = dragRef.current.end + delta * span;
            if (start < 0) {
              start = 0;
              end = span;
            }
            if (end > 1) {
              end = 1;
              start = 1 - span;
            }
            setViewport({ start, end });
          }}
        />
        {!frame && (
          <div className="waveform-empty">
            <span>选择采样参数后开始采集</span>
          </div>
        )}
        {frame && visibleChannels.length === 0 && (
          <div className="waveform-empty">
            <span>所有通道均已隐藏</span>
          </div>
        )}
      </div>
    </div>
  );
}

function drawWaveform(
  canvas: HTMLCanvasElement | null,
  samples: Uint8Array,
  frame: CaptureFrame | null,
  visibility: Record<ChannelName, boolean>,
  viewport: Viewport,
  size: { width: number; height: number },
  cursor: number | null,
): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(size.width * dpr);
  canvas.height = Math.floor(size.height * dpr);
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const styles = getComputedStyle(document.documentElement);
  const theme = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  const waveBackground = theme("--wave-bg", "#ffffff");
  const waveGrid = theme("--wave-grid", "#e9edf3");
  const waveTrack = theme("--wave-track", "#edf0f5");
  const waveText = theme("--wave-text", "#263244");
  const waveMuted = theme("--wave-muted", "#8992a3");
  const waveformTrigger = theme("--amber", "#dd7f22");
  const waveformCursor = theme("--wave-cursor", "rgba(37, 50, 68, 0.5)");
  context.fillStyle = waveBackground;
  context.fillRect(0, 0, size.width, size.height);

  const left = 78;
  const right = 18;
  const top = 34;
  const bottom = 30;
  const plotWidth = Math.max(10, size.width - left - right);
  const plotHeight = Math.max(10, size.height - top - bottom);
  const visible = (["CH1", "CH2", "CH3", "CH4"] as ChannelName[]).filter(
    (channel) => visibility[channel],
  );
  const trackHeight = plotHeight / Math.max(1, visible.length);

  context.strokeStyle = waveGrid;
  context.lineWidth = 1;
  context.font = '11px "Cascadia Mono", "Consolas", monospace';
  context.fillStyle = waveMuted;
  const durationNs = frame ? (frame.sampleCount / frame.actualSampleRateHz) * 1e9 : 0;
  const tickCount = plotWidth < 420 ? 2 : plotWidth < 900 ? 5 : 7;
  for (let index = 0; index <= tickCount; index += 1) {
    const x = left + (plotWidth * index) / tickCount;
    context.beginPath();
    context.moveTo(x + 0.5, top);
    context.lineTo(x + 0.5, top + plotHeight);
    context.stroke();
    if (frame) {
      const value = durationNs * (viewport.start + ((viewport.end - viewport.start) * index) / tickCount);
      const label = axisLabel(value);
      const textWidth = context.measureText(label).width;
      const textX = Math.max(left + 2, Math.min(x + 4, left + plotWidth - textWidth - 2));
      context.fillText(label, textX, 16);
    }
  }
  for (let index = 0; index <= 8; index += 1) {
    const y = top + (plotHeight * index) / 8;
    context.beginPath(); context.moveTo(left, y + 0.5); context.lineTo(left + plotWidth, y + 0.5); context.stroke();
  }

  visible.forEach((channel, channelIndex) => {
    const center = top + trackHeight * channelIndex + trackHeight / 2;
    const high = center - trackHeight * 0.27;
    const low = center + trackHeight * 0.27;
    context.strokeStyle = waveTrack;
    context.beginPath();
    context.moveTo(left, low + 8);
    context.lineTo(left + plotWidth, low + 8);
    context.stroke();
    context.fillStyle = channel === "CH1" ? waveText : waveMuted;
    context.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif';
    context.fillText(CHANNEL_LABELS[channel], 12, center - 3);
    context.fillStyle = CHANNEL_COLORS[channel];
    context.fillRect(12, center + 4, 48, 2);
  });

  if (!frame || samples.length === 0 || visible.length === 0) return;
  const firstSample = Math.max(0, Math.floor(viewport.start * samples.length));
  const lastSample = Math.min(samples.length, Math.ceil(viewport.end * samples.length));
  const sampleSpan = Math.max(1, lastSample - firstSample);

  visible.forEach((channel, channelIndex) => {
    const bit = Number(channel.slice(2)) - 1;
    const center = top + trackHeight * channelIndex + trackHeight / 2;
    const high = center - trackHeight * 0.27;
    const low = center + trackHeight * 0.27;
    context.strokeStyle = CHANNEL_COLORS[channel];
    context.lineWidth = 1.6;
    context.lineJoin = "round";
    context.beginPath();
    let previous = (samples[firstSample] & (1 << bit)) !== 0;
    let runStart = firstSample;
    let y = previous ? high : low;
    context.moveTo(left, y);
    for (let index = firstSample + 1; index < lastSample; index += 1) {
      const current = (samples[index] & (1 << bit)) !== 0;
      if (current === previous) continue;
      const x = left + ((index - firstSample) / sampleSpan) * plotWidth;
      context.lineTo(x, y);
      y = current ? high : low;
      context.lineTo(x, y);
      runStart = index;
      previous = current;
    }
    const endX = left + ((Math.min(lastSample, samples.length - 1) - firstSample) / sampleSpan) * plotWidth;
    context.lineTo(endX, y);
    context.stroke();
    void runStart;
  });

  if (frame.pretriggerPercent > 0) {
    const triggerX = left + plotWidth * Math.min(1, Math.max(0, frame.pretriggerPercent / 100));
    context.strokeStyle = waveformTrigger;
    context.setLineDash([5, 5]);
    context.beginPath();
    context.moveTo(triggerX, top);
    context.lineTo(triggerX, top + plotHeight);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = waveformTrigger;
    context.font = '10px "Cascadia Mono", "Consolas", monospace';
    context.fillText("TRIGGER", triggerX + 5, top + 12);
  }

  if (cursor !== null) {
    const x = left + cursor * plotWidth;
    context.strokeStyle = waveformCursor;
    context.beginPath();
    context.moveTo(x + 0.5, top);
    context.lineTo(x + 0.5, top + plotHeight);
    context.stroke();
  }

}

function axisLabel(ns: number): string {
  if (ns >= 1e9) return `${Number((ns / 1e9).toFixed(3))} s`;
  if (ns >= 1e6) return `${Number((ns / 1e6).toFixed(1))} ms`;
  if (ns >= 1e3) return `${Number((ns / 1e3).toFixed(1))} µs`;
  return `${Math.round(ns)} ns`;
}

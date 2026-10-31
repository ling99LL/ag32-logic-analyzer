import { useMemo, useState } from "react";
import {
  Database,
  Download,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Search,
  Star,
  Trash2,
  Waves,
} from "lucide-react";
import type { HistoryRecord, StorageUsage } from "../../shared/types.js";
import { formatBytes, formatDateTime, formatFrequency } from "../format.js";

interface Props {
  records: HistoryRecord[];
  usage: StorageUsage | null;
  loading: boolean;
  busy: boolean;
  onRefresh: () => void;
  onLoad: (record: HistoryRecord) => void;
  onFavorite: (record: HistoryRecord, favorite: boolean) => void;
  onDelete: (record: HistoryRecord) => void;
  onOpen: (target: string, reveal?: boolean) => void;
}

export function HistoryView({
  records,
  usage,
  loading,
  busy,
  onRefresh,
  onLoad,
  onFavorite,
  onDelete,
  onOpen,
}: Props) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return records;
    return records.filter((record) =>
      `${record.id} ${record.source} ${record.createdAt}`.toLowerCase().includes(term),
    );
  }, [query, records]);
  const usedPercent = usage ? Math.min(100, (usage.totalBytes / usage.limitBytes) * 100) : 0;

  return (
    <div className="history-view">
      <div className="history-heading">
        <div>
          <span className="eyebrow">采集档案</span>
          <h1>历史记录</h1>
          <p>预览帧留在内存，手动采集和 MCP 采集写入持久记录。</p>
        </div>
        <button className="secondary-button" onClick={onRefresh} disabled={loading || busy}>
          {loading ? <LoaderCircle className="spin" size={15} /> : <Database size={15} />}
          刷新记录
        </button>
      </div>

      <section className="storage-overview">
        <div className="storage-metric">
          <span><Waves size={16} /> 预览缓存</span>
          <strong>{formatBytes(usage?.previewBytes ?? 0)}</strong>
          <small>{usage?.previewFrames ?? 0} / 100 帧</small>
        </div>
        <div className="storage-metric">
          <span><HardDrive size={16} /> 持久记录</span>
          <strong>{formatBytes(usage?.persistentBytes ?? 0)}</strong>
          <small>{usage?.persistentRecords ?? records.length} 条记录</small>
        </div>
        <div className="storage-metric total">
          <span><Database size={16} /> 合计占用</span>
          <strong>{formatBytes(usage?.totalBytes ?? 0)}</strong>
          <small>上限 {formatBytes(usage?.limitBytes ?? 2 * 1024 ** 3)}</small>
        </div>
        <div className="storage-bar-block">
          <div className="storage-bar-label">
            <span>历史容量</span>
            <span>{usedPercent.toFixed(1)}%</span>
          </div>
          <div className="storage-bar">
            <i style={{ width: `${usedPercent}%` }} />
          </div>
          <p>达到上限后自动删除最旧的非收藏记录。</p>
        </div>
      </section>

      <div className="history-toolbar">
        <label className="search-field">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按时间、来源或记录编号筛选"
          />
        </label>
        <span>{filtered.length} 条记录</span>
      </div>

      <div className="history-table-wrap">
        <table className="history-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>来源</th>
              <th>采样率</th>
              <th>深度</th>
              <th>触发</th>
              <th>活动通道</th>
              <th>大小</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((record) => (
              <tr key={record.id} onDoubleClick={() => onLoad(record)}>
                <td>
                  <button className="record-link" onClick={() => onLoad(record)}>
                    {formatDateTime(record.createdAt)}
                  </button>
                  <small>{record.id.slice(-12)}</small>
                </td>
                <td><span className={`source-tag ${record.source}`}>{record.source === "mcp" ? "MCP" : "桌面"}</span></td>
                <td>{formatFrequency(record.sampleRateHz)}</td>
                <td>{record.sampleCount.toLocaleString()} 点</td>
                <td>{triggerLabel(record)}</td>
                <td>{record.channels.filter((channel) => channel.edgeCount > 2).map((channel) => channel.channel).join(" · ") || "静态"}</td>
                <td>{formatBytes(record.sizeBytes)}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className={record.favorite ? "icon-button starred" : "icon-button"}
                      title={record.favorite ? "取消收藏" : "收藏记录"}
                      disabled={busy}
                      onClick={() => onFavorite(record, !record.favorite)}
                    >
                      <Star size={15} fill={record.favorite ? "currentColor" : "none"} />
                    </button>
                    <button className="icon-button" title="打开波形" onClick={() => onLoad(record)}>
                      <Waves size={15} />
                    </button>
                    <button className="icon-button" title="打开 VCD" onClick={() => onOpen(record.vcdPath)}>
                      <Download size={15} />
                    </button>
                    <button className="icon-button" title="在资源管理器中显示" onClick={() => onOpen(record.directory, true)}>
                      <FolderOpen size={15} />
                    </button>
                    <button className="icon-button danger" title="删除记录" disabled={busy} onClick={() => onDelete(record)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 && (
          <div className="history-empty">
            <Database size={28} />
            <strong>{records.length === 0 ? "还没有持久采集记录" : "没有匹配的记录"}</strong>
            <span>{records.length === 0 ? "在分析页点击“采集一帧”后，记录会出现在这里。" : "调整搜索条件再试。"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function triggerLabel(record: HistoryRecord): string {
  if (record.trigger.mode === "immediate") return "立即";
  if (record.trigger.mode === "edge") {
    return (record.trigger.edges ?? [])
      .map((edge) => `${edge.channel}${edge.direction === "rising" ? "↑" : "↓"}`)
      .join(" / ") || "边沿";
  }
  return `${record.trigger.channels?.join("+") ?? "电平"}`;
}

import { useMemo, useState } from "react";
import {
  Archive, Clock3, Database, Download, FolderOpen, HardDrive,
  LoaderCircle, Search, Star, Trash2, Waves,
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

export function HistoryView(props: Props) {
  const { records, usage, loading, busy } = props;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "favorites">("all");
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return records.filter((record) => (filter === "all" || record.favorite)
      && (!term || `${record.id} ${record.source} ${record.createdAt}`.toLowerCase().includes(term)));
  }, [query, records, filter]);
  const usedPercent = usage ? Math.min(100, (usage.totalBytes / usage.limitBytes) * 100) : 0;

  return <div className="history-view">
    <section className="storage-overview">
      <div className="storage-main"><div className="storage-main-icon"><Archive size={22} /></div>
        <div><span>本地采集档案</span><strong>{formatBytes(usage?.totalBytes ?? 0)}</strong>
          <small>预览与持久历史记录总占用</small></div></div>
      <div className="storage-detail"><span><Waves size={16} />内存预览</span><strong>{usage?.previewFrames ?? 0}<small> / 100 帧</small></strong><b>{formatBytes(usage?.previewBytes ?? 0)}</b></div>
      <div className="storage-detail"><span><Database size={16} />持久记录</span><strong>{usage?.persistentRecords ?? records.length}<small> 条</small></strong><b>{formatBytes(usage?.persistentBytes ?? 0)}</b></div>
      <div className="storage-capacity"><div><span><HardDrive size={15} />存储空间</span><strong>{usedPercent.toFixed(1)}%</strong></div>
        <div className="storage-bar"><i style={{ width: `${usedPercent}%` }} /></div>
        <p>{formatBytes(usage?.totalBytes ?? 0)} / {formatBytes(usage?.limitBytes ?? 2 * 1024 ** 3)}</p>
        <small>超出容量后，自动清理最旧的非收藏记录</small></div>
    </section>
    <div className="history-toolbar"><div className="history-filters">
      <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部记录 <span>{records.length}</span></button>
      <button className={filter === "favorites" ? "active" : ""} onClick={() => setFilter("favorites")}><Star size={14} />已收藏</button>
    </div><div className="history-tools"><label className="search-field"><Search size={16} />
      <input aria-label="搜索历史记录" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索时间、来源或记录编号" /></label>
      <button className="icon-button bordered" title="刷新记录" onClick={props.onRefresh} disabled={loading || busy}>
        {loading ? <LoaderCircle className="spin" size={16} /> : <Clock3 size={16} />}</button></div></div>
    <div className="history-table-wrap"><table className="history-table"><thead><tr><th>采集时间</th><th>来源</th><th>采样参数</th><th>触发条件</th><th>活动通道</th><th>文件大小</th><th aria-label="操作" /></tr></thead>
      <tbody>{filtered.map((record) => <tr key={record.id} data-device-id={record.deviceId ?? ""} onDoubleClick={() => props.onLoad(record)}>
        <td><div className="record-time"><button className="record-link" onClick={() => props.onLoad(record)}>{formatDateTime(record.createdAt)}</button><small>{record.id.slice(-12)}</small></div></td>
        <td><span className={`source-tag ${record.source}`}>{record.source === "mcp" ? "MCP" : "桌面端"}</span>
          {record.deviceAlias && <small className="table-subvalue">{record.deviceAlias}</small>}</td>
        <td><strong className="table-value">{formatFrequency(record.sampleRateHz)}</strong><small className="table-subvalue">{record.sampleCount.toLocaleString()} 点</small></td>
        <td>{triggerLabel(record)}</td>
        <td><div className="active-channels">{record.channels.filter((channel) => channel.edgeCount > 2).map((channel) => <span key={channel.channel} className={channel.channel.toLowerCase()}>{channel.channel}</span>)}
          {record.channels.every((channel) => channel.edgeCount <= 2) && "静态"}</div></td>
        <td>{formatBytes(record.sizeBytes)}</td>
        <td><div className="row-actions"><button className={record.favorite ? "icon-button starred" : "icon-button"} title={record.favorite ? "取消收藏" : "收藏记录"} disabled={busy} onClick={() => props.onFavorite(record, !record.favorite)}><Star size={16} fill={record.favorite ? "currentColor" : "none"} /></button>
          <button className="icon-button" title="打开波形" onClick={() => props.onLoad(record)}><Waves size={16} /></button>
          <button className="icon-button" title="打开 VCD" onClick={() => props.onOpen(record.vcdPath)}><Download size={16} /></button>
          <button className="icon-button" title="在资源管理器中显示" onClick={() => props.onOpen(record.directory, true)}><FolderOpen size={16} /></button>
          <button className="icon-button danger" title="删除记录" disabled={busy} onClick={() => props.onDelete(record)}><Trash2 size={16} /></button></div></td>
      </tr>)}</tbody></table>
      {!loading && filtered.length === 0 && <div className="history-empty"><span><Archive size={30} /></span>
        <strong>{records.length === 0 ? "还没有采集档案" : "没有匹配的记录"}</strong>
        <p>{records.length === 0 ? "完成一次采集后，波形和 VCD 文件将保存在这里。" : "试试调整搜索词或记录筛选。"}</p>
        {records.length === 0 && <button className="secondary-button" onClick={props.onRefresh}>刷新历史记录</button>}</div>}
    </div>
  </div>;
}

function triggerLabel(record: HistoryRecord): string {
  if (record.trigger.mode === "immediate") return "立即触发";
  if (record.trigger.mode === "edge") return (record.trigger.edges ?? [])
    .map((edge) => `${edge.channel} ${edge.direction === "rising" ? "上升沿" : "下降沿"}`).join(" / ") || "边沿触发";
  return `${record.trigger.channels?.join(" + ") ?? ""} 电平`;
}

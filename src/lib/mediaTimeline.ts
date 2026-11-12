import type { RecordingRecord, SnapshotRecord } from "../types";

/** 历史时间线把截图和录屏混在一起，按时间倒序排。两者共用 id/名称/大小/时间，只是封面和动作不同 */
type MediaKind = "snapshot" | "recording";

export type MediaItem = {
  id: string;
  kind: MediaKind;
  fileName: string;
  appName: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: number;
  /** 录屏时长（毫秒）；截图没有 */
  durationMs?: number;
};

/** 录屏的真实尺寸和时长由前端 video 元素读元数据得到，读到前先按 16:9 占位 */
export type RecordingMeta = { width: number; height: number; durationMs: number };

const snapshotItem = (record: SnapshotRecord): MediaItem => ({ ...record, kind: "snapshot" });

const recordingItem = (record: RecordingRecord, meta?: RecordingMeta): MediaItem => ({
  id: record.id,
  kind: "recording",
  fileName: record.fileName,
  appName: record.appName,
  width: meta?.width || 16,
  height: meta?.height || 9,
  sizeBytes: record.sizeBytes,
  createdAt: record.createdAt,
  durationMs: meta?.durationMs,
});

/** 合并两类媒体并按时间倒序；调用方拿到的就是可直接分组渲染的时间线 */
export function mergeTimeline(
  snapshots: SnapshotRecord[],
  recordings: RecordingRecord[],
  meta: Record<string, RecordingMeta>,
): MediaItem[] {
  return [
    ...snapshots.map(snapshotItem),
    ...recordings.map((record) => recordingItem(record, meta[record.id])),
  ].sort((a, b) => b.createdAt - a.createdAt);
}
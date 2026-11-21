import { useEffect, useState } from "react";
import {
  getRecordingStatus,
  listActivity,
  onActivity,
  onRecordingChanged,
} from "../lib/backend";
import type { ActivityEntry, RecordingStatus } from "../types";

/** 订阅一个 Tauri 事件；卸载时取消 */
function useTauriListener(subscribe: () => Promise<() => void>) {
  useEffect(() => {
    const pending = subscribe();
    return () => {
      void pending.then((unlisten) => unlisten()).catch(() => {});
    };
    // 只订阅一次：回调里用的都是 setState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function useActivityLog() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    listActivity()
      .then((list) => {
        const next = Array.isArray(list) ? list : [];
        setEntries((current) => (current.length === 0 && next.length === 0 ? current : next));
      })
      .catch(() => {});
  }, []);
  useTauriListener(() =>
    onActivity((entry) => setEntries((list) => [entry, ...list.filter((item) => item.id !== entry.id)].slice(0, 300))),
  );
  return entries;
}

const idle: RecordingStatus = { active: false, target: null, startedAt: null };

function sameRecordingStatus(left: RecordingStatus, right: RecordingStatus): boolean {
  return (
    left.active === right.active &&
    left.target === right.target &&
    left.startedAt === right.startedAt &&
    left.message === right.message
  );
}

export function useRecordingStatus() {
  const [status, setStatus] = useState<RecordingStatus>(idle);
  useEffect(() => {
    getRecordingStatus()
      .then((value) => {
        const next = value ?? idle;
        setStatus((current) => (sameRecordingStatus(current, next) ? current : next));
      })
      .catch(() => {});
  }, []);
  useTauriListener(() =>
    onRecordingChanged((value) => {
      const next = value ?? idle;
      setStatus((current) => (sameRecordingStatus(current, next) ? current : next));
    }),
  );
  return status;
}



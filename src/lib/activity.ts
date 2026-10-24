import type { ActivityEntry } from "../types";
import { getActiveLanguage, translate } from "./i18n";

/** 猫播报用的一句完整的话 */
export function narrate(entry: ActivityEntry): string {
  const language = getActiveLanguage();
  switch (entry.kind) {
    case "capture":
      return translate(language, "{title} 截好了。", { title: entry.title });
    case "record":
      return entry.meta
        ? translate(language, "录好了：{title}，{meta}。", { title: entry.title, meta: entry.meta })
        : translate(language, "录好了：{title}。", { title: entry.title });
    case "polish":
      return entry.meta
        ? translate(language, "润色好了，{meta}。", { meta: entry.meta })
        : translate(language, "润色好了，结果已生成。");
    case "error":
      return translate(language, "{title}：{detail}", {
        title: entry.title,
        detail: entry.detail ?? translate(language, "原因未知"),
      });
    default:
      return entry.title;
  }
}

/** 流水、时间线里的一行短标签 */
export function shortLabel(entry: ActivityEntry): string {
  const language = getActiveLanguage();
  switch (entry.kind) {
    case "capture":
      return translate(language, "截图 {title}", { title: entry.title });
    case "record":
      return entry.meta
        ? translate(language, "录制 {meta} {title}", { meta: entry.meta, title: entry.title })
        : translate(language, "录制 {title}", { title: entry.title });
    case "polish":
      return entry.meta ? translate(language, "润色 {meta}", { meta: entry.meta }) : translate(language, "润色");
    case "error":
      return entry.title;
    default:
      return entry.title;
  }
}

/** 「1920 × 1080」→ 宽高；解析不了返回 null */
export function parseSize(meta?: string): { width: number; height: number } | null {
  const match = meta?.match(/(\d+)\s*[×x]\s*(\d+)/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

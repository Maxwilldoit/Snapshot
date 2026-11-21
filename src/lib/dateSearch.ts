import { formatCalendarDate } from "./format";

type DateMatcher = (year: number, month: number, day: number, hours: number, minutes: number, daysDiff: number, enDate: string) => boolean;

const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function validMonth(m: number) {
  return m >= 1 && m <= 12;
}

function validDay(d: number) {
  return d >= 1 && d <= 31;
}

function validYear(y: number) {
  return y >= 1970 && y <= 2100;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 把用户输入的日期/时间片段解析成匹配函数；不是日期表达时返回 null。 */
function parseDateQuery(raw: string): DateMatcher | null {
  const q = raw.trim().toLowerCase();
  if (!q) return null;

  if (q === "今天" || q === "today") return (_y, _m, _d, _h, _min, daysDiff) => daysDiff === 0;
  if (q === "昨天" || q === "yesterday") return (_y, _m, _d, _h, _min, daysDiff) => daysDiff === 1;

  // HH:MM
  const clock = /^(\d{1,2}):(\d{2})$/.exec(q);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours <= 23 && minutes <= 59) {
      return (_y, _m, _d, h, min) => h === hours && min === minutes;
    }
    return null;
  }

  // 中文年月日：2026年11月21日 / 2026年11月 / 2026年 / 11月21日 / 11月21 / 11月 / 21日 / 21号
  const cnYmd = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号]?)?$/.exec(q);
  if (cnYmd) {
    const year = Number(cnYmd[1]);
    const month = Number(cnYmd[2]);
    const day = cnYmd[3] ? Number(cnYmd[3]) : null;
    if (validYear(year) && validMonth(month) && (day === null || validDay(day))) {
      return (y, m, d) => y === year && m === month && (day === null || d === day);
    }
    return null;
  }

  const cnYear = /^(\d{4})\s*年$/.exec(q);
  if (cnYear) {
    const year = Number(cnYear[1]);
    return validYear(year) ? (y) => y === year : null;
  }

  const cnMd = /^(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号]?)?$/.exec(q);
  if (cnMd) {
    const month = Number(cnMd[1]);
    const day = cnMd[2] ? Number(cnMd[2]) : null;
    if (validMonth(month) && (day === null || validDay(day))) {
      return (_y, m, d) => m === month && (day === null || d === day);
    }
    return null;
  }

  const cnDay = /^(\d{1,2})\s*[日号]$/.exec(q);
  if (cnDay) {
    const day = Number(cnDay[1]);
    return validDay(day) ? (_y, _m, d) => d === day : null;
  }

  // 分隔符形式：2026-11-21 / 2026.11.21 / 2026/11/21 / 2026-11 / 11-21 / 11.21 / 11 21
  const sepYmd = /^(\d{4})\s*[-/. ]\s*(\d{1,2})(?:\s*[-/. ]\s*(\d{1,2}))?$/.exec(q);
  if (sepYmd) {
    const year = Number(sepYmd[1]);
    const month = Number(sepYmd[2]);
    const day = sepYmd[3] ? Number(sepYmd[3]) : null;
    if (validYear(year) && validMonth(month) && (day === null || validDay(day))) {
      return (y, m, d) => y === year && m === month && (day === null || d === day);
    }
    return null;
  }

  const sepMd = /^(\d{1,2})\s*[-/. ]\s*(\d{1,2})$/.exec(q);
  if (sepMd) {
    const month = Number(sepMd[1]);
    const day = Number(sepMd[2]);
    if (validMonth(month) && validDay(day)) {
      return (_y, m, d) => m === month && d === day;
    }
    return null;
  }

  // 纯数字定位日期：21 / 05 / 115 / 1121 / 2026 / 202611 / 261121 / 20261121
  if (/^\d+$/.test(q)) {
    if (q.length <= 2) {
      const n = Number(q);
      if (n >= 1 && n <= 31) {
        return (_y, m, d) => d === n || (n <= 12 && m === n);
      }
      return null;
    }
    if (q.length === 3) {
      const m1 = Number(q.slice(0, 1));
      const d1 = Number(q.slice(1));
      const m2 = Number(q.slice(0, 2));
      const d2 = Number(q.slice(2));
      const can1 = validMonth(m1) && validDay(d1);
      const can2 = validMonth(m2) && validDay(d2);
      if (can1 || can2) {
        return (_y, m, d) => (can1 && m === m1 && d === d1) || (can2 && m === m2 && d === d2);
      }
      return null;
    }
    if (q.length === 4) {
      const n = Number(q);
      const mm = Number(q.slice(0, 2));
      const dd = Number(q.slice(2));
      const isY = validYear(n);
      const isMd = validMonth(mm) && validDay(dd);
      if (isY || isMd) {
        return (y, m, d) => (isY && y === n) || (isMd && m === mm && d === dd);
      }
      return null;
    }
    if (q.length === 6) {
      const yyyy = Number(q.slice(0, 4));
      const mm6 = Number(q.slice(4));
      const yy = 2000 + Number(q.slice(0, 2));
      const mm2 = Number(q.slice(2, 4));
      const dd2 = Number(q.slice(4));
      const isYm = validYear(yyyy) && validMonth(mm6);
      const isYmd = validYear(yy) && validMonth(mm2) && validDay(dd2);
      if (isYm || isYmd) {
        return (y, m, d) => (isYm && y === yyyy && m === mm6) || (isYmd && y === yy && m === mm2 && d === dd2);
      }
      return null;
    }
    if (q.length === 8) {
      const year = Number(q.slice(0, 4));
      const month = Number(q.slice(4, 6));
      const day = Number(q.slice(6, 8));
      if (validYear(year) && validMonth(month) && validDay(day)) {
        return (y, m, d) => y === year && m === month && d === day;
      }
      return null;
    }
    return null;
  }

  // 英文月日（至少 3 字母且以月份缩写开头，避免把普通应用名如 "a" / "ma" 误判成日期）
  if (q.length >= 3 && EN_MONTHS.some((month) => q.startsWith(month))) {
    return (_y, _m, _d, _h, _min, _daysDiff, enDate) => enDate.includes(q);
  }

  return null;
}

function evalDateMatcher(matcher: DateMatcher, timestamp: number, now: number): boolean {
  const date = new Date(timestamp);
  const daysDiff = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
  const enDate = formatCalendarDate(timestamp, now, "en").toLowerCase();
  return matcher(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    daysDiff,
    enDate,
  );
}

export function matchesDateQuery(timestamp: number, query: string, now = Date.now()): boolean {
  const matcher = parseDateQuery(query);
  return matcher ? evalDateMatcher(matcher, timestamp, now) : false;
}

/** 从 bundle id 或 .app 路径抽出末尾应用名，便于用英文/原名搜索，同时避免误命中 "com" / "apple"。 */
export function appIdSearchName(appId: string | null | undefined): string {
  if (!appId) return "";
  const base = appId.split(/[\\/]/).pop() ?? appId;
  const withoutApp = base.replace(/\.app$/i, "");
  return withoutApp.includes(".") ? (withoutApp.split(".").pop() ?? withoutApp) : withoutApp;
}

/**
 * 统一的列表搜索匹配：
 * - 命中任意文本字段（应用名、剪贴板文字、Prompt 内容等）即匹配；
 * - 输入数字或日期表达时按日期定位；
 * - 支持空格组合（例如「相 21」「微信 11.21」），但独立日期表达（如「11 21」）不拆词误伤。
 */
export function matchesSearchEntry(
  createdAt: number,
  texts: Array<string | null | undefined>,
  rawQuery: string,
  now = Date.now(),
): boolean {
  const trimmed = rawQuery.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  const normalizedTexts = texts
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase());
  const matchesText = (token: string) => normalizedTexts.some((value) => value.includes(token));

  if (matchesText(lower)) return true;

  const wholeDate = parseDateQuery(lower);
  if (wholeDate) return evalDateMatcher(wholeDate, createdAt, now);

  const tokens = lower.split(/\s+/);
  if (tokens.length <= 1) return false;

  return tokens.every((token) => matchesText(token) || matchesDateQuery(createdAt, token, now));
}

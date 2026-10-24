import { coreEnglish } from "./core";
import { historyEnglish } from "./history";
import { petEnglish } from "./pet";
import { shortcutsEnglish } from "./shortcuts";
import { windowsEnglish } from "./windows";

export const englishMessages: Record<string, string> = {
  ...coreEnglish,
  ...shortcutsEnglish,
  ...historyEnglish,
  ...petEnglish,
  ...windowsEnglish,
};

import assert from "node:assert/strict";
import { test } from "node:test";
import { referencedKeys } from "../i18n-usage.mjs";

test("indirect labels, JSX attributes, and template literals keep their translations", () => {
  const keys = referencedKeys([
    'const labels = [{name: "截图"}]; t(labels[0].name); const hint = `正在读取`; <button aria-label="重试" />;',
  ], []);
  for (const key of ["截图", "正在读取", "重试"]) assert.ok(keys.has(key), key);
});

test("backend messages keep translations even without frontend literal calls", () => {
  const keys = referencedKeys([], ['ui_text("已保存", "Saved"); format!("录制 {target}");']);
  assert.ok(keys.has("已保存"));
  assert.ok(keys.has("录制 {target}"));
  assert.ok(keys.has("已复制标注图，30 秒后自动清空剪贴板"));
});

test("TypeScript generic arrows are parsed with the actual file extension", () => {
  const keys = referencedKeys([{ file: "labels.ts", text: 'const identity = <T>(value: T) => value; identity("截图");' }], []);
  assert.ok(keys.has("截图"));
});

test("comments and test-only Rust strings do not keep obsolete UI copy", () => {
  const keys = referencedKeys(['// t("旧文案")\nconst text = "仍在使用";'], ['let text = "运行时"; #[cfg(test)] mod tests { let text = "仅测试"; }']);
  assert.ok(!keys.has("旧文案"));
  assert.ok(!keys.has("仅测试"));
  assert.ok(keys.has("仍在使用"));
  assert.ok(keys.has("运行时"));
});

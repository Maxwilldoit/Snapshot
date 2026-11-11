import { parseSync, Visitor } from "oxc-parser";

// Metadata, ternaries, and label maps can reach t(variable). Treat all production
// string literals as references, rather than only searching for t("literal").
export function referencedKeys(frontendSources, rustSources) {
  // annotate_copy composes these from a prefix and format_clear_label. They may
  // arrive while windows switch language, so preserve their exact translations.
  const keys = new Set([
    "已复制标注图，30 秒后自动清空剪贴板",
    "已复制标注图，60 秒后自动清空剪贴板",
    "已复制标注图，5 分钟后自动清空剪贴板",
    "已复制标注图，不会自动清空剪贴板",
  ]);
  for (const source of frontendSources) {
    const { file, text } = typeof source === "string" ? { file: "source.tsx", text: source } : source;
    const result = parseSync(file, text);
    if (result.errors.length) throw new Error(result.errors[0].message);
    new Visitor({
      Literal(node) { if (typeof node.value === "string") keys.add(node.value); },
      TemplateLiteral(node) { if (!node.expressions.length) keys.add(node.quasis[0].value.cooked); },
    }).visit(result.program);
  }
  // Rust success messages, action labels, and errors cross the IPC boundary.
  // Never infer that a dictionary entry is unused solely from frontend calls.
  for (const source of rustSources) {
    for (const match of source.split("#[cfg(test)]")[0].matchAll(/"(?:\\.|[^"\\])*"/g)) {
      try { keys.add(JSON.parse(match[0])); } catch { /* Rust-specific escapes are not UI keys. */ }
    }
  }
  return keys;
}

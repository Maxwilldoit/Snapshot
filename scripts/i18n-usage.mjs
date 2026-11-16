import { parseSync, Visitor } from "oxc-parser";

// Metadata, ternaries, and label maps can reach t(variable). Treat all production
// string literals as references, rather than only searching for t("literal").
export function referencedKeys(frontendSources, rustSources) {
  const keys = new Set();
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

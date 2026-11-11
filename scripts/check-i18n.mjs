import fs from "node:fs";
import path from "node:path";
import { referencedKeys } from "./i18n-usage.mjs";

const sourceRoot = "src";
const messagesRoot = path.join(sourceRoot, "i18n", "messages");
const han = /\p{Script=Han}/u;
const sourceFiles = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) sourceFiles.push(file);
  }
}
walk(sourceRoot);

const dictionary = new Set();
for (const file of fs.readdirSync(messagesRoot)) {
  if (file === "errors.ts" || !file.endsWith(".ts")) continue;
  const text = fs.readFileSync(path.join(messagesRoot, file), "utf8");
  for (const match of text.matchAll(/^\s*"((?:\\.|[^"\\])+)"\s*:/gm)) {
    dictionary.add(JSON.parse(`"${match[1]}"`));
  }
}

const used = new Map();
const add = (source, file, index) => {
  if (!han.test(source)) return;
  const line = fs.readFileSync(file, "utf8").slice(0, index).split("\n").length;
  used.set(source, `${file}:${line}`);
};

const unwrapped = [];
const untranslatedBackend = [];
for (const file of sourceFiles) {
  if (path.resolve(file).startsWith(path.resolve(messagesRoot))) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/\bt\(\s*"((?:\\.|[^"\\])*)"/g)) add(JSON.parse(`"${match[1]}"`), file, match.index);
  for (const match of text.matchAll(/\btranslate\(\s*[^,]+,\s*"((?:\\.|[^"\\])*)"/g)) add(JSON.parse(`"${match[1]}"`), file, match.index);

  // 后端原文（失败原因、错误信息）塞进翻译模板前要先过 localizeMessage / errorText，
  // 否则英文界面里会出现「英文句子（中文原因）」这样的混排。
  for (const match of text.matchAll(/\bt\(\s*"(?:\\.|[^"\\])*"\s*,\s*\{([^{}]*)\}/g)) {
    for (const param of match[1].matchAll(/(\w+)\s*:\s*([\w$.?]+)\s*(?=,|$)/g)) {
      if (/\.(?:reason|message|error|detail)$/.test(param[2])) {
        const line = text.slice(0, match.index).split("\n").length;
        untranslatedBackend.push(`${file}:${line} ${param[1]}: ${param[2]}`);
      }
    }
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!han.test(line) || trimmed.startsWith("//") || trimmed.startsWith("*") || line.includes("t(") || line.includes("translate(")) return;
    if (/>[^<{]*\p{Script=Han}[^<{]*</u.test(line) || /\b(?:aria-label|placeholder|title|alt)="[^"]*\p{Script=Han}[^"]*"/u.test(line)) {
      unwrapped.push(`${file}:${index + 1} ${trimmed}`);
    }
  });
}

// Backend errors reach the UI as Chinese strings and are translated by localizeMessage
// (errors.ts exact keys, then its patterns), so every Chinese error literal in Rust needs a match there.
const errorsText = fs.readFileSync(path.join(messagesRoot, "errors.ts"), "utf8");
const errorKeys = new Set(dictionary);
for (const match of errorsText.matchAll(/^\s*"((?:\\.|[^"\\])+)"\s*:/gm)) errorKeys.add(JSON.parse(`"${match[1]}"`));
const errorPatterns = [...errorsText.matchAll(/^\s*\[\/(.+)\/([a-z]*),\s*"/gm)].map((match) => new RegExp(match[1], match[2]));
const rustErrors = [];
const rustFiles = [];
(function walkRust(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walkRust(file);
    else if (entry.name.endsWith(".rs")) rustFiles.push(file);
  }
})(path.join("src-tauri", "src"));
const errorSite = /(?:\bErr\(|\.ok_or\(|\.ok_or_else\(\|\|\s*|\.map_err\(\|[^|]*\|\s*\{?\s*)\s*(format!\(\s*)?"((?:\\.|[^"\\])*)"/g;
for (const file of rustFiles) {
  const full = fs.readFileSync(file, "utf8");
  const text = full.split("#[cfg(test)]")[0];
  for (const match of text.matchAll(errorSite)) {
    const literal = match[2].replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n");
    if (!han.test(literal)) continue;
    const sample = match[1] ? literal.replace(/\{\{/g, "\u0001").replace(/\}\}/g, "\u0002").replace(/\{[^}]*\}/g, "1").replace(/\u0001/g, "{").replace(/\u0002/g, "}") : literal;
    if (errorKeys.has(sample) || errorPatterns.some((pattern) => pattern.test(sample))) continue;
    const line = full.slice(0, match.index).split("\n").length;
    rustErrors.push(`${file}:${line} ${JSON.stringify(literal)}`);
  }
}

const missing = [...used].filter(([source]) => !dictionary.has(source));
const references = referencedKeys(
  sourceFiles.filter((file) => !path.resolve(file).startsWith(path.resolve(messagesRoot))).map((file) => ({ file, text: fs.readFileSync(file, "utf8") })),
  rustFiles.map((file) => fs.readFileSync(file, "utf8")),
);
const unused = [...dictionary].filter((key) => !references.has(key));
if (missing.length || unwrapped.length || rustErrors.length || untranslatedBackend.length || unused.length) {
  for (const key of unused) console.error(`Unreferenced UI translation: ${JSON.stringify(key)}`);
  for (const [source, location] of missing) console.error(`Missing English copy: ${location} ${JSON.stringify(source)}`);
  for (const finding of unwrapped) console.error(`Unwrapped UI text: ${finding}`);
  for (const finding of rustErrors) console.error(`Backend error without English: ${finding}`);
  for (const finding of untranslatedBackend) console.error(`Backend text interpolated without localizeMessage: ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${used.size} direct UI strings, ${dictionary.size} referenced translations, and backend errors; no missing or unreferenced copy.`);
}

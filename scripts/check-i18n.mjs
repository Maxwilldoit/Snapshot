import fs from "node:fs";
import path from "node:path";

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
for (const file of sourceFiles) {
  if (path.resolve(file).startsWith(path.resolve(messagesRoot))) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/\bt\(\s*"((?:\\.|[^"\\])*)"/g)) add(JSON.parse(`"${match[1]}"`), file, match.index);
  for (const match of text.matchAll(/\btranslate\(\s*[^,]+,\s*"((?:\\.|[^"\\])*)"/g)) add(JSON.parse(`"${match[1]}"`), file, match.index);

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!han.test(line) || trimmed.startsWith("//") || trimmed.startsWith("*") || line.includes("t(") || line.includes("translate(")) return;
    if (/>[^<{]*\p{Script=Han}[^<{]*</u.test(line) || /\b(?:aria-label|placeholder|title|alt)="[^"]*\p{Script=Han}[^"]*"/u.test(line)) {
      unwrapped.push(`${file}:${index + 1} ${trimmed}`);
    }
  });
}

const missing = [...used].filter(([source]) => !dictionary.has(source));
if (missing.length || unwrapped.length) {
  for (const [source, location] of missing) console.error(`Missing English copy: ${location} ${JSON.stringify(source)}`);
  for (const finding of unwrapped) console.error(`Unwrapped UI text: ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${used.size} translated UI strings; no missing English copy or unwrapped JSX text.`);
}

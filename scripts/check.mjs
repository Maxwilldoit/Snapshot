import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// npm supplies its own CLI path on every platform; avoid spawning npm.cmd through a shell.
const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
const scope = process.argv[2] ?? "all";
if (!npmCli || !["all", "frontend", "rust"].includes(scope)) {
  console.error("Use npm run check, npm run check:frontend, or npm run check:rust.");
  process.exit(1);
}
if (Number(process.versions.node.split(".")[0]) !== 22) {
  console.error("Checks require Node 22, matching .nvmrc and CI. Run nvm use first.");
  process.exit(1);
}

function run(label, command, args) {
  console.log(`\n${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const npm = (script) => run(`npm run ${script}`, process.execPath, [npmCli, "run", script]);
const cargo = (...args) => run(`cargo ${args.join(" ")}`, "cargo", args);
const manifest = ["--manifest-path", "src-tauri/Cargo.toml"];

if (scope !== "rust") {
  npm("test");
  npm("build");
}
if (scope !== "frontend") {
  cargo("fmt", ...manifest, "--check");
  if (process.platform === "darwin") npm("prepare:sidecars");
  cargo("clippy", ...manifest, "--all-targets", "--", "-D", "warnings");
  cargo("test", ...manifest);
}

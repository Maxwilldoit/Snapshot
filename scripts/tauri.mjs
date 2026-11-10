// 本机安装的包必须沿用证书签名；ad-hoc 的 designated requirement 随代码变化，
// 更新后系统设置即使保留勾选，TCC 也不会认可旧的屏幕录制授权。
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function needsLocalSigning(platform, args, env) {
  if (platform !== "darwin" || env.CI || !["build", "bundle"].includes(args[0])) return false;
  const targetIndex = args.findIndex((arg) => arg === "--target" || arg === "-t");
  const target = args.find((arg) => arg.startsWith("--target="))?.slice(9)
    ?? (targetIndex >= 0 ? args[targetIndex + 1] : undefined);
  return !target || target.endsWith("-apple-darwin");
}

export function selectSigningIdentity(explicitIdentity, identities) {
  if (explicitIdentity?.trim()) return explicitIdentity.trim();
  const candidates = [...identities.matchAll(/\b([A-Fa-f0-9]{40}) "(Apple Development: [^"]+)"/g)];
  if (candidates.length !== 1) {
    throw new Error("macOS 本机构建需要稳定的签名证书。请用 security find-identity -v -p codesigning 查看，并通过 APPLE_SIGNING_IDENTITY 指定；若明确只要临时包，可设为 '-'（更新后需重新授权屏幕录制）。");
  }
  return candidates[0][1];
}

async function main() {
  const args = process.argv.slice(2);
  if (needsLocalSigning(process.platform, args, process.env)) {
    const explicit = process.env.APPLE_SIGNING_IDENTITY;
    const identities = explicit?.trim() ? "" : execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const identity = selectSigningIdentity(explicit, identities);
    process.env.APPLE_SIGNING_IDENTITY = identity;
    console.log(identity === "-"
      ? "警告：正在生成临时 ad-hoc 签名包，替换已安装应用后可能需要移除旧授权并重新添加。"
      : `macOS 使用稳定签名证书：${identity}`);
  }
  const { run } = await import("@tauri-apps/cli");
  await run(args, "npm run tauri");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

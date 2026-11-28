#!/usr/bin/env bash
# 装包冒烟：装上 deb（或直接运行 AppImage），在无头 X（Xvfb）里启动应用，活过一段时间就算通过。
# 缺依赖、glibc 不够新、一启动就崩，都会在这里暴露。发版前在 Ubuntu 22.04 和 24.04 上各跑一遍，
# 确认同一份包在这两代系统上都装得上、起得来。会往系统里装包，只在 CI 或一次性的机器上用。
#
# 用法：scripts/linux/smoke-test.sh deb <包路径>
#       scripts/linux/smoke-test.sh appimage <包路径>
# 环境变量 SMOKE_SECONDS：要活过的秒数，默认 15。
set -euo pipefail

kind="${1:?用法：smoke-test.sh deb|appimage <包路径>}"
package="$(realpath "${2:?缺少包路径}")"
seconds="${SMOKE_SECONDS:-15}"

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
# Xvfb 提供无头 X；dbus 提供会话总线；xdotool 用于点击侧栏验证切页不崩（如 WebKitGTK 非加速合成）
sudo apt-get install -y -qq xvfb xauth dbus xdotool >/dev/null

case "$kind" in
  deb)
    # 绝对路径才会被 apt 当成本地包；依赖按包里声明的从源里装，装不上说明依赖写错了
    sudo apt-get install -y -qq "$package" >/dev/null
    app=/usr/bin/snapshot
    ;;
  appimage)
    chmod +x "$package"
    app="$package"
    # CI 机器上不一定有 FUSE，解开再跑
    export APPIMAGE_EXTRACT_AND_RUN=1
    ;;
  *)
    echo "error: 不认识的包类型：$kind（只认 deb / appimage）" >&2
    exit 2
    ;;
esac

log="$(mktemp)"
run_smoke_pass() {
  local mode_label="$1"
  shift
  : >"$log"
  setsid "$@" dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" bash -c '
    "$1" &
    app_pid=$!
    sleep 4
    # 找到主窗口并点击侧栏导航项，确保页面切换不会触发 WebKitGTK 崩溃
    for wid in $(xdotool search --onlyvisible 2>/dev/null || true); do
      geom="$(xdotool getwindowgeometry --shell "$wid" 2>/dev/null || true)"
      if printf "%s\n" "$geom" | grep -qE "^WIDTH=(8[2-9][0-9]|9[0-9]{2}|1[0-9]{3})$"; then
        xdotool mousemove --window "$wid" 80 105 click 1 2>/dev/null || true
        sleep 1
        xdotool mousemove --window "$wid" 80 140 click 1 2>/dev/null || true
        break
      fi
    done
    wait "$app_pid"
  ' _ "$app" >"$log" 2>&1 &
  local group=$!
  sleep "$seconds"
  if ! kill -0 "$group" 2>/dev/null; then
    echo "error: $kind ($mode_label) 启动或切页后不到 ${seconds} 秒就退出了" >&2
    cat "$log" >&2
    rm -f "$log"
    exit 1
  fi
  kill -TERM -- "-$group" 2>/dev/null || true
  wait "$group" 2>/dev/null || true
  if grep -q "panicked" "$log"; then
    echo "error: $kind ($mode_label) 运行期间 panic 了" >&2
    cat "$log" >&2
    rm -f "$log"
    exit 1
  fi
}

trap 'rm -f "$log"' EXIT
run_smoke_pass "default"
run_smoke_pass "WEBKIT_DISABLE_COMPOSITING_MODE=1" env WEBKIT_DISABLE_COMPOSITING_MODE=1

echo "OK：$kind 默认与非加速合成模式启动及侧栏切页均活过了 ${seconds} 秒"
echo "--- 应用输出（最后 30 行）"
tail -n 30 "$log"

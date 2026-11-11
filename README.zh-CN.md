# 应用快照

[![Check](https://github.com/Maxwilldoit/Snapshot/actions/workflows/check.yml/badge.svg)](https://github.com/Maxwilldoit/Snapshot/actions/workflows/check.yml)

简体中文 | [English](README.md)

截取窗口，复制或标注，再从历史记录里找回来。
应用快照也支持窗口录屏、Prompt 润色与保存，以及桌面伴侣。
基于 Tauri 2、React 和 Windows、macOS、Linux 原生适配器构建。

## 功能

- **截图**：截取窗口或全屏，复制、打开标注或仅保存到历史。Linux X11 还支持长截图。
- **录屏**：将选中的窗口录制为 MP4，可选系统声音和麦克风。
- **历史记录**：截图与 Prompt 润色各有独立、可搜索的页面；Prompt 记录保留原文、结果、规则和时间。
- **Prompt**：使用 OpenAI 兼容接口与可复用规则润色剪贴板文本；API Key 保存在系统凭证库。独立的 Prompt 库保存常用文本。
- **桌面伴侣**：显示前台应用图标或导入 GIF/WebM 动作，支持自由走动、随机动作、重力和右键快捷菜单。Windows、Linux 另有启动台。
- **快捷键**：绑定常用操作，或暂停全局快捷键并保留绑定。
- **界面**：中英文、跟随系统的浅色与深色外观；语言在通用页切换。

## 平台支持

| 功能 | Windows | macOS | Linux |
|---|:-:|:-:|:-:|
| 窗口截图与全屏截图 | ✓ | ✓ | ✓ |
| 窗口录制 | ✓ | ✓ | ✓ |
| 系统声音与麦克风 | ✓ | 麦克风需 macOS 15+ | ✓ |
| 滚动长截图 | — | — | 仅 X11 |
| 历史、标注、Prompt 润色与 Prompt 库、桌面伴侣 | ✓ | ✓ | ✓ |
| 启动台 | ✓ | — | ✓ |
| 开机启动 | ✓ | ✓ | ✓ |
| 全局快捷键 | ✓ | ✓ | 取决于桌面环境 |

应用会在运行时检测功能是否可用。Windows 的真机验证最完整，其余平台待验证项目见 [docs/pending-device-verification.md](docs/pending-device-verification.md)。

## 安装

从 [Releases](https://github.com/Maxwilldoit/Snapshot/releases) 下载对应平台的安装包。

| 平台 | 安装包 |
|---|---|
| Windows 10/11 | x64 或 ARM64 安装程序 |
| macOS 14+ | Apple Silicon 与 Intel 共用的 universal ZIP |
| Ubuntu 22.04+ / Debian 12+ | x86_64 或 aarch64 `.deb` |
| 其它 Linux 发行版 | x86_64 或 aarch64 AppImage，要求 glibc 2.35+ |

安装包目前没有正式代码签名和公证。macOS 首次打开需按住 Control 点击应用并选择“打开”；Windows 上 SmartScreen 可能提示风险。Windows 10 缺少 WebView2 时，安装程序会按需下载。

macOS 读取窗口列表、截图和录制需要“屏幕录制”权限，还原最小化窗口需要“辅助功能”权限，录音需要麦克风权限。窗口选择器提示缺少权限时，点击 **打开系统设置**，在 **隐私与安全性 → 屏幕录制** 中允许应用快照，然后点击 **重新读取**。若权限已开启仍无法读取，请退出并重新打开应用。缺少权限会显示授权说明，不再误报为没有可用窗口。

若更新后已开启权限并重启仍提示授权，可能是旧版 ad-hoc 签名对应的授权记录失效：在屏幕录制设置中选中旧的应用快照，点 **−** 移除，再点 **+** 添加 `/Applications/snapshot.app` 并开启权限，然后退出并重新打开应用。无需清空所有应用的权限。

### Linux 运行依赖

Windows 和 macOS 不需要额外运行工具。Linux 可按需安装：

| 工具 | 用途 |
|---|---|
| `ffmpeg` | 窗口录制，以及包含鼠标指针的静态截图 |
| `pactl` | 通过 PulseAudio 或 PipeWire-Pulse 录制系统声音和麦克风 |
| `xdotool` | 还原最小化窗口和滚动长截图 |
| StatusNotifierHost | 系统托盘；GNOME 需要 AppIndicator 扩展 |

各发行版的构建依赖和支持范围见 [scripts/linux/README.md](scripts/linux/README.md)。

## 使用

- **截图**：使用截图按钮、伴侣快捷菜单或全局快捷键。在 **截图与录制** 中选择复制、打开标注或仅保存，并配置历史、剪贴板清空时间、格式和目录。默认 60 秒后清空截图剪贴板；期间复制其它内容则不会误清。
- **录屏**：在录屏菜单里选择窗口。MP4 默认保存到下载目录，在 **截图与录制** 中修改位置。录屏文件与截图历史分开保存。
- **润色 Prompt**：在 **Prompt 记录 → 设置** 中配置模型和规则，再从快捷菜单或快捷键润色剪贴板文本。结果进入 **Prompt 记录**。
- **复用 Prompt**：从 Prompt 记录、快捷菜单或快捷键（默认 `Ctrl/Cmd+Shift+P`）打开 Prompt 库，搜索、编辑和复制，复制后窗口保持打开。
- **伴侣**：从侧栏导入 GIF/WebM 或 ZIP，选择伴侣后在对应页面调整桌面行为。Windows 和 Linux 双击伴侣打开启动台；macOS 单击切换动作。

## 伴侣素材

- 每个动作使用一个 GIF 或 WebM；文件名包含 `idle` 或 `待机` 的文件作为默认待机动作。
- 文件名包含 `walk`、`run`、`move`、`走` 或 `跑` 的文件属于走路动作；加入 `left`/`左` 或 `right`/`右` 指定方向。只有一个方向时，另一方向使用镜像。
- 导入 GIF 时会移除与画布边缘相连的背景色，人物内部的颜色（例如白衬衫）会保留；WebM 应自带透明通道。
- 压缩包上限 100 MB，单个动画文件上限 50 MB。
- WebM 应使用带 alpha 通道的 VP9，由 WebView 直接播放；透明 WebM 的实际兼容性取决于平台 WebView。
- 超出基准画布的动作可通过 `pet.json` 共用基准尺寸和脚底锚点，具体格式见 [Pets 素材作者说明](https://github.com/Maxwilldoit/Pets/blob/main/catalog/README.md#给素材作者按事件设计动作)。

## 从源码构建

需要 Node.js 22、Rust 1.98.1、对应平台的 [Tauri 2 构建依赖](https://v2.tauri.app/start/prerequisites/)；macOS 还需要 Swift 工具链来构建 ScreenCaptureKit 录制组件。

```bash
nvm use
npm ci
npm run tauri dev
npm run tauri build
```

macOS 本机 `build` / `bundle` 默认使用钥匙串中唯一有效的 **Apple Development** 证书签名，以保持更新前后的授权身份一致；证书缺失或存在多个时会停止并要求明确指定。可通过 `APPLE_SIGNING_IDENTITY="证书名称或指纹" npm run tauri build` 指定其它已安装的签名证书。不要对已签名包再执行 `codesign --sign -`。CI 与显式 `APPLE_SIGNING_IDENTITY=-` 仍可生成 ad-hoc 包，但替换后可能需要按上述步骤重新授权；此类包未公证。

Debian 或 Ubuntu 可运行 `sudo bash scripts/linux/install-deps.sh` 安装构建与运行依赖。

## 验证

```bash
nvm use
npm ci
npm run check              # 前端测试、翻译、构建、Rust fmt/Clippy/test
npm run check:frontend     # 只跑前端部分
npm run check:rust         # 只跑 Rust 部分，macOS 自动准备录制组件
npm run check:unused       # Knip 死代码报告
npm audit --audit-level=moderate
```

CI 在 macOS、Windows、Ubuntu 22.04 和 24.04 复用同一检查入口，另做依赖审计。`npm run dev` 的浏览器预览使用模拟数据，可加 `?demo`；真实截图、录屏和权限需要单独验证。

代码地图见 [AGENTS.md](AGENTS.md)，界面规则见 [DESIGN.md](DESIGN.md)，本轮简化的检查点和回退命令见 [docs/SIMPLIFY.md](docs/SIMPLIFY.md)。

## 目录结构

```text
src/
├── pages/              主窗口页面
├── windows/            桌面伴侣、快捷菜单、标注、启动台和素材库窗口
└── i18n/               英文界面文案与覆盖检查
src-tauri/
├── src/os/<platform>/  各平台截图、录制、输入和启动实现
└── snapshot-recorder/  macOS ScreenCaptureKit 录制组件
scripts/                构建、打包和本地化检查脚本
docs/                   平台验证记录与截图
```

跨平台一致的业务逻辑放在 React 和 Rust 应用层；系统能力相关的部分按平台使用原生接口，包括 Windows.Graphics.Capture 与 Media Foundation、macOS 的 ScreenCaptureKit 与 AVAssetWriter，以及 Linux 的 portal/PipeWire 或 ffmpeg。

## 发布

推送 `v*` 标签会启动发布流程，构建 macOS universal、Windows x64/ARM64、Linux x86_64/aarch64 安装包，在 Ubuntu 22.04 和 24.04 上验证 Linux 包，生成 `SHA256SUMS.txt`，并创建供最终检查的 GitHub 草稿发行版。

## 许可证

Copyright (C) 2026 Snapshot contributors.

本项目以 [GNU 通用公共许可证第 3 版或更新版本](LICENSE)（GPL-3.0-or-later）发布。向他人分发修改后的版本时，也必须以 GPL 提供相应源代码。

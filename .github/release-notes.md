# 应用快照 {{VERSION}}

## 本次更新

- 桌面伴侣新增独立的公开素材库，应用启动时会在后台准备并缓存目录，打开更快；支持事件动作、中文动作名和自定义画布动作。
- 桌宠与应用图标使用独立尺寸，宠物默认更大；动作切换会先加载并解码新画面，不再出现明显闪烁。全屏应用下桌宠会自动避让。
- 快照与 Prompt 润色记录合并为按时间排列的历史；快照可直接预览并在应用内标注。
- 启动台会缓存应用清单和图标，减少再次打开的等待；全局快捷键暂停状态可以保留，设置中的保存路径可直接打开。
- 更新应用图标，并精简快捷菜单和偏好设置，使 Windows、macOS 与 Linux 的界面和行为保持一致。

按机器选下面其中一个附件。

## 下载哪一份

| 你的机器 | 附件 |
|---|---|
| macOS（Apple Silicon 或 Intel） | `snapshot-{{VERSION}}-macos-universal.zip` |
| Windows x64（Intel / AMD） | `snapshot-{{VERSION}}-windows-x64.exe` |
| Windows ARM64（骁龙本等） | `snapshot-{{VERSION}}-windows-arm64.exe` |
| Linux x86_64，Ubuntu 22.04+ / Debian 12+ | `snapshot-{{VERSION}}-linux-x86_64.deb` |
| Linux x86_64，其它发行版 | `snapshot-{{VERSION}}-linux-x86_64.AppImage` |
| Linux aarch64，Ubuntu 22.04+ / Debian 12+ | `snapshot-{{VERSION}}-linux-aarch64.deb` |
| Linux aarch64，其它发行版 | `snapshot-{{VERSION}}-linux-aarch64.AppImage` |

没有 32 位 Windows 包。Mac 两种芯片是**同一份** zip，不要找第二个 Mac 包。Linux 同一架构的 deb 与 AppImage 是同一个程序的两种装法，装一个就够。

校验：`SHA256SUMS.txt`。

## 安装

- **macOS**：解压后把 `snapshot.app` 拖到「应用程序」。当前构建是 ad-hoc 签名、未公证；若系统提示无法验证开发者，按住 Control 点击 → 打开。截图和录制需要「屏幕录制」权限，截最小化的窗口需要「辅助功能」权限，录麦克风需要麦克风权限。
- **Windows**：运行对应架构的安装程序。需要 Microsoft Edge WebView2 运行时，Windows 11 自带，Windows 10 上安装程序会按需下载。未用 Trusted Root 代码签名证书签过名时，Smart App Control / SmartScreen 可能拦截。
- **Linux（deb）**：`sudo apt install ./snapshot-{{VERSION}}-linux-<架构>.deb`，依赖由 apt 一并装上。
- **Linux（AppImage）**：`chmod +x` 之后直接运行。部分发行版需要先装 `libfuse2`。

## 可选依赖

Windows 和 macOS 不用另装东西。Linux 上按需安装：

| 功能 | 需要 |
|---|---|
| 窗口录制、带鼠标指针的截图 | `ffmpeg` |
| 录系统声音和麦克风 | `pactl`（PulseAudio 或 PipeWire-Pulse），且 ffmpeg 带 PulseAudio 支持 |
| 截图前还原最小化窗口、滚动长截图 | `xdotool` |
| 系统托盘 | StatusNotifierHost（KDE 自带；GNOME 需装 AppIndicator 扩展） |

伴侣的 GIF 形象不随安装包提供，装好后在主窗口「桌面伴侣」页导入。

## 系统要求

- macOS 14+（录麦克风需要 macOS 15+）
- Windows 10 或 Windows 11
- Linux：X11 或 Wayland 桌面会话；deb 需要 Ubuntu 22.04 / Debian 12 及以上，AppImage 需要 glibc 2.35 及以上（Ubuntu 22.04 同代或更新的发行版）。Ubuntu 20.04 及更早的系统不支持

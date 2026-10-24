# 应用快照 {{VERSION}}

这一版先发 Windows，macOS 和 Linux 版稍后发布。

## 本次更新

- 桌面伴侣新增独立的公开素材库，应用启动时会在后台准备并缓存目录，打开更快；支持事件动作、中文动作名和自定义画布动作。
- 桌宠与应用图标使用独立尺寸，宠物默认更大；动作切换会先加载并解码新画面，不再出现明显闪烁。全屏应用下桌宠会自动避让。
- 快照与 Prompt 润色记录合并为按时间排列的历史；快照可直接预览并在应用内标注。
- 启动台会缓存应用清单和图标，减少再次打开的等待；全局快捷键暂停状态可以保留，设置中的保存路径可直接打开。
- 更新应用图标，并精简快捷菜单和偏好设置。

## 下载哪一份

| 你的机器 | 附件 |
|---|---|
| Windows x64（Intel / AMD） | `snapshot-{{VERSION}}-windows-x64.exe` |
| Windows ARM64（骁龙本等） | `snapshot-{{VERSION}}-windows-arm64.exe` |

没有 32 位 Windows 包。

校验：`SHA256SUMS.txt`。

## 安装

运行对应架构的安装程序，装在当前用户下，不需要管理员权限。需要 Microsoft Edge WebView2 运行时，Windows 11 自带，Windows 10 上安装程序会按需下载。

安装包没有用受信任的代码签名证书签过名，Smart App Control / SmartScreen 可能会拦截；SmartScreen 提示时点「更多信息」→「仍要运行」。

装好后不需要另装别的东西。伴侣的 GIF 形象不随安装包提供，装好后在主窗口「桌面伴侣」页导入。

## 系统要求

- Windows 10 或 Windows 11，x64 或 ARM64

# macOS 桌宠拖动闪退回归记录

## 根因（2026-11-06）

macOS 15.7.7 / Apple Silicon 的正式包在拖动桌宠、切换动作时发生
`EXC_CRASH / SIGABRT`，故障线程为 `tokio-rt-worker`。

调试器捕获到的原始异常是 `This task has already been stopped`，调用链为：

```text
media::handle 的 spawn_blocking 回调
  → UriSchemeResponder::respond
  → Wry 自定义协议 response
  → WKURLSchemeTask.didReceiveResponse
  → NSException
```

动作切换会取消旧素材请求。此前后台线程直接回包，与 WebKit 主线程取消请求
发生竞争：Wry 检查请求有效之后，请求仍可能在实际回包之前被取消。
正式包使用 `panic = "abort"`，Objective-C 异常无法被这条 Rust 调用链捕获，
最终终止整个应用。只测试 debug 包可能漏掉这个问题。

修复位于 `src-tauri/src/media.rs`：macOS 继续在后台读取、解压素材，但通过
`AppHandle::run_on_main_thread` 回包，使 Wry 的有效性检查和响应发送与
WebKit 的 stop 回调串行执行。非 macOS 回包路径不变。

## 真机回归方式

必须使用 **正式打包的 `.app`**，不能只以单元测试、开发服务器或独立的
WKWebView 演示程序替代。

1. 选择大肥鱼 WebM 形象，等待默认动作显示。
2. 连续快速按下、拖动、松开，反复打断动作加载；确认窗口确实随鼠标移动。
3. 再做较长时间按住的拖动，让拖动动作加载后切回待机；覆盖两个显示器。
4. 检查应用进程仍在、宠物仍可拖动和播放、没有新增 snapshot 崩溃报告。
5. 检查原有宠物素材、所选形象及透明显示没有被改坏。

## 本次验证结果

- 修复前：同一份正式包在连续 4 次拖动后退出，崩溃栈与用户日志一致。
- 修复后：安装后的正式包完成 100 次快速拖动及 30 次较长拖动，进程保持
  运行，标准错误无异常，未新增崩溃报告。
- 前端：35 个测试文件、425 项测试通过。
- Rust：129 项测试通过，2 项原有忽略用例未执行。
- 正式打包及应用签名校验通过；宠物素材文件哈希、所选形象保持不变。
- 未在 Windows 真机重测；本次修改仅影响 macOS 的素材回包调度。

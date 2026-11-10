use super::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviousApp {
    id: Option<u32>,
    /// 图标由页面按需经 media://icon/<pid>/<边长> 取，这里只给 pid
    pid: Option<u32>,
    name: String,
    title: String,
}

impl Default for PreviousApp {
    fn default() -> Self {
        Self {
            id: None,
            pid: None,
            name: "等待切换应用".into(),
            title: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturableWindow {
    id: u32,
    pid: u32,
    app_name: String,
    title: String,
    minimized: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct TrackedWindow {
    pub(crate) id: u32,
    pub(crate) pid: u32,
    pub(crate) app_name: String,
    pub(crate) title: String,
}

#[derive(Default)]
pub(crate) struct TrackerState {
    current: Option<TrackedWindow>,
    pub(crate) previous: Option<TrackedWindow>,
    previous_view: PreviousApp,
}

#[tauri::command]
pub(crate) fn get_previous_app(state: State<'_, AppState>) -> PreviousApp {
    state.tracker.lock().previous_view.clone()
}

/// 菜单栏图标、状态项和其它辅助窗口也会出现在系统窗口列表里。
/// 它们通常只有几十像素，选中后录制出来的就只有应用图标。
const MIN_CONTENT_WINDOW_EDGE: u32 = 80;

fn content_window_area_from_size(width: u32, height: u32) -> Option<u64> {
    if width < MIN_CONTENT_WINDOW_EDGE || height < MIN_CONTENT_WINDOW_EDGE {
        return None;
    }
    Some(u64::from(width) * u64::from(height))
}

fn content_window_area(window: &Window) -> Option<u64> {
    let width = window.width().ok()?;
    let height = window.height().ok()?;
    content_window_area_from_size(width, height)
}

/// 最小化窗口在 Windows 上会报告成任务栏条目大小的矩形，不能套用内容窗口的
/// 80 像素下限；它仍然是可以还原并录制/截图的目标。
#[cfg(any(not(target_os = "macos"), test))]
fn capturable_window_area_from(area: Option<u64>, minimized: bool) -> Option<u64> {
    if minimized {
        Some(u64::MAX)
    } else {
        area
    }
}

struct MainCaptureWindow {
    id: Option<u32>,
    pid: u32,
    title: String,
}

impl MainCaptureWindow {
    fn matches(&self, id: u32, pid: u32, title: &str) -> bool {
        match self.id {
            Some(main_id) => id == main_id,
            None => pid == self.pid && title == self.title,
        }
    }
}

fn main_capture_window(app: &AppHandle) -> Option<MainCaptureWindow> {
    let main = app.get_webview_window("main")?;
    // Windows 用原生 HWND 精确匹配，主窗口改名或 WebView2 子进程都不影响识别。
    #[cfg(target_os = "windows")]
    let id = Some(main.hwnd().ok()?.0 as usize as u32);
    #[cfg(not(target_os = "windows"))]
    let id = None;
    Some(MainCaptureWindow {
        id,
        pid: std::process::id(),
        title: main.title().unwrap_or_default(),
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn own_main_window(app: &AppHandle, id: u32) -> Option<tauri::WebviewWindow> {
    let main = app.get_webview_window("main")?;
    let main_id = main.hwnd().ok()?.0 as usize as u32;
    (main_id == id).then_some(main)
}

#[cfg(target_os = "windows")]
fn native_main_capture_window(app: &AppHandle) -> Option<(u64, CapturableWindow)> {
    let main = app.get_webview_window("main")?;
    if !main.is_visible().ok()? {
        return None;
    }
    let id = main.hwnd().ok()?.0 as usize as u32;
    let size = main.outer_size().ok()?;
    let minimized = main.is_minimized().ok()?;
    let area = capturable_window_area_from(
        content_window_area_from_size(size.width, size.height),
        minimized,
    )?;
    Some((
        area,
        CapturableWindow {
            id,
            pid: std::process::id(),
            app_name: "snapshot".into(),
            title: main.title().ok()?,
            minimized,
        },
    ))
}

#[tauri::command]
pub(crate) async fn list_capturable_windows(
    app: AppHandle,
) -> Result<Vec<CapturableWindow>, WindowListError> {
    // 自有窗口的元数据查询可能需要主线程处理消息，不能从同步 IPC 阻塞窗口消息循环。
    tauri::async_runtime::spawn_blocking(move || enumerate_capturable_windows(&app))
        .await
        .map_err(|error| WindowListError::Enumeration(error.to_string()))?
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub(crate) enum WindowListError {
    #[cfg(target_os = "macos")]
    ScreenCapturePermission(String),
    Enumeration(String),
}

fn enumerate_capturable_windows(app: &AppHandle) -> Result<Vec<CapturableWindow>, WindowListError> {
    #[cfg(target_os = "macos")]
    os::require_screen_capture_access().map_err(WindowListError::ScreenCapturePermission)?;
    let main = main_capture_window(app);
    #[cfg(target_os = "macos")]
    let mut result = os::list_windows()
        .map_err(WindowListError::Enumeration)?
        .into_iter()
        .filter(|window| {
            window.pid != std::process::id()
                || main
                    .as_ref()
                    .is_some_and(|main| main.matches(window.id, window.pid, &window.title))
        })
        .map(|window| {
            (
                window.area,
                CapturableWindow {
                    id: window.id,
                    pid: window.pid,
                    app_name: window.app_name,
                    title: window.title,
                    // ScreenCaptureKit 的 off-screen 包括台前调度/其它空间，不能当成最小化。
                    minimized: false,
                },
            )
        })
        .collect::<Vec<_>>();
    // xcap 的 macOS 枚举及其每个元数据 getter 都限定为 on-screen，
    // 无法靠在它返回的列表上追加过滤找回后台窗口。Windows/Linux 保持原实现。
    #[cfg(not(target_os = "macos"))]
    let mut result = Window::all()
        .map_err(|error| WindowListError::Enumeration(error.to_string()))?
        .into_iter()
        .filter_map(|window| {
            let id = window.id().ok()?;
            let pid = window.pid().ok()?;
            let title = window.title().ok()?;
            // 显式选择截图/录制目标时允许主窗口；自动“上一个应用”追踪仍跳过自身。
            if is_own_window(&window)
                && !main
                    .as_ref()
                    .is_some_and(|main| main.matches(id, pid, &title))
            {
                return None;
            }
            let area = capturable_window_area_from(
                content_window_area(&window),
                window.is_minimized().unwrap_or(false),
            )?;
            if title.trim().is_empty() {
                return None;
            }
            Some((
                area,
                CapturableWindow {
                    id,
                    pid,
                    app_name: window.app_name().unwrap_or_else(|_| "应用".into()),
                    title,
                    minimized: window.is_minimized().unwrap_or(false),
                },
            ))
        })
        .collect::<Vec<_>>();
    // xcap 0.9.8 的 Windows 枚举在底层排除了整个当前进程；只补上可见的 main。
    #[cfg(target_os = "windows")]
    if let Some(main) = native_main_capture_window(app) {
        if !result.iter().any(|(_, window)| window.id == main.1.id) {
            result.push(main);
        }
    }
    result.sort_by(|(left_area, left), (right_area, right)| {
        left.app_name
            .cmp(&right.app_name)
            // 同一应用有多个窗口时，先放最可能是主内容的大窗口。
            .then(right_area.cmp(left_area))
            .then(left.title.cmp(&right.title))
    });
    Ok(result.into_iter().map(|(_, window)| window).collect())
}

/// 判断某个窗口是不是本应用自己的窗口（桌宠、快捷菜单、主窗口）。
/// 追踪"上一个应用"时必须跳过它们，否则点击桌宠托盘
/// 后桌宠自己会被记成"上一个应用"，图标随后变成终端一类的业务应用。
fn is_own_window(window: &Window) -> bool {
    if let Ok(pid) = window.pid() {
        if pid == std::process::id() {
            return true;
        }
    }
    // WebView2 用独立子进程渲染，pid 不等于主进程，只能靠标题兜底。
    // 三个窗口标题都在 tauri.conf.json 里：snapshot / 桌宠 / 快速操作。
    let title = window.title().unwrap_or_default();
    matches!(title.trim(), "snapshot" | "桌宠" | "快速操作")
}

pub(crate) fn start_tracker(app: AppHandle, tracker: Arc<Mutex<TrackerState>>) {
    thread::spawn(move || loop {
        if let Ok(windows) = Window::all() {
            // 焦点可能落在桌宠/快捷菜单这类自有窗口上，先向前找最近一个
            // 真正的业务窗口作为焦点候选，避免把"上一个应用"记成自己。
            // xcap 的 macOS is_focused 实际按 PID 判断：同一 App 的菜单栏图标
            // 和主窗口都会返回 true。因此先排除小辅助窗，再取面积最大的内容窗。
            let focused = windows
                .into_iter()
                .filter(|window| window.is_focused().unwrap_or(false) && !is_own_window(window))
                .filter_map(|window| content_window_area(&window).map(|area| (area, window)))
                .max_by_key(|(area, _)| *area)
                .map(|(_, window)| window);
            if let Some(focused) = focused {
                if let (Ok(id), Ok(pid)) = (focused.id(), focused.pid()) {
                    let next = TrackedWindow {
                        id,
                        pid,
                        app_name: focused.app_name().unwrap_or_else(|_| "应用".into()),
                        title: focused.title().unwrap_or_default(),
                    };
                    let mut state = tracker.lock();
                    let changed = state
                        .current
                        .as_ref()
                        .map(|current| current.pid != next.pid)
                        .unwrap_or(true);
                    if state.current.is_none() {
                        state.current = Some(next.clone());
                        state.previous = Some(next.clone());
                    } else if changed {
                        state.previous = state.current.replace(next.clone());
                    } else {
                        state.current = Some(next.clone());
                        if state.previous.as_ref().map(|previous| previous.pid) == Some(next.pid) {
                            state.previous = Some(next.clone());
                        }
                    }
                    if changed || state.previous_view.id.is_none() {
                        if let Some(previous) = state.previous.as_ref() {
                            state.previous_view = PreviousApp {
                                id: Some(previous.id),
                                pid: Some(previous.pid),
                                name: previous.app_name.clone(),
                                title: previous.title.clone(),
                            };
                            let _ = app.emit("previous-app-changed", &state.previous_view);
                        }
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn permission_failure_is_distinguishable_from_an_enumeration_failure() {
        assert_eq!(
            serde_json::to_value(WindowListError::ScreenCapturePermission("授权提示".into()))
                .unwrap(),
            json!({ "kind": "screenCapturePermission", "message": "授权提示" })
        );
        assert_eq!(
            serde_json::to_value(WindowListError::Enumeration("读取失败".into())).unwrap(),
            json!({ "kind": "enumeration", "message": "读取失败" })
        );
    }

    #[test]
    fn main_window_capture_uses_its_handle_instead_of_a_shared_process_or_title() {
        let main = MainCaptureWindow {
            id: Some(42),
            pid: 100,
            title: "应用快照".into(),
        };
        assert!(main.matches(42, 100, "应用快照"));
        assert!(main.matches(42, 200, "Snapshot"));
        for title in ["桌宠", "快速操作", "启动台", "标注截图", "应用快照"] {
            assert!(!main.matches(43, 100, title));
        }
    }

    #[test]
    fn main_window_title_fallback_also_requires_the_owning_process() {
        let main = MainCaptureWindow {
            id: None,
            pid: 100,
            title: "应用快照".into(),
        };
        assert!(main.matches(42, 100, "应用快照"));
        assert!(!main.matches(42, 200, "应用快照"));
        assert!(!main.matches(43, 100, "桌宠"));
    }

    #[test]
    fn menu_bar_items_are_not_treated_as_content_windows() {
        // Shadowrocket 在本机暴露的 Item-0 是 34×24，真正主窗口是 1024×655。
        assert_eq!(content_window_area_from_size(34, 24), None);
        assert_eq!(content_window_area_from_size(79, 600), None);
        assert_eq!(content_window_area_from_size(1024, 655), Some(670_720));
    }

    #[test]
    fn minimized_windows_bypass_the_small_tray_window_filter() {
        assert_eq!(capturable_window_area_from(None, true), Some(u64::MAX));
        assert_eq!(
            capturable_window_area_from(Some(1234), true),
            Some(u64::MAX)
        );
        assert_eq!(capturable_window_area_from(None, false), None);
        assert_eq!(capturable_window_area_from(Some(1234), false), Some(1234));
    }
}

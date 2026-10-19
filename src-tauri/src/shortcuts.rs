//! 全局快捷键。
//!
//! 注册放在 Rust 侧：按下后在这里直接执行动作，不经过网页往返；只在启动、保存
//! 和手动暂停/恢复时改变注册。原先由主窗口网页注册，保存一次会连带触发好几轮设置更新，
//! 几轮并发注册同一个键，应用自己和自己撞车，却被报成「被其他程序占用」。

use super::settings::{Settings, ShortcutBinding};
use super::*;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 插件本体。所有键共用一个回调：按下哪个键，就去设置里查它绑的是哪个动作。
pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if !matches!(event.state, ShortcutState::Pressed) {
                return;
            }
            let Some(action) = bound_action(app, shortcut) else {
                return;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // 已进队列的按键也要遵守刚刚切换的暂停状态。
                if app.state::<AppState>().settings.lock().shortcuts_paused {
                    return;
                }
                if let Err(error) = actions::perform(&app, &action).await {
                    eprintln!("snapshot: shortcut action {action} failed: {error}");
                    activity::record_error(&app, actions::action_failure_title(&action), &error);
                }
            });
        })
        .build()
}

fn bound_action(app: &AppHandle, pressed: &Shortcut) -> Option<String> {
    let state = app.try_state::<AppState>()?;
    let settings = state.settings.lock();
    if settings.shortcuts_paused {
        return None;
    }
    settings
        .shortcuts
        .iter()
        .find(|binding| parse(binding).as_ref() == Some(pressed))
        .map(|binding| binding.action.clone())
}

fn parse(binding: &ShortcutBinding) -> Option<Shortcut> {
    binding.accelerator.as_deref()?.parse().ok()
}

/// 保存前的校验：每个键都得认得出，且不能两个动作绑同一个键。
/// 按解析后的键比较，所以「Alt+Shift+2」和「Shift+Alt+2」也算重复。
pub(crate) fn validate(bindings: &[ShortcutBinding]) -> Result<(), String> {
    let mut seen = Vec::new();
    for binding in bindings {
        let Some(accelerator) = binding.accelerator.as_deref() else {
            continue;
        };
        let shortcut: Shortcut = accelerator
            .parse()
            .map_err(|_| format!("「{accelerator}」不是有效的快捷键"))?;
        if seen.contains(&shortcut) {
            return Err("快捷键不能重复".into());
        }
        seen.push(shortcut);
    }
    Ok(())
}

trait Registry {
    fn release(&self) -> Result<(), String>;
    fn bind(&self, accelerator: &str) -> Result<(), String>;
}

struct AppRegistry<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
}

/// 逐个释放且保留失败的键。插件的 unregister_all 会先清空内部记录，
/// 原生释放中途失败时便无法再次释放，所以这里不用那个批量接口。
fn release_registered(
    registrations: &Mutex<Vec<String>>,
    mut unregister: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let registered = registrations.lock().clone();
    let mut failed = Vec::new();
    for accelerator in registered {
        match unregister(&accelerator) {
            Ok(()) => registrations.lock().retain(|key| key != &accelerator),
            Err(error) => failed.push(format!("{accelerator}（{error}）")),
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("释放快捷键失败：{}", failed.join("、")))
    }
}

impl Registry for AppRegistry<'_> {
    fn release(&self) -> Result<(), String> {
        release_registered(&self.state.shortcut_registrations, |accelerator| {
            self.app
                .global_shortcut()
                .unregister(accelerator)
                .map_err(|error| error.to_string())
        })
    }

    fn bind(&self, accelerator: &str) -> Result<(), String> {
        self.app
            .global_shortcut()
            .register(accelerator)
            .map_err(|error| error.to_string())?;
        self.state
            .shortcut_registrations
            .lock()
            .push(accelerator.to_string());
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct Configuration<'a> {
    bindings: &'a [ShortcutBinding],
    paused: bool,
}

impl<'a> From<&'a Settings> for Configuration<'a> {
    fn from(settings: &'a Settings) -> Self {
        Self {
            bindings: &settings.shortcuts,
            paused: settings.shortcuts_paused,
        }
    }
}

fn replace(
    registry: &impl Registry,
    configuration: Configuration<'_>,
) -> Result<Vec<String>, String> {
    registry.release()?;
    if configuration.paused {
        return Ok(Vec::new());
    }
    Ok(configuration
        .bindings
        .iter()
        .filter_map(|binding| binding.accelerator.as_deref())
        .filter(|accelerator| registry.bind(accelerator).is_err())
        .map(str::to_string)
        .collect())
}

/// 启动时允许部分键不可用，其余键照常注册；手动切换与保存则整体成功或回退。
pub(crate) fn register_all(app: &AppHandle, settings: &Settings) -> Vec<String> {
    let state = app.state::<AppState>();
    let registry = AppRegistry { app, state: &state };
    replace(&registry, settings.into()).unwrap_or_else(|error| {
        eprintln!("snapshot: {error}");
        settings
            .shortcuts
            .iter()
            .filter_map(|binding| binding.accelerator.clone())
            .collect()
    })
}

#[derive(Debug)]
struct UpdateFailure {
    message: String,
    conflicts: Vec<String>,
}

fn reconfigure<T>(
    registry: &impl Registry,
    previous: Configuration<'_>,
    next: Configuration<'_>,
    persist: impl FnOnce() -> Result<T, String>,
) -> Result<T, UpdateFailure> {
    let result = replace(registry, next).and_then(|failed| {
        if failed.is_empty() {
            persist()
        } else {
            Err(conflict_message(&failed))
        }
    });
    result.map_err(|mut message| {
        let conflicts = match replace(registry, previous) {
            Ok(failed) => {
                if !failed.is_empty() {
                    message.push_str(&format!("；原快捷键未能完全恢复：{}", failed.join("、")));
                }
                failed
            }
            Err(error) => {
                message.push_str(&format!("；原快捷键未能恢复：{error}"));
                previous
                    .bindings
                    .iter()
                    .filter_map(|binding| binding.accelerator.clone())
                    .collect()
            }
        };
        UpdateFailure { message, conflicts }
    })
}

enum Change {
    Bindings(Vec<ShortcutBinding>),
    Paused(bool),
    TogglePaused,
}

/// 所有注册变动在 UI 线程串行处理，托盘操作不会与设置页保存交错。
/// 注册时不持有 settings 锁：插件的按键回调也会读取它，反向持锁会造成死锁。
async fn change_configuration(app: AppHandle, change: Change) -> Result<Settings, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        let previous = state.settings.lock().clone();
        let mut next = previous.clone();
        match change {
            Change::Bindings(bindings) => next.shortcuts = bindings,
            Change::Paused(paused) => next.shortcuts_paused = paused,
            Change::TogglePaused => next.shortcuts_paused = !next.shortcuts_paused,
        }
        let result = reconfigure(
            &AppRegistry {
                app: &handle,
                state: &state,
            },
            (&previous).into(),
            (&next).into(),
            || {
                let mut settings = state.settings.lock();
                let mut updated = settings.clone();
                updated.shortcuts = next.shortcuts.clone();
                updated.shortcuts_paused = next.shortcuts_paused;
                settings::persist_settings(&state.settings_path, &updated)?;
                *settings = updated.clone();
                Ok(updated)
            },
        );
        let result = match result {
            Ok(settings) => {
                state.shortcut_conflicts.lock().clear();
                settings::emit_settings(&handle, &settings);
                Ok(settings)
            }
            Err(failure) => {
                *state.shortcut_conflicts.lock() = failure.conflicts;
                Err(failure.message)
            }
        };
        let paused = state.settings.lock().shortcuts_paused;
        let item = state.shortcut_pause_item.lock().clone();
        if let Some(item) = item {
            // 原生勾选项点击后会先改变外观；失败时也必须同步回真实状态。
            let _ = item.set_checked(paused);
        }
        let _ = sender.try_send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "快捷键设置未能完成".to_string())?
}

pub(crate) async fn save_bindings(
    app: AppHandle,
    bindings: Vec<ShortcutBinding>,
) -> Result<Settings, String> {
    change_configuration(app, Change::Bindings(bindings)).await
}

#[tauri::command]
pub(crate) async fn set_shortcuts_paused(app: AppHandle, paused: bool) -> Result<Settings, String> {
    change_configuration(app, Change::Paused(paused)).await
}

pub(crate) fn toggle_from_tray(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = change_configuration(app.clone(), Change::TogglePaused).await {
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            activity::record_error(&app, "快捷键设置未生效", &error);
            app.dialog()
                .message(error)
                .title("快捷键设置未生效")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    });
}

pub(crate) fn conflict_message(failed: &[String]) -> String {
    format!(
        "这些快捷键没能注册，可能已被其他程序占用：{}",
        failed.join("、")
    )
}

/// 启动时没注册上的键。启动那一刻网页还没加载，没法当场提示，由主窗口加载后来取。
#[tauri::command]
pub(crate) fn get_shortcut_conflicts(state: State<'_, AppState>) -> Vec<String> {
    state.shortcut_conflicts.lock().clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashSet};

    #[derive(Default)]
    struct FakeRegistry {
        registered: RefCell<HashSet<String>>,
        occupied: HashSet<String>,
        fail_release: bool,
    }

    impl Registry for FakeRegistry {
        fn release(&self) -> Result<(), String> {
            if self.fail_release {
                return Err("释放失败".into());
            }
            self.registered.borrow_mut().clear();
            Ok(())
        }

        fn bind(&self, accelerator: &str) -> Result<(), String> {
            if self.occupied.contains(accelerator) {
                return Err("已被其他程序占用".into());
            }
            self.registered.borrow_mut().insert(accelerator.into());
            Ok(())
        }
    }

    fn configuration(bindings: &[ShortcutBinding], paused: bool) -> Configuration<'_> {
        Configuration { bindings, paused }
    }

    fn registered(registry: &FakeRegistry) -> HashSet<String> {
        registry.registered.borrow().clone()
    }

    fn binding(action: &str, accelerator: Option<&str>) -> ShortcutBinding {
        ShortcutBinding {
            action: action.into(),
            accelerator: accelerator.map(str::to_string),
        }
    }

    #[test]
    fn unbound_actions_pass_validation() {
        assert!(validate(&[binding("snapshot", None), binding("record", None)]).is_ok());
    }

    #[test]
    fn same_key_in_different_modifier_order_is_a_duplicate() {
        let result = validate(&[
            binding("snapshot", Some("Alt+Shift+2")),
            binding("record", Some("Shift+Alt+2")),
        ]);
        assert_eq!(result, Err("快捷键不能重复".to_string()));
    }

    #[test]
    fn unrecognized_key_is_rejected_with_its_text() {
        let result = validate(&[binding("snapshot", Some("Alt+NotAKey"))]);
        assert!(result.unwrap_err().contains("Alt+NotAKey"));
    }

    #[test]
    fn keys_recorded_by_the_settings_page_parse() {
        // 设置页录键时拼出的格式：修饰键 + normalizeKey 之后的主键
        for accelerator in [
            "CommandOrControl+Shift+S",
            "Alt+Shift+2",
            "CommandOrControl+Alt+F1",
            "Alt+Shift+Space",
        ] {
            assert!(
                accelerator.parse::<Shortcut>().is_ok(),
                "{accelerator} 应能解析"
            );
        }
    }

    #[test]
    fn manual_pause_releases_keys_and_resume_restores_saved_bindings() {
        let registry = FakeRegistry::default();
        let bindings = vec![
            binding("snapshot", Some("Alt+Shift+2")),
            binding("palette", Some("Alt+Shift+Space")),
            binding("record", None),
        ];
        let active = configuration(&bindings, false);
        let paused = configuration(&bindings, true);
        replace(&registry, active).unwrap();
        assert_eq!(registered(&registry).len(), 2);
        reconfigure(&registry, active, paused, || Ok(())).unwrap();
        assert!(registered(&registry).is_empty());
        reconfigure(&registry, paused, active, || Ok(())).unwrap();
        assert_eq!(
            registered(&registry),
            HashSet::from(["Alt+Shift+2".into(), "Alt+Shift+Space".into()])
        );
    }

    #[test]
    fn saving_bindings_while_paused_keeps_keys_released_until_manual_resume() {
        let registry = FakeRegistry::default();
        let old = vec![binding("snapshot", Some("Alt+Shift+2"))];
        let edited = vec![binding("snapshot", Some("Alt+Shift+3"))];
        let paused = configuration(&old, true);
        let saved = configuration(&edited, true);
        let persisted = reconfigure(&registry, paused, saved, || Ok("saved")).unwrap();
        assert_eq!(persisted, "saved");
        assert!(registered(&registry).is_empty());
        reconfigure(&registry, saved, configuration(&edited, false), || Ok(())).unwrap();
        assert_eq!(registered(&registry), HashSet::from(["Alt+Shift+3".into()]));
    }

    #[test]
    fn resume_conflict_keeps_every_key_paused_and_does_not_persist() {
        let registry = FakeRegistry {
            occupied: HashSet::from(["Alt+Shift+Space".into()]),
            ..Default::default()
        };
        let bindings = vec![
            binding("snapshot", Some("Alt+Shift+2")),
            binding("palette", Some("Alt+Shift+Space")),
        ];
        let failure = reconfigure(
            &registry,
            configuration(&bindings, true),
            configuration(&bindings, false),
            || -> Result<(), String> { panic!("恢复失败时不能保存启用状态") },
        )
        .unwrap_err();
        assert!(failure.message.contains("Alt+Shift+Space"));
        assert!(failure.conflicts.is_empty());
        assert!(registered(&registry).is_empty());
    }

    #[test]
    fn failed_save_restores_the_previous_active_keys() {
        let registry = FakeRegistry {
            occupied: HashSet::from(["Alt+Shift+3".into()]),
            ..Default::default()
        };
        let old = vec![binding("snapshot", Some("Alt+Shift+2"))];
        let edited = vec![binding("snapshot", Some("Alt+Shift+3"))];
        let failure = reconfigure(
            &registry,
            configuration(&old, false),
            configuration(&edited, false),
            || -> Result<(), String> { panic!("冲突绑定不能落盘") },
        )
        .unwrap_err();
        assert!(failure.message.contains("Alt+Shift+3"));
        assert!(failure.conflicts.is_empty());
        assert_eq!(registered(&registry), HashSet::from(["Alt+Shift+2".into()]));
    }

    #[test]
    fn persistence_failure_rolls_back_both_pause_and_resume_registration() {
        let registry = FakeRegistry::default();
        let bindings = vec![binding("snapshot", Some("Alt+Shift+2"))];
        let active = configuration(&bindings, false);
        let paused = configuration(&bindings, true);
        replace(&registry, active).unwrap();
        let failure = reconfigure(&registry, active, paused, || -> Result<(), String> {
            Err("写设置失败".into())
        })
        .unwrap_err();
        assert!(failure.message.contains("写设置失败"));
        assert_eq!(registered(&registry), HashSet::from(["Alt+Shift+2".into()]));
        replace(&registry, paused).unwrap();
        reconfigure(&registry, paused, active, || -> Result<(), String> {
            Err("写设置失败".into())
        })
        .unwrap_err();
        assert!(registered(&registry).is_empty());
    }

    #[test]
    fn release_failure_does_not_report_a_successful_pause() {
        let registry = FakeRegistry {
            registered: RefCell::new(HashSet::from(["Alt+Shift+2".into()])),
            fail_release: true,
            ..Default::default()
        };
        let bindings = vec![binding("snapshot", Some("Alt+Shift+2"))];
        let failure = reconfigure(
            &registry,
            configuration(&bindings, false),
            configuration(&bindings, true),
            || -> Result<(), String> { panic!("没有释放按键就不能保存暂停状态") },
        )
        .unwrap_err();
        assert!(failure.message.contains("释放失败"));
        assert_eq!(registered(&registry), HashSet::from(["Alt+Shift+2".into()]));
    }

    #[test]
    fn partially_released_keys_remain_tracked_for_retry() {
        let registrations = Mutex::new(vec!["Alt+Shift+2".into(), "Alt+Shift+3".into()]);
        let failure = release_registered(&registrations, |key| {
            if key == "Alt+Shift+3" {
                Err("暂时无法释放".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert!(failure.contains("Alt+Shift+3"));
        assert_eq!(*registrations.lock(), ["Alt+Shift+3"]);
        let mut retried = Vec::new();
        release_registered(&registrations, |key| {
            retried.push(key.to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(retried, ["Alt+Shift+3"]);
        assert!(registrations.lock().is_empty());
    }
}

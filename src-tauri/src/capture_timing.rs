//! 截图链路的分阶段计时。
//!
//! 只有显式设置 `SNAPSHOT_CAPTURE_TRACE=1` 时才记录；默认路径只生成一个用于
//! 去重的事件 ID，不写日志，也不保留阶段数据。每行日志都带同一个 `shot` ID，
//! 便于把菜单、捕获、编码和后处理串起来。

use parking_lot::Mutex;
use std::{
    env,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

static SHOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn tracing_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        env::var_os("SNAPSHOT_CAPTURE_TRACE")
            .and_then(|value| value.into_string().ok())
            .is_some_and(|value| value == "1")
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct TraceState {
    started: Instant,
    last: Instant,
    captured_at: Option<Instant>,
    phases: Vec<(&'static str, f64)>,
}

/// 一次截图的轻量追踪器。`Clone` 共享同一组阶段，便于在异步入口和截图模块间传递。
#[derive(Clone)]
pub(crate) struct CaptureTrace {
    shot_id: String,
    started_at_ms: u64,
    enabled: bool,
    state: Option<Arc<Mutex<TraceState>>>,
    finished: Option<Arc<AtomicBool>>,
}

impl CaptureTrace {
    pub(crate) fn start() -> Self {
        let started_at_ms = now_millis();
        let shot_id = format!(
            "shot-{started_at_ms}-{}",
            SHOT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let enabled = tracing_enabled();
        let state = enabled.then(|| {
            let now = Instant::now();
            Arc::new(Mutex::new(TraceState {
                started: now,
                last: now,
                captured_at: None,
                phases: Vec::with_capacity(16),
            }))
        });
        Self {
            shot_id,
            started_at_ms,
            enabled,
            state,
            finished: enabled.then(|| Arc::new(AtomicBool::new(false))),
        }
    }

    pub(crate) fn shot_id(&self) -> &str {
        &self.shot_id
    }

    pub(crate) fn started_at_ms(&self) -> u64 {
        self.started_at_ms
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    /// 记录自上一个标记以来的耗时。阶段名保持静态，避免为追踪分配字符串。
    pub(crate) fn mark(&self, phase: &'static str) {
        let Some(state) = &self.state else {
            return;
        };
        let now = Instant::now();
        let mut state = state.lock();
        let elapsed = now.duration_since(state.last).as_secs_f64() * 1_000.0;
        state.phases.push((phase, elapsed));
        state.last = now;
    }

    /// 原图与即时事件都已就绪；之后的耗时单独汇总为后处理时间。
    pub(crate) fn mark_capture_ready(&self) {
        self.mark("shot_event");
        let Some(state) = &self.state else {
            return;
        };
        state.lock().captured_at = Some(Instant::now());
    }

    /// 每次运行只输出一行；阶段值是相邻阶段之间的耗时，`total_ms` 是从入口到此处的总耗时。
    pub(crate) fn finish(&self, outcome: &'static str) {
        let (Some(state), Some(finished)) = (&self.state, &self.finished) else {
            return;
        };
        if finished.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = state.lock();
        let total_ms = state.started.elapsed().as_secs_f64() * 1_000.0;
        let postprocess_ms = state
            .captured_at
            .map(|captured| captured.elapsed().as_secs_f64() * 1_000.0)
            .unwrap_or_default();
        let phases = state
            .phases
            .iter()
            .map(|(name, millis)| format!("{name}={millis:.1}ms"))
            .collect::<Vec<_>>()
            .join(" ");
        eprintln!(
            "snapshot: capture trace shot={} outcome={outcome} total_ms={total_ms:.1} postprocess_ms={postprocess_ms:.1} {phases}",
            self.shot_id
        );
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shot_ids_are_unique_and_nonempty() {
        let first = CaptureTrace::start();
        let second = CaptureTrace::start();
        assert!(!first.shot_id().is_empty());
        assert_ne!(first.shot_id(), second.shot_id());
    }
}

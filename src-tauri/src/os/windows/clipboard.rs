//! Windows 不提供剪贴板历史（能力探测下发不可用）；不启动轮询线程，采样恒为空。

use crate::clipboard_history::Sample;

pub(crate) fn supported() -> bool {
    false
}

pub(crate) fn sample(_last_marker: &str) -> Option<Sample> {
    None
}

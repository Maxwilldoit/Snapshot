//! Windows 不提供剪贴板历史（能力探测下发不可用）；采样恒为空。

use crate::clipboard_history::Sample;

pub(crate) fn sample() -> Option<Sample> {
    None
}

import { soundUrl } from "./media";

/** 播放提示音：有自定义文件就播文件，否则用 WebAudio 合成一声短促提示 */
/**
 * 一记机械快门的「咔」。
 *
 * 机械声是宽频瞬态、没有音高，所以用白噪声过带通再配极快的衰减包络；
 * 用振荡器无论怎么调，出来的都是电子提示音而不是快门声。
 */
function shutterClick(ctx: AudioContext, at: number, level: number, bright: boolean) {
  const duration = 0.05;
  const buffer = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * duration)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  // 高一点像金属脆响，低一点像闷响，两声一高一低才有先后层次
  filter.frequency.value = bright ? 3200 : 1700;
  filter.Q.value = 0.9;

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(Math.max(0.0001, level), at);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  source.connect(filter).connect(amp).connect(ctx.destination);
  source.start(at);
  source.stop(at + duration);
}

let sharedContext: AudioContext | null = null;
let customAudio: HTMLAudioElement | null = null;
let customAudioPath: string | null = null;

function hintContext(): AudioContext | null {
  if (sharedContext && sharedContext.state !== "closed") return sharedContext;
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  sharedContext = new AudioContextCtor();
  return sharedContext;
}

/** 在可用的用户手势里提前恢复共享上下文，避免第一声先等音频设备启动。 */
export function primeHintSound() {
  try {
    const ctx = hintContext();
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
  } catch {
    // WebView 的自动播放策略可能拒绝在无手势时恢复；下一次真实播放会再试。
  }
}

function playSyntheticShutter(ctx: AudioContext, kind: "crisp" | "soft", gain: number) {
  const now = ctx.currentTime;
  // 两声的相对间隔保持 70ms；这是机械快门层次，不是首次启动延迟。
  const level = gain * (kind === "soft" ? 0.2 : 0.38);
  shutterClick(ctx, now, level, kind === "crisp");
  shutterClick(ctx, now + 0.07, level * 0.7, false);
}

function playCustomShutter(path: string, gain: number) {
  if (!customAudio || customAudioPath !== path) {
    if (customAudio) customAudio.pause();
    customAudio = new Audio(soundUrl(path));
    customAudio.preload = "auto";
    customAudioPath = path;
  }
  try {
    customAudio.pause();
    customAudio.currentTime = 0;
  } catch {
    // 文件刚换源时 currentTime 可能暂时不可写，不影响 play。
  }
  customAudio.volume = gain;
  customAudio.play().catch(() => {});
}

export function previewHintSound(kind: "crisp" | "soft", customPath: string | null, volume: number) {
  const gain = Math.min(1, Math.max(0, volume / 100));
  try {
    if (customPath) {
      playCustomShutter(customPath, gain);
      return;
    }
    const ctx = hintContext();
    if (!ctx) return;
    if (ctx.state === "running") {
      playSyntheticShutter(ctx, kind, gain);
      return;
    }
    // 点击试听时通常能在当前手势里恢复；截图事件若被自动播放策略挡住，
    // resume 会失败，下一次用户手势会由 primeHintSound 解锁。
    void ctx
      .resume()
      .then(() => {
        if (ctx.state === "running") playSyntheticShutter(ctx, kind, gain);
      })
      .catch(() => {});
  } catch {
    // 试听失败不打断设置流程
  }
}

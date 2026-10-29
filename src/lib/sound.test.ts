import { afterEach, describe, expect, it, vi } from "vitest";

type FakeSource = {
  buffer: unknown;
  connect: (target: unknown) => unknown;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

class FakeAudioContext {
  static created = 0;
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "running";
  currentTime = 0;
  sampleRate = 48_000;
  destination = {};
  sources: FakeSource[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });

  constructor() {
    FakeAudioContext.created += 1;
    FakeAudioContext.instances.push(this);
  }

  createBuffer(_channels: number, length: number, _rate: number) {
    return { getChannelData: () => new Float32Array(length) };
  }

  createBufferSource() {
    const source: FakeSource = {
      buffer: null,
      connect: (target) => target,
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.sources.push(source);
    return source;
  }

  createBiquadFilter() {
    return {
      type: "bandpass",
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: (target: unknown) => target,
    };
  }

  createGain() {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: (target: unknown) => target,
    };
  }
}

describe("shutter sound", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reuses a running context, preserves the 70ms pair, and replaces a closed context", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.resetModules();
    const { previewHintSound } = await import("./sound");

    previewHintSound("crisp", null, 80);
    previewHintSound("soft", null, 80);

    expect(FakeAudioContext.created).toBe(1);
    const context = FakeAudioContext.instances[0];
    expect(context.sources.map((source) => source.start.mock.calls[0][0])).toEqual([
      0,
      0.07,
      0,
      0.07,
    ]);

    context.state = "closed";
    previewHintSound("crisp", null, 80);
    expect(FakeAudioContext.created).toBe(2);
  });

  it("resumes a suspended context before scheduling the sound", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.resetModules();
    const { previewHintSound } = await import("./sound");

    const context = new FakeAudioContext();
    context.state = "suspended";
    // 让模块先创建并复用这个上下文，模拟首帧过后浏览器把音频上下文挂起。
    vi.stubGlobal("AudioContext", function SuspendedContext() {
      return context;
    } as unknown as typeof AudioContext);
    previewHintSound("crisp", null, 80);
    await Promise.resolve();
    await Promise.resolve();

    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(2);
  });
});

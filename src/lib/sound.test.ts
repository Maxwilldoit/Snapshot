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

  it("on Linux plays a custom sound from a cached Blob URL and revokes it when the file changes", async () => {
    const played: string[] = [];
    class FakeAudio {
      src: string;
      preload = "";
      volume = 1;
      currentTime = 0;
      constructor(src: string) {
        this.src = src;
      }
      pause() {}
      play() {
        played.push(this.src);
        return Promise.resolve();
      }
    }
    // Node 22's undici Response doesn't take jsdom's Blob as a body, so stub just what the code reads
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      ({ ok: true, status: 200, blob: async () => new Blob(["RIFF"], { type: "audio/wav" }) }) as unknown as Response);
    let next = 0;
    const revoke = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:sound-${++next}`, revokeObjectURL: revoke }));
    const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15");
    vi.resetModules();
    vi.doMock("./media", () => ({ soundUrl: (path: string) => `media://localhost/sound${path}` }));
    const { previewHintSound, prepareHintSound } = await import("./sound");
    const flush = async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    prepareHintSound("/data/sounds/a.wav");
    previewHintSound("crisp", "/data/sounds/a.wav", 80);
    previewHintSound("crisp", "/data/sounds/a.wav", 80);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("sound");
    expect(played).toEqual(["blob:sound-1", "blob:sound-1"]);

    previewHintSound("crisp", "/data/sounds/b.wav", 80);
    await flush();
    expect(revoke).toHaveBeenCalledWith("blob:sound-1");
    expect(played.at(-1)).toBe("blob:sound-2");

    prepareHintSound(null);
    expect(revoke).toHaveBeenCalledWith("blob:sound-2");

    // 不是 Linux 时不绕 Blob，直接用地址、同步播
    agent.mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    previewHintSound("crisp", "/data/sounds/c.wav", 80);
    expect(played.at(-1)).toBe("media://localhost/sound/data/sounds/c.wav");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    agent.mockRestore();
    vi.doUnmock("./media");
  });
});

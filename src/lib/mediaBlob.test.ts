import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireMediaUrl, needsBlobMedia } from "./mediaBlob";

const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("media:// 音视频在 Linux 上换成 Blob", () => {
  it("只在 Linux 上、只对 media:// 地址绕 Blob", () => {
    const agent = vi.spyOn(navigator, "userAgent", "get");
    agent.mockReturnValue(LINUX);
    expect(needsBlobMedia("media://localhost/pet%2Fa%2Fidle.webm")).toBe(true);
    expect(needsBlobMedia("blob:abc")).toBe(false);
    agent.mockReturnValue(MAC);
    expect(needsBlobMedia("media://localhost/pet%2Fa%2Fidle.webm")).toBe(false);
    agent.mockReturnValue(WINDOWS);
    expect(needsBlobMedia("http://media.localhost/pet%2Fa%2Fidle.webm")).toBe(false);
  });

  it("同一地址只取一次，最后一个使用者松手才撤销；取不到时退回原地址", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINUX);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("missing") ? new Response(null, { status: 404 }) : new Response(new Blob(["webm"], { type: "video/webm" })));
    vi.stubGlobal("fetch", fetchMock);
    let next = 0;
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:pet-${++next}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const src = "media://localhost/pet%2Fa%2Fidle.webm";
    const first = acquireMediaUrl(src);
    const second = acquireMediaUrl(src);
    expect(first.direct).toBe(false);
    expect(await first.url).toBe("blob:pet-1");
    expect(await second.url).toBe("blob:pet-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);

    first.release();
    first.release();
    expect(revoke).not.toHaveBeenCalled();
    second.release();
    expect(revoke).toHaveBeenCalledWith("blob:pet-1");

    // 松手后再用会重新取一份
    const again = acquireMediaUrl(src);
    expect(await again.url).toBe("blob:pet-2");
    again.release();

    const missing = acquireMediaUrl("media://localhost/pet%2Fmissing.webm");
    expect(await missing.url).toBe("media://localhost/pet%2Fmissing.webm");
    missing.release();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});

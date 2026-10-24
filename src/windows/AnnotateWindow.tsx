import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type Tool = "pen" | "rect";

/**
 * 截后标注：展示捕获图，支持画笔/矩形，完成后复制、另存或关闭。
 */
export function AnnotateWindow() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const snapshot = useRef<ImageData | null>(null);
  const original = useRef<HTMLImageElement | null>(null);
  const undoFrames = useRef<ImageData[]>([]);
  const loadVersion = useRef(0);
  const [undoCount, setUndoCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<Tool>("pen");
  const [title, setTitle] = useState("标注截图");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const loadImage = useCallback(async () => {
    const version = ++loadVersion.current;
    setReady(false);
    setStatus("正在读取截图…");
    drawing.current = false;
    start.current = null;
    snapshot.current = null;
    original.current = null;
    undoFrames.current = [];
    setUndoCount(0);
    try {
      const [dataUrl, nextTitle] = await Promise.all([
        invoke<string | null>("get_annotate_image"),
        invoke<string>("annotate_get_title"),
      ]);
      if (version !== loadVersion.current) return;
      setTitle(nextTitle || "标注截图");
      if (!dataUrl) {
        const canvas = canvasRef.current;
        canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
        setStatus("没有待标注的截图");
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (version !== loadVersion.current) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        original.current = img;
        setReady(true);
        setStatus("");
      };
      img.onerror = () => {
        if (version === loadVersion.current) setStatus("图片加载失败");
      };
      img.src = dataUrl;
    } catch (error) {
      if (version === loadVersion.current) setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen("annotate-ready", () => {
      void loadImage();
    }).then((fn) => {
      if (!alive) { fn(); return; }
      unlisten = fn;
      void loadImage();
    });
    return () => {
      alive = false;
      loadVersion.current++;
      unlisten?.();
    };
  }, [loadImage]);

  function canvasPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready || busy || event.button !== 0 || drawing.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    drawing.current = true;
    const point = canvasPoint(event);
    start.current = point;
    snapshot.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "pen") {
      ctx.strokeStyle = "#ff3b30";
      ctx.lineWidth = Math.max(2, canvas.width / 400);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !start.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const point = canvasPoint(event);
    if (tool === "pen") {
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      return;
    }
    if (snapshot.current) ctx.putImageData(snapshot.current, 0, 0);
    const x = Math.min(start.current.x, point.x);
    const y = Math.min(start.current.y, point.y);
    const w = Math.abs(point.x - start.current.x);
    const h = Math.abs(point.y - start.current.y);
    ctx.strokeStyle = "#007aff";
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    ctx.strokeRect(x, y, w, h);
  }

  function onPointerUp() {
    if (drawing.current && snapshot.current) {
      undoFrames.current.push(snapshot.current);
      // 高分辨率截图的像素快照较大，将撤销记录限制在约 64 MiB 内。
      const limit = Math.max(1, Math.min(20, Math.floor(64 * 1024 * 1024 / snapshot.current.data.byteLength)));
      undoFrames.current = undoFrames.current.slice(-limit);
      setUndoCount(undoFrames.current.length);
    }
    drawing.current = false;
    start.current = null;
    snapshot.current = null;
  }

  function undo() {
    const frame = undoFrames.current.pop();
    if (frame) canvasRef.current?.getContext("2d")?.putImageData(frame, 0, 0);
    setUndoCount(undoFrames.current.length);
  }

  function reset() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !original.current) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(original.current, 0, 0);
    undoFrames.current = [];
    setUndoCount(0);
  }

  async function exportPng(): Promise<string> {
    const canvas = canvasRef.current;
    if (!canvas || !ready) throw new Error("截图尚未加载完成");
    return canvas.toDataURL("image/png");
  }

  async function copy() {
    setBusy(true);
    setStatus("");
    try {
      const imageData = await exportPng();
      const message = await invoke<string>("annotate_copy", { imageData });
      setStatus(message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setStatus("");
    try {
      const imageData = await exportPng();
      const message = await invoke<string>("annotate_save", { imageData });
      setStatus(message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveCopy() {
    setBusy(true);
    setStatus("");
    try {
      const imageData = await exportPng();
      setStatus(await invoke<string>("annotate_save_copy", { imageData }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    await invoke("annotate_close");
  }

  return (
    <div className="annotate-root">
      <header className="annotate-toolbar">
        <strong className="annotate-title">{title || "标注截图"}</strong>
        <div className="annotate-tools" role="group" aria-label="标注工具">
          <button
            type="button"
            className={tool === "pen" ? "is-active" : ""}
            aria-pressed={tool === "pen"}
            disabled={!ready || busy}
            onClick={() => setTool("pen")}
          >
            画笔
          </button>
          <button
            type="button"
            className={tool === "rect" ? "is-active" : ""}
            aria-pressed={tool === "rect"}
            disabled={!ready || busy}
            onClick={() => setTool("rect")}
          >
            矩形
          </button>
          <button type="button" disabled={!ready || busy || !undoCount} onClick={undo}>撤销</button>
          <button type="button" disabled={!ready || busy || !undoCount} onClick={reset}>清空标注</button>
        </div>
        <div className="annotate-actions">
          <button type="button" className="primary-button" title="保存到历史记录，不覆盖原图" disabled={!ready || busy} onClick={() => void saveCopy()}>
            保存副本
          </button>
          <button type="button" disabled={!ready || busy} onClick={() => void copy()}>
            复制
          </button>
          <button type="button" disabled={!ready || busy} onClick={() => void save()}>
            另存为…
          </button>
          <button type="button" disabled={busy} onClick={() => void close()}>
            关闭
          </button>
        </div>
      </header>
      <div className="annotate-stage">
        <canvas
          ref={canvasRef}
          aria-label="截图标注画布"
          className="annotate-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
        />
      </div>
      {status ? <div className="annotate-status">{status}</div> : null}
    </div>
  );
}

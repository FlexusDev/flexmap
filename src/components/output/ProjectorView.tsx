import { useEffect, useState, useRef, useCallback } from "react";
import { tauriInvoke, isTauri } from "../../lib/tauri-bridge";
import type {
  CalibrationConfig,
  Layer,
  FrameSnapshot,
  BlendMode,
  InputTransform,
} from "../../types";
import { DEFAULT_INPUT_TRANSFORM } from "../../types";

/** Fast base64→Uint8ClampedArray decode using fetch + data URI (avoids byte-by-byte loop) */
async function decodeBase64Fast(b64: string): Promise<Uint8ClampedArray<ArrayBuffer>> {
  try {
    const res = await fetch(`data:application/octet-stream;base64,${b64}`);
    const buf: ArrayBuffer = await res.arrayBuffer();
    return new Uint8ClampedArray(buf);
  } catch {
    // Fallback
    const binary = atob(b64);
    const bytes = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

/**
 * ProjectorView — rendered in the projector output window.
 *
 * Polls the scene state + source frames at ~30fps and composites
 * layers onto a Canvas 2D surface. Layers with connected sources
 * show the actual source pixels; layers without sources show white.
 */
function ProjectorView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [sceneReady, setSceneReady] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationConfig>({
    enabled: false,
    pattern: "grid",
  });
  // Cache of decoded ImageData per layer
  const frameCache = useRef<Map<string, ImageData>>(new Map());
  // Per-layer offscreen canvases (prevents cross-contamination between layers)
  const tmpCanvasMap = useRef<Map<string, HTMLCanvasElement>>(new Map());
  // Tick counter to force re-render when frames update
  const [frameTick, setFrameTick] = useState(0);

  useEffect(() => {
    document.body.style.cursor = "none";
    document.body.style.overflow = "hidden";
    document.body.style.background = "#000";
    return () => {
      document.body.style.cursor = "";
    };
  }, []);

  // Decode base64 RGBA to ImageData (async, uses fast path)
  const decodeFrame = useCallback(
    async (snapshot: FrameSnapshot): Promise<ImageData> => {
      const bytes = await decodeBase64Fast(snapshot.data_b64);
      return new ImageData(bytes, snapshot.width, snapshot.height);
    },
    []
  );

  // Emit projector perf stats to main window via Tauri events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emitPerf = useCallback(async (stats: Record<string, number>) => {
    if (!isTauri) return;
    try {
      const { emit } = await import("@tauri-apps/api/event");
      emit("projector-perf", stats);
    } catch {
      // ignore
    }
  }, []);

  // Poll scene + frames at ~30fps (non-overlapping: waits for each cycle to finish)
  useEffect(() => {
    let running = true;
    let fpsFrames = 0;
    let fpsLastTime = performance.now();
    let lastPollMs = 0;
    let lastDecodeMs = 0;
    let lastFrameCount = 0;
    let lastTotalBytes = 0;

    const poll = async () => {
      while (running) {
        const t0 = performance.now();
        try {
          // Fetch project state and frames in parallel
          const [project, frames] = await Promise.all([
            tauriInvoke<{ layers: Layer[]; calibration: CalibrationConfig }>("get_project"),
            tauriInvoke<Record<string, FrameSnapshot>>("poll_all_frames"),
          ]);
          const tPoll = performance.now();

          if (!running) break;

          if (project) {
            setLayers(project.layers);
            setCalibration(project.calibration);
            if (!sceneReady) setSceneReady(true);
          }

          if (frames && Object.keys(frames).length > 0) {
            const cache = frameCache.current;
            let bytes = 0;
            const entries = Object.entries(frames);
            // Decode all frames in parallel using the fast path
            const decoded = await Promise.all(
              entries.map(([, snapshot]) => decodeFrame(snapshot))
            );
            for (let i = 0; i < entries.length; i++) {
              const [layerId] = entries[i];
              const img = decoded[i];
              bytes += img.data.length;
              cache.set(layerId, img);
            }
            const tDecode = performance.now();
            lastPollMs = tPoll - t0;
            lastDecodeMs = tDecode - tPoll;
            lastFrameCount = Object.keys(frames).length;
            lastTotalBytes = bytes;
            setFrameTick((t) => t + 1);
          }
        } catch {
          // Ignore polling errors
        }

        // Update perf stats every second, emit to main window
        const frametime = performance.now() - t0;
        fpsFrames++;
        const elapsed = performance.now() - fpsLastTime;
        if (elapsed >= 1000) {
          emitPerf({
            fps: Math.round((fpsFrames / elapsed) * 1000),
            frametime: Math.round(frametime * 10) / 10,
            pollMs: Math.round(lastPollMs * 10) / 10,
            decodeMs: Math.round(lastDecodeMs * 10) / 10,
            drawMs: 0,
            frameCount: lastFrameCount,
            totalBytes: lastTotalBytes,
          });
          fpsFrames = 0;
          fpsLastTime = performance.now();
        }

        await new Promise((r) => setTimeout(r, 33));
      }
    };

    poll();
    return () => {
      running = false;
    };
  }, [decodeFrame, sceneReady, emitPerf]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    if (!sceneReady) {
      // Elegant loading state — just a subtle pulsing dot
      const pulse = (Math.sin(Date.now() / 400) + 1) / 2;
      ctx.globalAlpha = 0.15 + pulse * 0.2;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      // Request another paint for the animation
      requestAnimationFrame(() => setLayers((l) => [...l]));
    } else if (calibration.enabled) {
      drawCalibration(ctx, w, h, calibration.pattern);
    } else {
      drawLayers(ctx, w, h, layers, frameCache.current, tmpCanvasMap.current);
    }
  }, [layers, calibration, sceneReady, frameTick]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0"
      style={{ width: "100vw", height: "100vh" }}
    />
  );
}

function drawCalibration(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  pattern: string
) {
  switch (pattern) {
    case "grid": {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      const divs = 10;
      for (let i = 0; i <= divs; i++) {
        const x = (i / divs) * w;
        const y = (i / divs) * h;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      break;
    }
    case "crosshair": {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      break;
    }
    case "checkerboard": {
      const size = Math.min(w, h) / 10;
      for (let row = 0; row < h / size; row++) {
        for (let col = 0; col < w / size; col++) {
          ctx.fillStyle = (row + col) % 2 === 0 ? "#fff" : "#000";
          ctx.fillRect(col * size, row * size, size, size);
        }
      }
      break;
    }
    case "fullWhite": {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      break;
    }
    case "colorBars": {
      const colors = ["#fff", "#ff0", "#0ff", "#0f0", "#f0f", "#f00", "#00f"];
      const barW = w / 7;
      colors.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(i * barW, 0, barW, h);
      });
      break;
    }
    case "black":
    default:
      break;
  }
}

/** Map BlendMode to Canvas2D globalCompositeOperation */
function blendModeToComposite(mode: BlendMode): GlobalCompositeOperation {
  switch (mode) {
    case "multiply":    return "multiply";
    case "screen":      return "screen";
    case "overlay":     return "overlay";
    case "darken":      return "darken";
    case "lighten":     return "lighten";
    case "colorDodge":  return "color-dodge";
    case "colorBurn":   return "color-burn";
    case "softLight":   return "soft-light";
    case "hardLight":   return "hard-light";
    case "difference":  return "difference";
    case "exclusion":   return "exclusion";
    case "additive":    return "lighter";
    default:            return "source-over";
  }
}

function drawLayers(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  layers: Layer[],
  frameCache: Map<string, ImageData>,
  tmpCanvasMap: Map<string, HTMLCanvasElement>
) {
  const sorted = [...layers]
    .filter((l) => l.visible)
    .sort((a, b) => a.zIndex - b.zIndex);

  for (const layer of sorted) {
    const alpha = layer.properties.opacity;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blendModeToComposite(layer.blend_mode);

    const frame = frameCache.get(layer.id);
    const geom = layer.geometry;
    const inputTransform = layer.input_transform ?? DEFAULT_INPUT_TRANSFORM;

    if (frame) {
      drawFrameInShape(
        ctx,
        w,
        h,
        geom,
        frame,
        layer.id,
        layer.properties.brightness,
        inputTransform,
        tmpCanvasMap
      );
    } else {
      // No frame — white fill
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * layer.properties.brightness})`;
      drawShapePath(ctx, w, h, geom);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

/** Put frame data into a per-layer offscreen canvas */
function frameToCanvas(
  frame: ImageData,
  layerId: string,
  brightness: number,
  canvasMap: Map<string, HTMLCanvasElement>
): HTMLCanvasElement {
  let c = canvasMap.get(layerId);
  if (!c) {
    c = document.createElement("canvas");
    canvasMap.set(layerId, c);
  }
  if (c.width !== frame.width || c.height !== frame.height) {
    c.width = frame.width;
    c.height = frame.height;
  }
  const tCtx = c.getContext("2d")!;
  tCtx.putImageData(frame, 0, 0);

  if (brightness < 1) {
    tCtx.globalCompositeOperation = "multiply";
    const bv = Math.round(brightness * 255);
    tCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
    tCtx.fillRect(0, 0, frame.width, frame.height);
    tCtx.globalCompositeOperation = "source-over";
  }
  return c;
}

/** Draw a source frame clipped to any shape */
function drawFrameInShape(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  geom: Layer["geometry"],
  frame: ImageData,
  layerId: string,
  brightness: number,
  inputTransform: InputTransform,
  canvasMap: Map<string, HTMLCanvasElement>
) {
  ctx.save();

  // Build clip path and find bounding box
  drawShapePath(ctx, w, h, geom);
  ctx.clip();

  const tmpCanvas = frameToCanvas(frame, layerId, brightness, canvasMap);

  // Get bounding box of the shape
  const bbox = getShapeBBox(w, h, geom);
  drawImageWithInputTransform(ctx, tmpCanvas, bbox, inputTransform);

  ctx.restore();
}

function drawImageWithInputTransform(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  bbox: { x: number; y: number; w: number; h: number },
  input: InputTransform
) {
  const { x, y, w, h } = bbox;
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const sx = Math.max(Math.abs(input.scale[0]), 0.0001);
  const sy = Math.max(Math.abs(input.scale[1]), 0.0001);

  ctx.save();
  // Inverse of shader UV transform
  ctx.translate(-input.offset[0] * w, -input.offset[1] * h);
  ctx.translate(cx, cy);
  ctx.rotate(-input.rotation);
  ctx.scale(1 / sx, 1 / sy);
  ctx.translate(-cx, -cy);
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

/** Draw a shape's path (does not fill or stroke) */
function drawShapePath(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  geom: Layer["geometry"]
) {
  ctx.beginPath();
  if (geom.type === "Quad") {
    const pts = geom.data.corners.map((p) => ({ x: p.x * w, y: p.y * h }));
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
  } else if (geom.type === "Triangle") {
    const pts = geom.data.vertices.map((p) => ({ x: p.x * w, y: p.y * h }));
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.closePath();
  } else if (geom.type === "Circle") {
    const cx = geom.data.center.x * w;
    const cy = geom.data.center.y * h;
    const rx = geom.data.radius_x * w;
    const ry = geom.data.radius_y * h;
    ctx.ellipse(cx, cy, rx, ry, geom.data.rotation, 0, Math.PI * 2);
  } else if (geom.type === "Mesh") {
    const pts = geom.data.points.map((p) => ({ x: p.x * w, y: p.y * h }));
    const { cols, rows } = geom.data;
    // Outer boundary
    for (let c = 0; c <= cols; c++) ctx.lineTo(pts[c].x, pts[c].y);
    for (let r = 1; r <= rows; r++)
      ctx.lineTo(pts[r * (cols + 1) + cols].x, pts[r * (cols + 1) + cols].y);
    for (let c = cols - 1; c >= 0; c--)
      ctx.lineTo(pts[rows * (cols + 1) + c].x, pts[rows * (cols + 1) + c].y);
    for (let r = rows - 1; r >= 0; r--)
      ctx.lineTo(pts[r * (cols + 1)].x, pts[r * (cols + 1)].y);
    ctx.closePath();
  }
}

/** Get axis-aligned bounding box for a shape */
function getShapeBBox(
  w: number,
  h: number,
  geom: Layer["geometry"]
): { x: number; y: number; w: number; h: number } {
  let pts: { x: number; y: number }[];

  if (geom.type === "Quad") {
    pts = geom.data.corners.map((p) => ({ x: p.x * w, y: p.y * h }));
  } else if (geom.type === "Triangle") {
    pts = geom.data.vertices.map((p) => ({ x: p.x * w, y: p.y * h }));
  } else if (geom.type === "Circle") {
    const cx = geom.data.center.x * w;
    const cy = geom.data.center.y * h;
    const rx = geom.data.radius_x * w;
    const ry = geom.data.radius_y * h;
    const c = Math.cos(geom.data.rotation);
    const s = Math.sin(geom.data.rotation);
    const hw = Math.sqrt((rx * c) * (rx * c) + (ry * s) * (ry * s));
    const hh = Math.sqrt((rx * s) * (rx * s) + (ry * c) * (ry * c));
    return { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 };
  } else {
    pts = geom.data.points.map((p) => ({ x: p.x * w, y: p.y * h }));
  }

  const minX = Math.min(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxX = Math.max(...pts.map((p) => p.x));
  const maxY = Math.max(...pts.map((p) => p.y));

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export default ProjectorView;

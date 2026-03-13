import { useEffect, useState, useRef, useCallback } from "react";
import { tauriInvoke, isTauri } from "../../lib/tauri-bridge";
import type {
  CalibrationConfig,
  Layer,
  LayerGroup,
  FrameSnapshot,
  PreviewDelta,
  ProjectSnapshotWithRevision,
  BlendMode,
  InputTransform,
  OutputConfig,
  PerformanceProfile,
} from "../../types";
import { DEFAULT_INPUT_TRANSFORM } from "../../types";
import { drawTriangleTextured } from "../../lib/math";
import { fitAspectViewport, resolveAspectRatioUiState } from "../../lib/aspect-ratios";
import { applySharedInputMapping, resolveLayerSharedInput } from "../../lib/shared-input";
import { PERFORMANCE_PROFILE_KEY } from "../../store/useAppStore";

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

function readPerformanceProfile(): PerformanceProfile {
  if (typeof window === "undefined") return "max_fps";
  const raw = window.localStorage.getItem(PERFORMANCE_PROFILE_KEY);
  return raw === "balanced" ? "balanced" : "max_fps";
}

/**
 * ProjectorView — rendered in the projector output window.
 *
 * Polls project revisions + frame deltas and composites
 * layers onto a Canvas 2D surface. Layers with connected sources
 * show the actual source pixels; layers without sources show white.
 */
function ProjectorView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [groups, setGroups] = useState<LayerGroup[]>([]);
  const [sceneReady, setSceneReady] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationConfig>({
    enabled: false,
    pattern: "grid",
  });
  const [output, setOutput] = useState<OutputConfig>({
    width: 1920,
    height: 1080,
    framerate: 60,
    monitor_preference: null,
  });
  const [uiState, setUiState] = useState<unknown>(null);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  }));
  const framePollIntervalMs = readPerformanceProfile() === "max_fps" ? 50 : 66;
  // Cache of decoded ImageData per layer
  const frameCache = useRef<Map<string, ImageData>>(new Map());
  // Per-layer offscreen canvases (prevents cross-contamination between layers)
  const tmpCanvasMap = useRef<Map<string, HTMLCanvasElement>>(new Map());
  // Tick counter to force re-render when frames update
  const [frameTick, setFrameTick] = useState(0);
  const previewCursorRef = useRef(0);
  const projectRevisionRef = useRef(0);

  useEffect(() => {
    document.body.style.cursor = "none";
    document.body.style.overflow = "hidden";
    document.body.style.background = "#000";
    return () => {
      document.body.style.cursor = "";
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      const next = {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      };
      setViewport((prev) => (
        prev.width === next.width
          && prev.height === next.height
          && prev.dpr === next.dpr
      )
        ? prev
        : next);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pixelWidth = Math.max(1, Math.floor(viewport.width * viewport.dpr));
    const pixelHeight = Math.max(1, Math.floor(viewport.height * viewport.dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
  }, [viewport]);

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

  useEffect(() => {
    void tauriInvoke<void>("set_preview_consumers", { projector_fallback: true }).catch(
      () => undefined
    );
    return () => {
      void tauriInvoke<void>("set_preview_consumers", { projector_fallback: false }).catch(
        () => undefined
      );
    };
  }, []);

  // Poll project state at 4Hz (revision-gated).
  useEffect(() => {
    let running = true;
    const pollProject = async () => {
      while (running) {
        try {
          const next = await tauriInvoke<ProjectSnapshotWithRevision | null>(
            "get_project_if_changed",
            { revision: projectRevisionRef.current }
          );
          if (!running) break;
          if (next) {
            projectRevisionRef.current = next.revision;
            setLayers(next.project.layers);
            setGroups(next.project.groups ?? []);
            setCalibration(next.project.calibration);
            setOutput(next.project.output);
            setUiState(next.project.uiState ?? null);
            setSceneReady(true);
          }
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    pollProject();
    return () => {
      running = false;
    };
  }, []);

  // Poll frame deltas at 20fps (non-overlapping: waits for each cycle to finish)
  useEffect(() => {
    let running = true;
    let deltaFallbackWarned = false;
    let fpsFrames = 0;
    let fpsLastTime = performance.now();
    let lastPollMs = 0;
    let lastDecodeMs = 0;
    let lastFrameCount = 0;
    let lastTotalBytes = 0;

    const pollFrames = async () => {
      while (running) {
        const t0 = performance.now();
        try {
          const delta = await tauriInvoke<PreviewDelta>(
            "poll_all_frames_delta",
            { cursor: previewCursorRef.current }
          );
          const tPoll = performance.now();
          if (!running) break;

          previewCursorRef.current = delta.cursor ?? previewCursorRef.current;
          const cache = frameCache.current;
          let bytes = 0;
          let changed = false;

          if (delta.removed_layer_ids?.length) {
            for (const layerId of delta.removed_layer_ids) {
              cache.delete(layerId);
              tmpCanvasMap.current.delete(layerId);
            }
            changed = true;
          }

          const entries = Object.entries(delta.changed ?? {});
          if (entries.length > 0) {
            const decoded = await Promise.all(
              entries.map(async ([, snapshot]) => decodeFrame(snapshot))
            );
            for (let i = 0; i < entries.length; i++) {
              const [layerId] = entries[i];
              const img = decoded[i];
              bytes += img.data.length;
              cache.set(layerId, img);
            }
            changed = true;
          }

          const tDecode = performance.now();
          lastPollMs = tPoll - t0;
          lastDecodeMs = tDecode - tPoll;
          lastFrameCount = entries.length;
          lastTotalBytes = bytes;
          if (changed) {
            setFrameTick((t) => t + 1);
          }
        } catch (deltaError) {
          if (!deltaFallbackWarned) {
            deltaFallbackWarned = true;
            console.warn("[ProjectorView] poll_all_frames_delta failed; falling back to poll_all_frames", deltaError);
          }
          try {
            const frames = await tauriInvoke<Record<string, FrameSnapshot>>("poll_all_frames");
            if (!running) break;
            const cache = frameCache.current;
            const entries = Object.entries(frames ?? {});
            if (entries.length > 0) {
              const decoded = await Promise.all(
                entries.map(async ([, snapshot]) => decodeFrame(snapshot))
              );
              for (let i = 0; i < entries.length; i++) {
                cache.set(entries[i][0], decoded[i]);
              }
              setFrameTick((t) => t + 1);
            }
          } catch {
            // ignore
          }
        }

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

        await new Promise((r) => setTimeout(r, framePollIntervalMs));
      }
    };

    pollFrames();
    return () => {
      running = false;
      frameCache.current.clear();
      tmpCanvasMap.current.clear();
    };
  }, [decodeFrame, emitPerf, framePollIntervalMs]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = viewport.width;
    const h = viewport.height;
    ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);

    const aspectState = resolveAspectRatioUiState(uiState, output);
    const viewRect = fitAspectViewport(
      w,
      h,
      output.width,
      output.height,
      aspectState.lockEnabled
    );

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
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.rect(viewRect.x, viewRect.y, viewRect.w, viewRect.h);
      ctx.clip();
      ctx.translate(viewRect.x, viewRect.y);
      if (calibration.enabled) {
        drawCalibration(ctx, viewRect.w, viewRect.h, calibration.pattern);
      } else {
        drawLayers(ctx, viewRect.w, viewRect.h, layers, groups, frameCache.current, tmpCanvasMap.current);
      }
      ctx.restore();
    }
  }, [layers, groups, calibration, sceneReady, frameTick, output, uiState, viewport]);

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
  groups: LayerGroup[],
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
    const inputTransform = layer.input_transform ?? DEFAULT_INPUT_TRANSFORM;
    const sharedInput = resolveLayerSharedInput(layer, groups);

    if (frame) {
      if (sharedInput) {
        drawFrameInShapeSharedInput(
          ctx,
          w,
          h,
          layer,
          frame,
          layer.id,
          layer.properties.brightness,
          sharedInput,
          tmpCanvasMap
        );
      } else {
        drawFrameInShape(
          ctx,
          w,
          h,
          layer,
          frame,
          layer.id,
          layer.properties.brightness,
          inputTransform,
          tmpCanvasMap
        );
      }
    } else {
      // No frame — white fill
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * layer.properties.brightness})`;
      drawLayerPath(ctx, w, h, layer);
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
  layer: Layer,
  frame: ImageData,
  layerId: string,
  brightness: number,
  inputTransform: InputTransform,
  canvasMap: Map<string, HTMLCanvasElement>
) {
  ctx.save();

  // Build clip path and find bounding box
  drawLayerPath(ctx, w, h, layer);
  ctx.clip();

  const tmpCanvas = frameToCanvas(frame, layerId, brightness, canvasMap);

  // Get bounding box of the shape
  const bbox = getLayerBBox(w, h, layer);
  drawImageWithInputTransform(ctx, tmpCanvas, bbox, inputTransform);

  ctx.restore();
}

function drawFrameInShapeSharedInput(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  layer: Layer,
  frame: ImageData,
  layerId: string,
  brightness: number,
  sharedInput: NonNullable<ReturnType<typeof resolveLayerSharedInput>>,
  canvasMap: Map<string, HTMLCanvasElement>
) {
  const tmpCanvas = frameToCanvas(frame, layerId, brightness, canvasMap);
  const fw = frame.width;
  const fh = frame.height;
  const geom = layer.geometry;

  ctx.save();
  drawLayerPath(ctx, w, h, layer);
  ctx.clip();

  if (geom.type === "Mesh") {
    const { cols, rows, points } = geom.data;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tl = points[row * (cols + 1) + col];
        const tr = points[row * (cols + 1) + col + 1];
        const br = points[(row + 1) * (cols + 1) + col + 1];
        const bl = points[(row + 1) * (cols + 1) + col];
        const screenPts = [tl, tr, br, bl].map((p) => ({ x: p.x * w, y: p.y * h }));
        const samplePts = [tl, tr, br, bl].map((p) => {
          const uv = applySharedInputMapping({ u: p.x, v: p.y }, sharedInput);
          return { x: uv.u * fw, y: uv.v * fh };
        });
        drawTriangleTextured(ctx, tmpCanvas, [samplePts[0], samplePts[1], samplePts[2]], [screenPts[0], screenPts[1], screenPts[2]]);
        drawTriangleTextured(ctx, tmpCanvas, [samplePts[0], samplePts[2], samplePts[3]], [screenPts[0], screenPts[2], screenPts[3]]);
      }
    }
  } else if (geom.type === "Triangle") {
    const screenPts = geom.data.vertices.map((p) => ({ x: p.x * w, y: p.y * h })) as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number }
    ];
    const samplePts = geom.data.vertices.map((p) => {
      const uv = applySharedInputMapping({ u: p.x, v: p.y }, sharedInput);
      return { x: uv.u * fw, y: uv.v * fh };
    }) as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number }
    ];
    drawTriangleTextured(ctx, tmpCanvas, samplePts, screenPts);
  } else {
    const corners = getLayerBBoxCorners(layer);
    const screenPts = corners.map((p) => ({ x: p.x * w, y: p.y * h }));
    const samplePts = corners.map((p) => {
      const uv = applySharedInputMapping({ u: p.x, v: p.y }, sharedInput);
      return { x: uv.u * fw, y: uv.v * fh };
    });
    drawTriangleTextured(ctx, tmpCanvas, [samplePts[0], samplePts[1], samplePts[2]], [screenPts[0], screenPts[1], screenPts[2]]);
    drawTriangleTextured(ctx, tmpCanvas, [samplePts[0], samplePts[2], samplePts[3]], [screenPts[0], screenPts[2], screenPts[3]]);
  }

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

function meshToCircleParams(points: Array<{ x: number; y: number }>) {
  if (points.length < 4) {
    return { center: { x: 0.5, y: 0.5 }, radius_x: 0.3, radius_y: 0.3, rotation: 0 };
  }
  const tl = points[0];
  const tr = points[1];
  const bl = points[2];
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
  const rx = Math.hypot(tr.x - tl.x, tr.y - tl.y) / 2;
  const ry = Math.hypot(bl.x - tl.x, bl.y - tl.y) / 2;
  const rotation = Math.atan2(tr.y - tl.y, tr.x - tl.x);
  return { center: { x: cx, y: cy }, radius_x: rx, radius_y: ry, rotation };
}

function getLayerBBoxCorners(layer: Layer) {
  if (layer.geometry.type === "Quad") {
    return layer.geometry.data.corners;
  }
  if (layer.geometry.type === "Circle") {
    const { center, radius_x, radius_y, rotation } = layer.geometry.data;
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    return [
      { x: center.x - radius_x * c + radius_y * s, y: center.y - radius_x * s - radius_y * c },
      { x: center.x + radius_x * c + radius_y * s, y: center.y + radius_x * s - radius_y * c },
      { x: center.x + radius_x * c - radius_y * s, y: center.y + radius_x * s + radius_y * c },
      { x: center.x - radius_x * c - radius_y * s, y: center.y - radius_x * s + radius_y * c },
    ];
  }
  if (layer.type === "circle" && layer.geometry.type === "Mesh") {
    const cp = meshToCircleParams(layer.geometry.data.points);
    const c = Math.cos(cp.rotation);
    const s = Math.sin(cp.rotation);
    return [
      { x: cp.center.x - cp.radius_x * c + cp.radius_y * s, y: cp.center.y - cp.radius_x * s - cp.radius_y * c },
      { x: cp.center.x + cp.radius_x * c + cp.radius_y * s, y: cp.center.y + cp.radius_x * s - cp.radius_y * c },
      { x: cp.center.x + cp.radius_x * c - cp.radius_y * s, y: cp.center.y + cp.radius_x * s + cp.radius_y * c },
      { x: cp.center.x - cp.radius_x * c - cp.radius_y * s, y: cp.center.y - cp.radius_x * s + cp.radius_y * c },
    ];
  }
  const bbox = getLayerBBox(1, 1, layer);
  return [
    { x: bbox.x, y: bbox.y },
    { x: bbox.x + bbox.w, y: bbox.y },
    { x: bbox.x + bbox.w, y: bbox.y + bbox.h },
    { x: bbox.x, y: bbox.y + bbox.h },
  ];
}

/** Draw a shape's path (does not fill or stroke) */
function drawLayerPath(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  layer: Layer
) {
  const geom = layer.geometry;
  ctx.beginPath();
  if (layer.type === "circle" && geom.type === "Mesh") {
    const cp = meshToCircleParams(geom.data.points);
    ctx.ellipse(cp.center.x * w, cp.center.y * h, cp.radius_x * w, cp.radius_y * h, cp.rotation, 0, Math.PI * 2);
    return;
  }
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
    ctx.moveTo(pts[0].x, pts[0].y);
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
function getLayerBBox(
  w: number,
  h: number,
  layer: Layer
): { x: number; y: number; w: number; h: number } {
  const geom = layer.geometry;
  let pts: { x: number; y: number }[];

  if (layer.type === "circle" && geom.type === "Mesh") {
    const cp = meshToCircleParams(geom.data.points);
    const cx = cp.center.x * w;
    const cy = cp.center.y * h;
    const rx = cp.radius_x * w;
    const ry = cp.radius_y * h;
    const c = Math.cos(cp.rotation);
    const s = Math.sin(cp.rotation);
    const hw = Math.sqrt((rx * c) * (rx * c) + (ry * s) * (ry * s));
    const hh = Math.sqrt((rx * s) * (rx * s) + (ry * c) * (ry * c));
    return { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 };
  }

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

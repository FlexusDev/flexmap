import { useRef, useEffect, useState, useCallback } from "react";
import { useAppStore } from "../../store/useAppStore";
import { tauriInvoke } from "../../lib/tauri-bridge";
import type {
  Point2D,
  LayerGeometry,
  FrameSnapshot,
  BlendMode,
  InputTransform,
  UvAdjustment,
  EditorSelectionMode,
} from "../../types";
import { DEFAULT_INPUT_TRANSFORM } from "../../types";
import type { PerfStats } from "../../store/useAppStore";
import { hashPoints, drawTriangleTextured } from "../../lib/math";

/** Fast base64→Uint8ClampedArray decode using fetch + data URI (avoids byte-by-byte loop) */
async function decodeBase64Fast(b64: string): Promise<Uint8ClampedArray<ArrayBuffer>> {
  try {
    const res = await fetch(`data:application/octet-stream;base64,${b64}`);
    const buf: ArrayBuffer = await res.arrayBuffer();
    return new Uint8ClampedArray(buf);
  } catch {
    // Fallback to manual decode
    const binary = atob(b64);
    const bytes = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

/** Map our BlendMode to Canvas2D globalCompositeOperation */
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

const POINT_RADIUS = 6;
const POINT_HIT_RADIUS = 12;
const GRID_COLOR = "#1e1e1e";
const LAYER_STROKE = "#6366f1";
const LAYER_FILL = "rgba(99, 102, 241, 0.08)";
const SELECTED_STROKE = "#818cf8";
const SELECTED_FILL = "rgba(99, 102, 241, 0.15)";
const POINT_COLOR = "#6366f1";
const POINT_SELECTED_COLOR = "#c7d2fe";
const NUDGE_AMOUNT = 0.005;
const FINE_NUDGE = 0.001;

const TWO_PI = Math.PI * 2;
const TRANSFORM_EPS = 1e-6;

type ShapeEditTool = "points" | "drag" | "rotate";

function applyUvAdjustmentToUv(
  uv: { u: number; v: number },
  center: { u: number; v: number },
  adj: UvAdjustment
): { u: number; v: number } {
  const sx = adj.scale[0];
  const sy = adj.scale[1];
  const c = Math.cos(adj.rotation);
  const s = Math.sin(adj.rotation);
  const du = (uv.u - center.u) * sx;
  const dv = (uv.v - center.v) * sy;
  return {
    u: du * c - dv * s + center.u + adj.offset[0],
    v: du * s + dv * c + center.v + adj.offset[1],
  };
}

function applyInputTransformToUv(
  uv: { u: number; v: number },
  t: InputTransform
): { u: number; v: number } {
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const du = (uv.u - 0.5) * t.scale[0];
  const dv = (uv.v - 0.5) * t.scale[1];
  return {
    u: du * c - dv * s + 0.5 + t.offset[0],
    v: du * s + dv * c + 0.5 + t.offset[1],
  };
}

function ellipseHalfExtents(rx: number, ry: number, rotation: number): { hw: number; hh: number } {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return {
    hw: Math.sqrt((rx * c) * (rx * c) + (ry * s) * (ry * s)),
    hh: Math.sqrt((rx * s) * (rx * s) + (ry * c) * (ry * c)),
  };
}

function normalizeAngleDelta(rad: number): number {
  let a = rad;
  while (a > Math.PI) a -= TWO_PI;
  while (a < -Math.PI) a += TWO_PI;
  return a;
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
  // Inverse of UV transform to match shader-side sampling behavior.
  ctx.translate(-input.offset[0] * w, -input.offset[1] * h);
  ctx.translate(cx, cy);
  ctx.rotate(-input.rotation);
  ctx.scale(1 / sx, 1 / sy);
  ctx.translate(-cx, -cy);
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

interface DragState {
  layerId: string;
  pointIndex: number;
  startMouse: { x: number; y: number };
  startPoint: Point2D;
}

interface InputDragState {
  layerId: string;
  startMouse: { x: number; y: number };
  startOffset: [number, number];
}

interface InputRotateState {
  layerId: string;
  center: { x: number; y: number };
  startAngle: number;
  startRotation: number;
}

interface ShapeTransformState {
  layerId: string;
  mode: "drag" | "rotate";
  lastMouse: { x: number; y: number };
  center: { x: number; y: number };
  lastAngle: number;
}

/** Offscreen warp cache per layer */
interface WarpCache {
  canvas: HTMLCanvasElement;
  geoHash: number;
  frameGen: number;
}

function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [inputDragState, setInputDragState] = useState<InputDragState | null>(null);
  const [inputRotateState, setInputRotateState] = useState<InputRotateState | null>(null);
  const [inputEditTool, setInputEditTool] = useState<"faces" | "drag" | "rotate">("faces");
  const [shapeEditTool, setShapeEditTool] = useState<ShapeEditTool>("points");
  const [shapeTransformActive, setShapeTransformActive] = useState(false);
  const [hoveredPoint, setHoveredPoint] = useState<{
    layerId: string;
    index: number;
  } | null>(null);
  const [hoveredFaceIndex, setHoveredFaceIndex] = useState<number | null>(null);

  const {
    layers, selectedLayerId, selectedFaceIndices,
    selectLayer, setSelectedFaces, toggleFaceSelection, clearFaceSelection,
    updateLayerPoint, applyGeometryTransformDelta,
    beginInteraction, setEditorPerf, snapEnabled, editorSelectionMode,
    setLayerInputTransform, toggleEditorSelectionMode,
  } = useAppStore();

  const selectedLayer = selectedLayerId
    ? layers.find((l) => l.id === selectedLayerId) ?? null
    : null;
  const meshSelected = selectedLayer?.geometry.type === "Mesh";
  const selectionMode: EditorSelectionMode = selectedLayer ? editorSelectionMode : "shape";
  const isUvMode = selectionMode === "uv";
  const effectiveInputTool: "faces" | "drag" | "rotate" = meshSelected
    ? inputEditTool
    : inputEditTool === "faces"
      ? "drag"
      : inputEditTool;
  const isInputFaceMode = isUvMode && meshSelected && effectiveInputTool === "faces";
  const isInputDragMode = isUvMode && !!selectedLayer && effectiveInputTool === "drag";
  const isInputRotateMode = isUvMode && !!selectedLayer && effectiveInputTool === "rotate";
  const isInputMode = isInputDragMode || isInputRotateMode;
  const isShapeMode = !isUvMode;
  const isShapePointMode = isShapeMode && shapeEditTool === "points";
  const isShapeDragMode = isShapeMode && shapeEditTool === "drag";
  const isShapeRotateMode = isShapeMode && shapeEditTool === "rotate";

  const handleModeChipToggle = useCallback(() => {
    if (!selectedLayer) return;
    toggleEditorSelectionMode();
  }, [selectedLayer, toggleEditorSelectionMode]);

  // Track whether we've already pushed undo for the current arrow-nudge burst
  const nudgeUndoPushed = useRef(false);
  // Cached source frame ImageData per layer
  const frameCache = useRef<Map<string, ImageData>>(new Map());
  // Per-layer offscreen canvases (one each to prevent cross-contamination)
  const tmpCanvasMap = useRef<Map<string, HTMLCanvasElement>>(new Map());
  // Last drawn frame generation per layer (skip putImageData when unchanged)
  const lastFrameGenMap = useRef<Map<string, number>>(new Map());
  // Monotonic counter bumped when frameCache is updated
  const frameTick = useRef(0);
  const [frameTickState, setFrameTickState] = useState(0);
  // Warp cache for per-triangle textured preview
  const warpCacheMap = useRef<Map<string, WarpCache>>(new Map());
  // Input transform drag queue (RAF-throttled + single in-flight IPC)
  const inputPendingRef = useRef<{ layerId: string; transform: InputTransform } | null>(null);
  const inputInFlightRef = useRef(false);
  const inputRafRef = useRef<number | null>(null);
  // Shape drag/rotate state (mutable to avoid per-move re-renders)
  const shapeTransformRef = useRef<ShapeTransformState | null>(null);
  // Geometry delta queue for shape drag/rotate
  const geometryPendingRef = useRef<{
    layerId: string;
    dx: number;
    dy: number;
    dRotation: number;
  } | null>(null);
  const geometryInFlightRef = useRef(false);
  const geometryRafRef = useRef<number | null>(null);

  // Poll source frames at ~15fps for editor preview (non-overlapping)
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
          const frames = await tauriInvoke<Record<string, FrameSnapshot>>(
            "poll_all_frames"
          );
          const tPoll = performance.now();
          if (!running) break;

          if (frames && Object.keys(frames).length > 0) {
            const cache = frameCache.current;
            let bytes = 0;
            const entries = Object.entries(frames);
            const decoded = await Promise.all(
              entries.map(async ([, snapshot]) => {
                const arr = await decodeBase64Fast(snapshot.data_b64);
                return arr;
              })
            );
            for (let i = 0; i < entries.length; i++) {
              const [layerId, snapshot] = entries[i];
              const arr = decoded[i];
              bytes += arr.length;
              cache.set(layerId, new ImageData(arr, snapshot.width, snapshot.height));
            }
            const tDecode = performance.now();

            lastPollMs = tPoll - t0;
            lastDecodeMs = tDecode - tPoll;
            lastFrameCount = Object.keys(frames).length;
            lastTotalBytes = bytes;

            frameTick.current += 1;
            setFrameTickState((t) => t + 1);
          }
        } catch {
          // ignore
        }

        const frametime = performance.now() - t0;
        fpsFrames++;
        const elapsed = performance.now() - fpsLastTime;
        if (elapsed >= 1000) {
          const stats: PerfStats = {
            fps: Math.round((fpsFrames / elapsed) * 1000),
            frametime: Math.round(frametime * 10) / 10,
            pollMs: Math.round(lastPollMs * 10) / 10,
            decodeMs: Math.round(lastDecodeMs * 10) / 10,
            drawMs: 0,
            frameCount: lastFrameCount,
            totalBytes: lastTotalBytes,
          };
          setEditorPerf(stats);
          fpsFrames = 0;
          fpsLastTime = performance.now();
        }

        await new Promise((r) => setTimeout(r, 33));
      }
    };

    poll();
    return () => { running = false; };
  }, [setEditorPerf]);

  useEffect(() => {
    return () => {
      if (inputRafRef.current !== null) {
        cancelAnimationFrame(inputRafRef.current);
        inputRafRef.current = null;
      }
      if (geometryRafRef.current !== null) {
        cancelAnimationFrame(geometryRafRef.current);
        geometryRafRef.current = null;
      }
      inputPendingRef.current = null;
      geometryPendingRef.current = null;
      shapeTransformRef.current = null;
    };
  }, []);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ w: Math.floor(width), h: Math.floor(height) });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Coordinate conversion: normalized [0,1] → canvas pixels
  const toCanvas = useCallback(
    (p: Point2D): { x: number; y: number } => ({
      x: p.x * canvasSize.w,
      y: p.y * canvasSize.h,
    }),
    [canvasSize]
  );

  const flushInputTransform = useCallback(() => {
    if (inputInFlightRef.current) return;
    const pending = inputPendingRef.current;
    if (!pending) return;
    inputPendingRef.current = null;
    inputInFlightRef.current = true;
    void setLayerInputTransform(pending.layerId, pending.transform).finally(() => {
      inputInFlightRef.current = false;
      if (inputPendingRef.current) {
        flushInputTransform();
      }
    });
  }, [setLayerInputTransform]);

  const scheduleInputTransform = useCallback(
    (layerId: string, transform: InputTransform, immediate = false) => {
      inputPendingRef.current = { layerId, transform };
      if (immediate) {
        if (inputRafRef.current !== null) {
          cancelAnimationFrame(inputRafRef.current);
          inputRafRef.current = null;
        }
        flushInputTransform();
        return;
      }
      if (inputRafRef.current === null) {
        inputRafRef.current = requestAnimationFrame(() => {
          inputRafRef.current = null;
          flushInputTransform();
        });
      }
    },
    [flushInputTransform]
  );

  const flushGeometryDelta = useCallback(() => {
    if (geometryInFlightRef.current) return;
    const pending = geometryPendingRef.current;
    if (!pending) return;
    geometryPendingRef.current = null;
    geometryInFlightRef.current = true;
    void applyGeometryTransformDelta(pending.layerId, {
      dx: pending.dx,
      dy: pending.dy,
      dRotation: pending.dRotation,
      sx: 1,
      sy: 1,
    }).finally(() => {
      geometryInFlightRef.current = false;
      if (geometryPendingRef.current) {
        flushGeometryDelta();
      }
    });
  }, [applyGeometryTransformDelta]);

  const enqueueGeometryDelta = useCallback(
    (
      layerId: string,
      delta: { dx?: number; dy?: number; dRotation?: number },
      immediate = false
    ) => {
      const dx = delta.dx ?? 0;
      const dy = delta.dy ?? 0;
      const dRotation = delta.dRotation ?? 0;
      if (Math.abs(dx) < TRANSFORM_EPS
        && Math.abs(dy) < TRANSFORM_EPS
        && Math.abs(dRotation) < TRANSFORM_EPS) {
        return;
      }

      const pending = geometryPendingRef.current;
      if (!pending || pending.layerId !== layerId) {
        geometryPendingRef.current = { layerId, dx, dy, dRotation };
      } else {
        pending.dx += dx;
        pending.dy += dy;
        pending.dRotation += dRotation;
      }

      if (immediate) {
        if (geometryRafRef.current !== null) {
          cancelAnimationFrame(geometryRafRef.current);
          geometryRafRef.current = null;
        }
        flushGeometryDelta();
        return;
      }

      if (geometryRafRef.current === null) {
        geometryRafRef.current = requestAnimationFrame(() => {
          geometryRafRef.current = null;
          flushGeometryDelta();
        });
      }
    },
    [flushGeometryDelta]
  );

  const finishShapeTransform = useCallback(() => {
    if (!shapeTransformRef.current) return;
    if (geometryRafRef.current !== null) {
      cancelAnimationFrame(geometryRafRef.current);
      geometryRafRef.current = null;
    }
    flushGeometryDelta();
    shapeTransformRef.current = null;
    setShapeTransformActive(false);
  }, [flushGeometryDelta]);

  useEffect(() => {
    if (isInputFaceMode) {
      setHoveredPoint(null);
      setDragState(null);
      setInputDragState(null);
      setInputRotateState(null);
      finishShapeTransform();
      return;
    }
    if (isInputMode) {
      setHoveredPoint(null);
      setHoveredFaceIndex(null);
      setDragState(null);
      finishShapeTransform();
      return;
    }

    if (!isShapeDragMode && !isShapeRotateMode) {
      finishShapeTransform();
    }
    if (!isShapePointMode) {
      setHoveredPoint(null);
      setDragState(null);
    }
    setHoveredFaceIndex(null);
    setInputDragState(null);
    setInputRotateState(null);
  }, [
    isInputFaceMode,
    isInputMode,
    isShapePointMode,
    isShapeDragMode,
    isShapeRotateMode,
    finishShapeTransform,
  ]);

  // Get control points for a geometry
  const getPoints = (geom: LayerGeometry): Point2D[] => {
    switch (geom.type) {
      case "Quad":
        return [...geom.data.corners];
      case "Triangle":
        return [...geom.data.vertices];
      case "Mesh":
        return [...geom.data.points];
      case "Circle":
        return [geom.data.center];
    }
  };

  // Find point under cursor
  const hitTest = (
    mx: number,
    my: number
  ): { layerId: string; index: number } | null => {
    const testOrder = selectedLayerId
      ? [
          layers.find((l) => l.id === selectedLayerId),
          ...layers.filter((l) => l.id !== selectedLayerId),
        ].filter(Boolean)
      : layers;

    for (const layer of testOrder) {
      if (!layer || !layer.visible || layer.locked) continue;
      const points = getPoints(layer.geometry);
      for (let i = 0; i < points.length; i++) {
        const cp = toCanvas(points[i]);
        const dx = mx - cp.x;
        const dy = my - cp.y;
        if (dx * dx + dy * dy <= POINT_HIT_RADIUS * POINT_HIT_RADIUS) {
          return { layerId: layer.id, index: i };
        }
      }
    }
    return null;
  };

  /** Point-in-quad test using cross products */
  const pointInQuad = (
    px: number, py: number,
    tl: {x:number;y:number}, tr: {x:number;y:number},
    br: {x:number;y:number}, bl: {x:number;y:number}
  ): boolean => {
    const cross = (ax:number,ay:number,bx:number,by:number,cx:number,cy:number) =>
      (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);
    const pts = [tl, tr, br, bl];
    const signs = pts.map((p, i) => {
      const next = pts[(i+1) % 4];
      return cross(p.x, p.y, next.x, next.y, px, py) >= 0;
    });
    return signs.every(Boolean) || signs.every((s) => !s);
  };

  const pointInTriangle = (
    px: number, py: number,
    a: { x: number; y: number },
    b: { x: number; y: number },
    c: { x: number; y: number }
  ): boolean => {
    const sign = (p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }) =>
      (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const p = { x: px, y: py };
    const d1 = sign(p, a, b);
    const d2 = sign(p, b, c);
    const d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };

  /** Find which mesh face index the mouse is over (returns null if none) */
  const faceHitTest = (mx: number, my: number, layerId: string): number | null => {
    const layer = layers.find((l) => l.id === layerId);
    if (!layer || layer.geometry.type !== "Mesh") return null;
    const { cols, rows } = layer.geometry.data;
    const pts = layer.geometry.data.points.map(toCanvas);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tl = pts[r * (cols + 1) + c];
        const tr = pts[r * (cols + 1) + c + 1];
        const br = pts[(r + 1) * (cols + 1) + c + 1];
        const bl = pts[(r + 1) * (cols + 1) + c];
        if (pointInQuad(mx, my, tl, tr, br, bl)) {
          return r * cols + c;
        }
      }
    }
    return null;
  };

  const pointInLayer = (mx: number, my: number, layer: (typeof layers)[number]): boolean => {
    if (layer.geometry.type === "Quad") {
      const pts = layer.geometry.data.corners.map(toCanvas);
      return pointInQuad(mx, my, pts[0], pts[1], pts[2], pts[3]);
    }
    if (layer.geometry.type === "Triangle") {
      const pts = layer.geometry.data.vertices.map(toCanvas);
      return pointInTriangle(mx, my, pts[0], pts[1], pts[2]);
    }
    if (layer.geometry.type === "Circle") {
      const center = toCanvas(layer.geometry.data.center);
      const rx = Math.max(layer.geometry.data.radius_x * canvasSize.w, 0.0001);
      const ry = Math.max(layer.geometry.data.radius_y * canvasSize.h, 0.0001);
      const rot = layer.geometry.data.rotation;
      const dx = mx - center.x;
      const dy = my - center.y;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const localX = dx * c + dy * s;
      const localY = -dx * s + dy * c;
      return (localX * localX) / (rx * rx) + (localY * localY) / (ry * ry) <= 1;
    }
    return faceHitTest(mx, my, layer.id) !== null;
  };

  const layerBodyHitTest = (mx: number, my: number): string | null => {
    const testOrder = selectedLayerId
      ? [
          layers.find((l) => l.id === selectedLayerId),
          ...layers
            .filter((l) => l.id !== selectedLayerId)
            .sort((a, b) => b.zIndex - a.zIndex),
        ].filter(Boolean)
      : [...layers].sort((a, b) => b.zIndex - a.zIndex);

    for (const layer of testOrder) {
      if (!layer || !layer.visible || layer.locked) continue;
      if (pointInLayer(mx, my, layer)) {
        return layer.id;
      }
    }
    return null;
  };

  const getLayerCenterCanvas = (layer: (typeof layers)[number]): { x: number; y: number } => {
    const pts = getPoints(layer.geometry).map(toCanvas);
    if (pts.length === 0) return { x: canvasSize.w * 0.5, y: canvasSize.h * 0.5 };
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / pts.length, y: sy / pts.length };
  };

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (isShapePointMode) {
      const hit = hitTest(mx, my);
      if (hit) {
        selectLayer(hit.layerId);
        const layer = layers.find((l) => l.id === hit.layerId);
        if (layer) {
          beginInteraction();
          const points = getPoints(layer.geometry);
          setDragState({
            layerId: hit.layerId,
            pointIndex: hit.index,
            startMouse: { x: mx, y: my },
            startPoint: points[hit.index],
          });
        }
        return;
      }
    }

    if (isShapeDragMode || isShapeRotateMode) {
      const hitLayerId = layerBodyHitTest(mx, my);
      if (hitLayerId) {
        const layer = layers.find((l) => l.id === hitLayerId);
        if (layer) {
          selectLayer(layer.id);
          beginInteraction();
          const center = getLayerCenterCanvas(layer);
          const startAngle = Math.atan2(my - center.y, mx - center.x);
          shapeTransformRef.current = {
            layerId: layer.id,
            mode: isShapeDragMode ? "drag" : "rotate",
            lastMouse: { x: mx, y: my },
            center,
            lastAngle: startAngle,
          };
          setShapeTransformActive(true);
        }
        return;
      }
    }

    // UV mode on mesh layers: face selection
    if (isInputFaceMode && selectedLayerId) {
      const faceIdx = faceHitTest(mx, my, selectedLayerId);
      if (faceIdx !== null) {
        if (e.shiftKey) {
          toggleFaceSelection(faceIdx);
        } else {
          setSelectedFaces([faceIdx]);
        }
        return;
      }
    }

    // Input mode: drag/rotate input for any layer type
    if (isInputDragMode || isInputRotateMode) {
      const hitLayerId = layerBodyHitTest(mx, my);
      if (hitLayerId) {
        const layer = layers.find((l) => l.id === hitLayerId);
        if (layer) {
          selectLayer(layer.id);
          beginInteraction();
          const input = layer.input_transform ?? DEFAULT_INPUT_TRANSFORM;
          if (isInputDragMode) {
            setInputDragState({
              layerId: layer.id,
              startMouse: { x: mx, y: my },
              startOffset: [input.offset[0], input.offset[1]],
            });
          } else {
            const center = getLayerCenterCanvas(layer);
            const startAngle = Math.atan2(my - center.y, mx - center.x);
            setInputRotateState({
              layerId: layer.id,
              center,
              startAngle,
              startRotation: input.rotation,
            });
          }
        }
        return;
      }
    }

    // Click on empty area — deselect layer + clear faces
    selectLayer(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const shapeTransform = shapeTransformRef.current;
    if (shapeTransform) {
      if (!layers.some((l) => l.id === shapeTransform.layerId)) {
        finishShapeTransform();
        return;
      }
      if (shapeTransform.mode === "drag") {
        const dx = (mx - shapeTransform.lastMouse.x) / canvasSize.w;
        const dy = (my - shapeTransform.lastMouse.y) / canvasSize.h;
        shapeTransform.lastMouse = { x: mx, y: my };
        enqueueGeometryDelta(shapeTransform.layerId, { dx, dy }, false);
      } else {
        const nextAngle = Math.atan2(my - shapeTransform.center.y, mx - shapeTransform.center.x);
        const dRotation = normalizeAngleDelta(nextAngle - shapeTransform.lastAngle);
        shapeTransform.lastAngle = nextAngle;
        enqueueGeometryDelta(shapeTransform.layerId, { dRotation }, false);
      }
      return;
    }

    if (inputRotateState) {
      const layer = layers.find((l) => l.id === inputRotateState.layerId);
      if (!layer) return;
      const nextAngle = Math.atan2(my - inputRotateState.center.y, mx - inputRotateState.center.x);
      const dRotation = normalizeAngleDelta(nextAngle - inputRotateState.startAngle);
      const base = layer.input_transform ?? DEFAULT_INPUT_TRANSFORM;
      const next: InputTransform = {
        ...base,
        rotation: inputRotateState.startRotation + dRotation,
      };
      scheduleInputTransform(layer.id, next, false);
    } else if (inputDragState) {
      const layer = layers.find((l) => l.id === inputDragState.layerId);
      if (!layer) return;

      const dx = (mx - inputDragState.startMouse.x) / canvasSize.w;
      const dy = (my - inputDragState.startMouse.y) / canvasSize.h;
      const nextOffsetX = Math.max(-1, Math.min(1, inputDragState.startOffset[0] - dx));
      const nextOffsetY = Math.max(-1, Math.min(1, inputDragState.startOffset[1] - dy));
      const base = layer.input_transform ?? DEFAULT_INPUT_TRANSFORM;
      const next: InputTransform = {
        ...base,
        offset: [nextOffsetX, nextOffsetY],
      };
      scheduleInputTransform(layer.id, next, false);
    } else if (isShapePointMode && dragState) {
      const layer = layers.find((l) => l.id === dragState.layerId);
      if (!layer) return;

      const dx = (mx - dragState.startMouse.x) / canvasSize.w;
      const dy = (my - dragState.startMouse.y) / canvasSize.h;

      let nx = Math.max(0, Math.min(1, dragState.startPoint.x + dx));
      let ny = Math.max(0, Math.min(1, dragState.startPoint.y + dy));

      if (snapEnabled) {
        const SNAP_GRID = 0.05;
        nx = Math.round(nx / SNAP_GRID) * SNAP_GRID;
        ny = Math.round(ny / SNAP_GRID) * SNAP_GRID;
      }

      const newPt: Point2D = { x: nx, y: ny };
      void updateLayerPoint(layer.id, dragState.pointIndex, newPt);
    } else {
      if (isInputFaceMode) {
        setHoveredPoint(null);
        if (selectedLayerId) {
          setHoveredFaceIndex(faceHitTest(mx, my, selectedLayerId));
        } else {
          setHoveredFaceIndex(null);
        }
      } else if (isInputMode) {
        setHoveredPoint(null);
        setHoveredFaceIndex(null);
      } else if (isShapePointMode) {
        const hit = hitTest(mx, my);
        setHoveredPoint(hit);
        setHoveredFaceIndex(null);
      } else {
        setHoveredPoint(null);
        setHoveredFaceIndex(null);
      }
    }
  };

  const handleMouseUp = () => {
    setDragState(null);
    finishShapeTransform();
    if (inputDragState || inputRotateState) {
      if (inputRafRef.current !== null) {
        cancelAnimationFrame(inputRafRef.current);
        inputRafRef.current = null;
      }
      flushInputTransform();
      setInputDragState(null);
      setInputRotateState(null);
    }
  };

  // Keyboard handler for nudging
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Escape: clear face selection
      if (e.key === "Escape" && selectedFaceIndices.length > 0) {
        e.preventDefault();
        clearFaceSelection();
        return;
      }

      if (!selectedLayerId) return;
      const layer = layers.find((l) => l.id === selectedLayerId);
      if (!layer || layer.locked) return;

      const amount = e.shiftKey ? FINE_NUDGE : NUDGE_AMOUNT;
      let dx = 0, dy = 0;

      switch (e.key) {
        case "ArrowLeft":  dx = -amount; break;
        case "ArrowRight": dx = amount;  break;
        case "ArrowUp":    dy = -amount; break;
        case "ArrowDown":  dy = amount;  break;
        default: return;
      }

      e.preventDefault();

      if (!nudgeUndoPushed.current) {
        nudgeUndoPushed.current = true;
        beginInteraction();
      }

      void applyGeometryTransformDelta(layer.id, {
        dx,
        dy,
        dRotation: 0,
        sx: 1,
        sy: 1,
      });
    },
    [
      selectedLayerId,
      selectedFaceIndices,
      layers,
      applyGeometryTransformDelta,
      beginInteraction,
      clearFaceSelection,
    ]
  );

  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        nudgeUndoPushed.current = false;
      }
    },
    []
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Disable alpha compositing for opaque background — measurable speedup
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.w * dpr;
    canvas.height = canvasSize.h * dpr;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvasSize.w, canvasSize.h);

    // Draw grid — batched into 2 stroke() calls instead of ~116
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    const gridStep = 50;
    ctx.beginPath();
    for (let x = 0; x <= canvasSize.w; x += gridStep) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasSize.h);
    }
    for (let y = 0; y <= canvasSize.h; y += gridStep) {
      ctx.moveTo(0, y);
      ctx.lineTo(canvasSize.w, y);
    }
    ctx.stroke();

    // Draw layers (bottom to top)
    const sorted = [...layers]
      .filter((l) => l.visible)
      .sort((a, b) => a.zIndex - b.zIndex);

    const currentFrameTick = frameTick.current;

    for (const layer of sorted) {
      const isSelected = layer.id === selectedLayerId;
      const points = getPoints(layer.geometry).map(toCanvas);
      const inputTransform = layer.input_transform ?? DEFAULT_INPUT_TRANSFORM;
      const frame = frameCache.current.get(layer.id);

      ctx.strokeStyle = isSelected ? SELECTED_STROKE : LAYER_STROKE;
      ctx.lineWidth = isSelected ? 2 : 1;

      // --- Paint source frame (or fallback fill) inside the shape ---
      if (frame) {
        // Get or create dedicated offscreen canvas for this layer
        let tmpC = tmpCanvasMap.current.get(layer.id);
        if (!tmpC) {
          tmpC = document.createElement("canvas");
          tmpCanvasMap.current.set(layer.id, tmpC);
        }
        if (tmpC.width !== frame.width || tmpC.height !== frame.height) {
          tmpC.width = frame.width;
          tmpC.height = frame.height;
        }
        const tmpCtx = tmpC.getContext("2d")!;

        // Skip putImageData when frame generation hasn't changed — avoids 8MB CPU→GPU copy
        const lastGen = lastFrameGenMap.current.get(layer.id);
        if (lastGen !== currentFrameTick) {
          tmpCtx.putImageData(frame, 0, 0);
          lastFrameGenMap.current.set(layer.id, currentFrameTick);
        }

        ctx.save();
        ctx.globalAlpha = layer.properties.opacity;
        ctx.globalCompositeOperation = blendModeToComposite(layer.blend_mode);

        if (layer.geometry.type === "Mesh") {
          // Per-triangle warp with offscreen cache
          const {
            cols,
            rows,
            points: rawPts,
            uv_overrides: uvOverrides = {},
            masked_faces: maskedFaces = [],
          } = layer.geometry.data;
          let uvHash = 0;
          for (const [faceIndex, adj] of Object.entries(uvOverrides)) {
            uvHash ^= (Number(faceIndex) * 2654435761) >>> 0;
            uvHash ^= ((adj.offset[0] * 1e6) | 0) >>> 0;
            uvHash ^= ((adj.offset[1] * 1e6) | 0) >>> 0;
            uvHash ^= ((adj.rotation * 1e6) | 0) >>> 0;
            uvHash ^= ((adj.scale[0] * 1e6) | 0) >>> 0;
            uvHash ^= ((adj.scale[1] * 1e6) | 0) >>> 0;
          }
          let maskHash = 0;
          for (const faceIdx of maskedFaces) {
            maskHash ^= (faceIdx * 2246822519) >>> 0;
          }
          const inputHash =
            (((inputTransform.offset[0] * 1e6) | 0) >>> 0)
            ^ (((inputTransform.offset[1] * 1e6) | 0) >>> 0)
            ^ (((inputTransform.rotation * 1e6) | 0) >>> 0)
            ^ (((inputTransform.scale[0] * 1e6) | 0) >>> 0)
            ^ (((inputTransform.scale[1] * 1e6) | 0) >>> 0);
          const geoHash =
            hashPoints(rawPts)
            ^ uvHash
            ^ maskHash
            ^ inputHash
            ^ (currentFrameTick * 0x9e3779b9);
          let warp = warpCacheMap.current.get(layer.id);

          if (!warp || warp.geoHash !== geoHash) {
            // Cache miss: render all triangles to offscreen
            // Compute bounding box (single-pass, no temp arrays)
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of points) {
              if (p.x < minX) minX = p.x;
              if (p.y < minY) minY = p.y;
              if (p.x > maxX) maxX = p.x;
              if (p.y > maxY) maxY = p.y;
            }
            minX = Math.floor(minX); minY = Math.floor(minY);
            maxX = Math.ceil(maxX);  maxY = Math.ceil(maxY);
            const bw = Math.max(1, maxX - minX);
            const bh = Math.max(1, maxY - minY);

            if (!warp) {
              const warpCanvas = document.createElement("canvas");
              warp = { canvas: warpCanvas, geoHash: 0, frameGen: 0 };
              warpCacheMap.current.set(layer.id, warp);
            }
            warp.canvas.width = bw;
            warp.canvas.height = bh;
            const wCtx = warp.canvas.getContext("2d")!;
            wCtx.clearRect(0, 0, bw, bh);
            wCtx.translate(-minX, -minY);

            const maskedSet = new Set(layer.geometry.data.masked_faces ?? []);

            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const faceIdx = r * cols + c;
                if (maskedSet.has(faceIdx)) continue;

                const tl = points[r * (cols + 1) + c];
                const tr = points[r * (cols + 1) + c + 1];
                const br = points[(r + 1) * (cols + 1) + c + 1];
                const bl = points[(r + 1) * (cols + 1) + c];

                const fw = frame.width;
                const fh = frame.height;
                const centerUv = { u: (c + 0.5) / cols, v: (r + 0.5) / rows };
                const baseUvs = [
                  { u: c / cols, v: r / rows },
                  { u: (c + 1) / cols, v: r / rows },
                  { u: (c + 1) / cols, v: (r + 1) / rows },
                  { u: c / cols, v: (r + 1) / rows },
                ];
                const uvOverride = layer.geometry.data.uv_overrides?.[faceIdx];
                const finalUvs = baseUvs.map((uv) => {
                  const withFace = uvOverride
                    ? applyUvAdjustmentToUv(uv, centerUv, uvOverride)
                    : uv;
                  const withLayer = applyInputTransformToUv(withFace, inputTransform);
                  return { x: withLayer.u * fw, y: withLayer.v * fh };
                });

                // Triangle 1: TL, TR, BR
                wCtx.save();
                drawTriangleTextured(
                  wCtx, tmpC,
                  [finalUvs[0], finalUvs[1], finalUvs[2]],
                  [tl, tr, br]
                );
                wCtx.restore();

                // Triangle 2: TL, BR, BL
                wCtx.save();
                drawTriangleTextured(
                  wCtx, tmpC,
                  [finalUvs[0], finalUvs[2], finalUvs[3]],
                  [tl, br, bl]
                );
                wCtx.restore();
              }
            }

            wCtx.translate(minX, minY); // undo the translate
            warp.geoHash = geoHash;
            warp.frameGen = currentFrameTick;

            // Draw masked faces (dark overlay) — on top of warped content
            if (maskedSet.size > 0) {
              wCtx.save();
              wCtx.translate(-minX, -minY);
              wCtx.fillStyle = "rgba(0,0,0,0.75)";
              for (const faceIdx of maskedSet) {
                const r = Math.floor(faceIdx / cols);
                const c = faceIdx % cols;
                const tl = points[r * (cols + 1) + c];
                const tr = points[r * (cols + 1) + c + 1];
                const br = points[(r + 1) * (cols + 1) + c + 1];
                const bl = points[(r + 1) * (cols + 1) + c];
                wCtx.beginPath();
                wCtx.moveTo(tl.x, tl.y);
                wCtx.lineTo(tr.x, tr.y);
                wCtx.lineTo(br.x, br.y);
                wCtx.lineTo(bl.x, bl.y);
                wCtx.closePath();
                wCtx.fill();
              }
              wCtx.restore();
            }

          }

          // Blit warp cache to main canvas — 1 drawImage call
          let minX2 = Infinity, minY2 = Infinity;
          for (const p of points) {
            if (p.x < minX2) minX2 = p.x;
            if (p.y < minY2) minY2 = p.y;
          }
          ctx.drawImage(warp.canvas, Math.round(minX2), Math.round(minY2));
        } else {
          // Non-mesh: original bounding-box drawImage approach
          ctx.beginPath();
          let bboxX = 0;
          let bboxY = 0;
          let bboxW = 1;
          let bboxH = 1;
          if (layer.geometry.type === "Quad") {
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of points) {
              if (p.x < minX) minX = p.x;
              if (p.y < minY) minY = p.y;
              if (p.x > maxX) maxX = p.x;
              if (p.y > maxY) maxY = p.y;
            }
            bboxX = minX;
            bboxY = minY;
            bboxW = Math.max(1, maxX - minX);
            bboxH = Math.max(1, maxY - minY);
          } else if (layer.geometry.type === "Triangle") {
            ctx.moveTo(points[0].x, points[0].y);
            ctx.lineTo(points[1].x, points[1].y);
            ctx.lineTo(points[2].x, points[2].y);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of points) {
              if (p.x < minX) minX = p.x;
              if (p.y < minY) minY = p.y;
              if (p.x > maxX) maxX = p.x;
              if (p.y > maxY) maxY = p.y;
            }
            bboxX = minX;
            bboxY = minY;
            bboxW = Math.max(1, maxX - minX);
            bboxH = Math.max(1, maxY - minY);
          } else if (layer.geometry.type === "Circle") {
            const center = points[0];
            const rx = layer.geometry.data.radius_x * canvasSize.w;
            const ry = layer.geometry.data.radius_y * canvasSize.h;
            const rotation = layer.geometry.data.rotation;
            ctx.ellipse(center.x, center.y, rx, ry, rotation, 0, TWO_PI);
            const ext = ellipseHalfExtents(rx, ry, rotation);
            bboxX = center.x - ext.hw;
            bboxY = center.y - ext.hh;
            bboxW = Math.max(1, ext.hw * 2);
            bboxH = Math.max(1, ext.hh * 2);
          }
          ctx.closePath();
          ctx.clip();
          drawImageWithInputTransform(
            ctx,
            tmpC,
            {
              x: Math.round(bboxX),
              y: Math.round(bboxY),
              w: Math.round(bboxW),
              h: Math.round(bboxH),
            },
            inputTransform
          );
        }

        ctx.restore();
      } else {
        // No source — use default fill
        ctx.fillStyle = isSelected ? SELECTED_FILL : LAYER_FILL;
      }

      // --- Draw face selection highlights (selected mesh layer in UV mode) ---
      if (isInputFaceMode && isSelected && layer.geometry.type === "Mesh") {
        const { cols, rows } = layer.geometry.data;

        // Hovered face
        if (hoveredFaceIndex !== null) {
          const r = Math.floor(hoveredFaceIndex / cols);
          const c = hoveredFaceIndex % cols;
          if (r < rows && c < cols) {
            const tl = points[r * (cols + 1) + c];
            const tr = points[r * (cols + 1) + c + 1];
            const br = points[(r + 1) * (cols + 1) + c + 1];
            const bl = points[(r + 1) * (cols + 1) + c];
            ctx.beginPath();
            ctx.moveTo(tl.x, tl.y);
            ctx.lineTo(tr.x, tr.y);
            ctx.lineTo(br.x, br.y);
            ctx.lineTo(bl.x, bl.y);
            ctx.closePath();
            ctx.fillStyle = "rgba(251,191,36,0.15)";
            ctx.fill();
          }
        }

        // Selected faces
        for (const faceIdx of selectedFaceIndices) {
          const r = Math.floor(faceIdx / cols);
          const c = faceIdx % cols;
          if (r >= rows || c >= cols) continue;
          const tl = points[r * (cols + 1) + c];
          const tr = points[r * (cols + 1) + c + 1];
          const br = points[(r + 1) * (cols + 1) + c + 1];
          const bl = points[(r + 1) * (cols + 1) + c];
          ctx.beginPath();
          ctx.moveTo(tl.x, tl.y);
          ctx.lineTo(tr.x, tr.y);
          ctx.lineTo(br.x, br.y);
          ctx.lineTo(bl.x, bl.y);
          ctx.closePath();
          ctx.fillStyle = "rgba(251,191,36,0.25)";
          ctx.fill();
          ctx.strokeStyle = "rgba(251,191,36,0.6)";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.strokeStyle = isSelected ? SELECTED_STROKE : LAYER_STROKE;
          ctx.lineWidth = isSelected ? 2 : 1;
        }
      }

      // --- Draw shape outline (always on top) ---
      if (layer.geometry.type === "Quad") {
        const pts = points;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.closePath();
        if (!frame) ctx.fill();
        ctx.stroke();
      } else if (layer.geometry.type === "Circle") {
        const center = points[0];
        const rx = layer.geometry.data.radius_x * canvasSize.w;
        const ry = layer.geometry.data.radius_y * canvasSize.h;
        const rotation = layer.geometry.data.rotation;
        ctx.beginPath();
        ctx.ellipse(center.x, center.y, rx, ry, rotation, 0, TWO_PI);
        if (!frame) ctx.fill();
        ctx.strokeStyle = isSelected ? "#fbbf24" : "#d97706";
        ctx.stroke();
      } else if (layer.geometry.type === "Triangle") {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.lineTo(points[2].x, points[2].y);
        ctx.closePath();
        if (!frame) ctx.fill();
        ctx.stroke();
      } else if (layer.geometry.type === "Mesh") {
        const { cols, rows } = layer.geometry.data;
        // Batched wireframe: 2 stroke() calls instead of ~(rows+cols+2)
        ctx.beginPath();
        for (let r = 0; r <= rows; r++) {
          const i0 = r * (cols + 1);
          ctx.moveTo(points[i0].x, points[i0].y);
          for (let c = 1; c <= cols; c++) ctx.lineTo(points[i0 + c].x, points[i0 + c].y);
        }
        for (let c = 0; c <= cols; c++) {
          ctx.moveTo(points[c].x, points[c].y);
          for (let r = 1; r <= rows; r++) ctx.lineTo(points[r * (cols + 1) + c].x, points[r * (cols + 1) + c].y);
        }
        ctx.stroke();
      }

      // Draw control points
      if (isShapePointMode && (isSelected || hoveredPoint?.layerId === layer.id)) {
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const isHovered = hoveredPoint?.layerId === layer.id && hoveredPoint.index === i;
          const isDragging = dragState?.layerId === layer.id && dragState.pointIndex === i;

          ctx.beginPath();
          ctx.arc(
            p.x, p.y,
            isDragging || isHovered ? POINT_RADIUS + 2 : POINT_RADIUS,
            0, Math.PI * 2
          );
          ctx.fillStyle = isDragging || isHovered ? POINT_SELECTED_COLOR : POINT_COLOR;
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
  }, [
    layers,
    selectedLayerId,
    selectedFaceIndices,
    isInputFaceMode,
    isShapePointMode,
    hoveredFaceIndex,
    canvasSize,
    toCanvas,
    hoveredPoint,
    dragState,
    frameTickState,
  ]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <div className="absolute top-3 left-3 z-10 pointer-events-auto flex flex-col gap-2">
        <button
          type="button"
          disabled={!selectedLayer}
          onClick={handleModeChipToggle}
          className={`px-2 py-1 rounded-md text-[11px] font-semibold tracking-wide border transition ${
            isInputFaceMode
              ? "bg-amber-500/20 border-amber-400/40 text-amber-200"
            : isInputMode
                ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200"
              : "bg-indigo-500/20 border-indigo-400/40 text-indigo-200"
          } ${selectedLayer ? "hover:brightness-125" : "opacity-70 cursor-not-allowed"}`}
          title={
            !selectedLayer
              ? "Select a layer to edit mode"
              : meshSelected
                ? "Toggle Shape/UV mode (Tab)"
                : "Toggle Shape/Input mode (Tab)"
          }
        >
          {isInputFaceMode ? "UV Edit (Tab)" : isInputMode ? "Input Edit (Tab)" : "Shape Edit (Tab)"}
        </button>
        {isShapeMode && (
          <div className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/45 p-1">
            <button
              type="button"
              onClick={() => setShapeEditTool("points")}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition ${
                isShapePointMode
                  ? "bg-indigo-500/30 border border-indigo-400/40 text-indigo-200"
                  : "text-white/70 hover:text-white"
              }`}
              title="Edit shape points"
            >
              Points
            </button>
            <button
              type="button"
              onClick={() => setShapeEditTool("drag")}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition ${
                isShapeDragMode
                  ? "bg-emerald-500/30 border border-emerald-400/40 text-emerald-200"
                  : "text-white/70 hover:text-white"
              }`}
              title="Drag whole shape"
            >
              Drag
            </button>
            <button
              type="button"
              onClick={() => setShapeEditTool("rotate")}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition ${
                isShapeRotateMode
                  ? "bg-rose-500/30 border border-rose-400/40 text-rose-200"
                  : "text-white/70 hover:text-white"
              }`}
              title="Rotate whole shape"
            >
              Rotate
            </button>
          </div>
        )}
        {isUvMode && (
          <div className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/45 p-1">
            {meshSelected && (
              <button
                type="button"
                onClick={() => setInputEditTool("faces")}
                className={`px-2 py-1 rounded text-[11px] font-semibold transition ${
                  isInputFaceMode
                    ? "bg-amber-500/30 border border-amber-400/40 text-amber-200"
                    : "text-white/70 hover:text-white"
                }`}
                title="Select mesh faces for UV edits"
              >
                Faces
              </button>
            )}
            <button
              type="button"
              onClick={() => setInputEditTool("drag")}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition ${
                isInputDragMode
                  ? "bg-cyan-500/30 border border-cyan-400/40 text-cyan-200"
                  : "text-white/70 hover:text-white"
              }`}
              title="Drag to pan input"
            >
              Drag
            </button>
            <button
              type="button"
              onClick={() => setInputEditTool("rotate")}
              className={`px-2 py-1 rounded text-[11px] font-semibold transition ${
                isInputRotateMode
                  ? "bg-cyan-500/30 border border-cyan-400/40 text-cyan-200"
                  : "text-white/70 hover:text-white"
              }`}
              title="Drag to rotate input"
            >
              Rotate
            </button>
          </div>
        )}
        {isShapeDragMode && (
          <div className="pointer-events-none px-2 py-1 rounded-md text-[11px] border bg-black/45 border-white/20 text-white/80">
            Drag inside the layer to move shape
          </div>
        )}
        {isShapeRotateMode && (
          <div className="pointer-events-none px-2 py-1 rounded-md text-[11px] border bg-black/45 border-white/20 text-white/80">
            Drag around the layer to rotate shape
          </div>
        )}
        {isInputFaceMode && selectedFaceIndices.length === 0 && (
          <div className="pointer-events-none px-2 py-1 rounded-md text-[11px] border bg-black/45 border-white/20 text-white/80">
            Click mesh faces to edit UV
          </div>
        )}
        {isInputDragMode && (
          <div className="pointer-events-none px-2 py-1 rounded-md text-[11px] border bg-black/45 border-white/20 text-white/80">
            Drag inside the layer to pan input
          </div>
        )}
        {isInputRotateMode && (
          <div className="pointer-events-none px-2 py-1 rounded-md text-[11px] border bg-black/45 border-white/20 text-white/80">
            Drag around the layer to rotate input
          </div>
        )}
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: canvasSize.w, height: canvasSize.h }}
        className={
          isShapeDragMode
            ? (shapeTransformActive ? "cursor-grabbing" : "cursor-grab")
            : isShapeRotateMode
              ? (shapeTransformActive ? "cursor-grabbing" : "cursor-crosshair")
            : isInputDragMode
              ? (inputDragState ? "cursor-grabbing" : "cursor-grab")
              : isInputRotateMode
                ? (inputRotateState ? "cursor-grabbing" : "cursor-crosshair")
            : isInputFaceMode
              ? "cursor-pointer"
              : "cursor-crosshair"
        }
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  );
}

export default EditorCanvas;

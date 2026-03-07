import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useAppStore } from "../../store/useAppStore";
import { tauriInvoke } from "../../lib/tauri-bridge";
import type {
  Point2D,
  Layer,
  LayerGeometry,
  FrameSnapshot,
  PreviewDelta,
  BlendMode,
  InputTransform,
  UvAdjustment,
  EditorSelectionMode,
} from "../../types";
import { DEFAULT_INPUT_TRANSFORM } from "../../types";
import type { PerfStats } from "../../store/useAppStore";
import { hashPoints, drawTriangleTextured } from "../../lib/math";
import { fitAspectViewport, resolveAspectRatioUiState } from "../../lib/aspect-ratios";
import { CoordinateHUD } from "./CoordinateHUD";

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
  layerIds: string[];
  mode: "drag" | "rotate";
  lastMouse: { x: number; y: number };
  center: { x: number; y: number };
  lastAngle: number;
}

interface AlignmentGuide {
  axis: "h" | "v";
  position: number; // normalized 0-1
}

/** Extract all control points from a layer geometry (normalized 0-1) */
function getLayerGeometryPoints(geom: LayerGeometry): Point2D[] {
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
}

/** Find horizontal/vertical alignment guides when a point aligns with other layers' points */
function findAlignmentGuides(
  dragPoints: Point2D[],
  currentLayerIds: string[],
  layers: Layer[],
  threshold: number = 0.02
): AlignmentGuide[] {
  const guides: AlignmentGuide[] = [];
  const skipIds = new Set(currentLayerIds);
  for (const layer of layers) {
    if (skipIds.has(layer.id) || layer.locked || !layer.visible) continue;
    const points = getLayerGeometryPoints(layer.geometry);
    for (const pt of points) {
      for (const dragPt of dragPoints) {
        if (Math.abs(pt.x - dragPt.x) < threshold) {
          guides.push({ axis: "v", position: pt.x });
        }
        if (Math.abs(pt.y - dragPt.y) < threshold) {
          guides.push({ axis: "h", position: pt.y });
        }
      }
    }
  }
  // Deduplicate
  const seen = new Set<string>();
  return guides.filter((g) => {
    const key = `${g.axis}-${g.position.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Offscreen warp cache per layer */
interface WarpCache {
  canvas: HTMLCanvasElement;
  geoHash: number;
  frameGen: number;
}

/** Derive circle display params from a 1x1 mesh that was converted from a circle.
 *  The mesh points are [TL, TR, BL, BR] in row-major order.
 *  Returns center (normalized), rx, ry, and rotation in radians. */
function meshToCircleParams(points: { x: number; y: number }[]): {
  center: { x: number; y: number };
  radius_x: number;
  radius_y: number;
  rotation: number;
} {
  if (points.length < 4) {
    return { center: { x: 0.5, y: 0.5 }, radius_x: 0.3, radius_y: 0.3, rotation: 0 };
  }
  // TL=0, TR=1, BL=2, BR=3
  const tl = points[0], tr = points[1], bl = points[2];
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
  // Width from top edge, height from left edge
  const rx = Math.sqrt((tr.x - tl.x) ** 2 + (tr.y - tl.y) ** 2) / 2;
  const ry = Math.sqrt((bl.x - tl.x) ** 2 + (bl.y - tl.y) ** 2) / 2;
  const rotation = Math.atan2(tr.y - tl.y, tr.x - tl.x);
  return { center: { x: cx, y: cy }, radius_x: Math.max(0.0001, rx), radius_y: Math.max(0.0001, ry), rotation };
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
  const [hudData, setHudData] = useState<{ x: number; y: number; cursorX: number; cursorY: number; mode: "point" | "layer-delta"; visible: boolean }>({ x: 0, y: 0, cursorX: 0, cursorY: 0, mode: "point", visible: false });

  const {
    project,
    layers, selectedLayerId, selectedLayerIds, selectedFaceIndices,
    setLayerSelection, toggleLayerSelection, clearLayerSelection,
    setSelectedFaces, toggleFaceSelection, clearFaceSelection,
    updateLayerPoint, applyGeometryTransformDelta,
    beginInteraction, setEditorPerf, snapEnabled, editorSelectionMode,
    setLayerInputTransform, toggleEditorSelectionMode,
    performanceProfile,
    selectedPointIndex, selectPoint, clearPointSelection,
  } = useAppStore();
  const editorPreviewIntervalMs = performanceProfile === "max_fps" ? 66 : 100;
  const effectiveSelectedIds = selectedLayerIds.length > 0
    ? selectedLayerIds
    : selectedLayerId
      ? [selectedLayerId]
      : [];
  const selectedIdSet = useMemo(
    () => new Set(effectiveSelectedIds),
    [effectiveSelectedIds]
  );

  const outputWidth = project?.output.width ?? canvasSize.w;
  const outputHeight = project?.output.height ?? canvasSize.h;
  const aspectState = useMemo(
    () =>
      project
        ? resolveAspectRatioUiState(project.uiState, project.output)
        : { lockEnabled: false, ratioId: "16:9" as const },
    [project]
  );
  const viewRect = useMemo(
    () =>
      fitAspectViewport(
        canvasSize.w,
        canvasSize.h,
        outputWidth,
        outputHeight,
        aspectState.lockEnabled
      ),
    [canvasSize.w, canvasSize.h, outputWidth, outputHeight, aspectState.lockEnabled]
  );

  const selectedLayer = selectedLayerId
    ? layers.find((l) => l.id === selectedLayerId) ?? null
    : null;
  const singleLayerSelected = !!selectedLayer && effectiveSelectedIds.length === 1;
  const meshSelected = selectedLayer?.geometry.type === "Mesh";
  const selectionMode: EditorSelectionMode =
    singleLayerSelected
      ? editorSelectionMode
      : "shape";
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
    if (!singleLayerSelected) return;
    toggleEditorSelectionMode();
  }, [singleLayerSelected, toggleEditorSelectionMode]);

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
  const shapeDragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Geometry delta queue for shape drag/rotate
  const geometryPendingRef = useRef<{
    layerIds: string[];
    dx: number;
    dy: number;
    dRotation: number;
  } | null>(null);
  const geometryInFlightRef = useRef(false);
  const geometryRafRef = useRef<number | null>(null);
  const deltaFallbackWarnedRef = useRef(false);
  const activeGuidesRef = useRef<AlignmentGuide[]>([]);
  const previewCursorRef = useRef(0);

  // Poll source frames at ~15fps for editor preview (delta transport + consumer gating)
  useEffect(() => {
    let running = true;
    let fpsFrames = 0;
    let fpsLastTime = performance.now();
    let lastPollMs = 0;
    let lastDecodeMs = 0;
    let lastFrameCount = 0;
    let lastTotalBytes = 0;

    // Register as a consumer immediately on mount (not deferred into poll())
    void tauriInvoke<void>("set_preview_consumers", { editor: true }).catch(() => undefined);

    const poll = async () => {
      while (running) {
        const t0 = performance.now();
        try {
          const cache = frameCache.current;
          let tPoll = 0;
          let bytes = 0;
          let changed = false;
          let frameCount = 0;

          try {
            const delta = await tauriInvoke<PreviewDelta>(
              "poll_all_frames_delta",
              { cursor: previewCursorRef.current }
            );
            tPoll = performance.now();
            if (!running) break;

            previewCursorRef.current = delta.cursor ?? previewCursorRef.current;

            if (delta.removed_layer_ids?.length) {
              for (const layerId of delta.removed_layer_ids) {
                cache.delete(layerId);
                tmpCanvasMap.current.delete(layerId);
                lastFrameGenMap.current.delete(layerId);
                warpCacheMap.current.delete(layerId);
              }
              changed = true;
            }

            const entries = Object.entries(delta.changed ?? {});
            frameCount = entries.length;
            if (entries.length > 0) {
              const decoded = await Promise.all(
                entries.map(async ([, snapshot]) => decodeBase64Fast(snapshot.data_b64))
              );
              for (let i = 0; i < entries.length; i++) {
                const [layerId, snapshot] = entries[i];
                const arr = decoded[i];
                bytes += arr.length;
                cache.set(layerId, new ImageData(arr, snapshot.width, snapshot.height));
              }
              changed = true;
            }
          } catch (deltaError) {
            if (!deltaFallbackWarnedRef.current) {
              deltaFallbackWarnedRef.current = true;
              console.warn(
                "[Preview] poll_all_frames_delta failed; falling back to poll_all_frames",
                deltaError
              );
            }

            const frames = await tauriInvoke<Record<string, FrameSnapshot>>("poll_all_frames");
            tPoll = performance.now();
            if (!running) break;

            const entries = Object.entries(frames ?? {});
            frameCount = entries.length;
            const nextLayerIdSet = new Set(entries.map(([layerId]) => layerId));
            const staleLayerIds = [...cache.keys()].filter((layerId) => !nextLayerIdSet.has(layerId));
            if (staleLayerIds.length > 0) {
              for (const layerId of staleLayerIds) {
                cache.delete(layerId);
                tmpCanvasMap.current.delete(layerId);
                lastFrameGenMap.current.delete(layerId);
                warpCacheMap.current.delete(layerId);
              }
              changed = true;
            }

            if (entries.length > 0) {
              const decoded = await Promise.all(
                entries.map(async ([, snapshot]) => decodeBase64Fast(snapshot.data_b64))
              );
              for (let i = 0; i < entries.length; i++) {
                const [layerId, snapshot] = entries[i];
                const arr = decoded[i];
                bytes += arr.length;
                cache.set(layerId, new ImageData(arr, snapshot.width, snapshot.height));
              }
              changed = true;
            }
          }

          const tDecode = performance.now();
          lastPollMs = tPoll - t0;
          lastDecodeMs = tDecode - tPoll;
          lastFrameCount = frameCount;
          lastTotalBytes = bytes;

          if (changed) {
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

        await new Promise((r) => setTimeout(r, editorPreviewIntervalMs));
      }
    };

    poll();
    return () => {
      running = false;
      frameCache.current.clear();
      tmpCanvasMap.current.clear();
      lastFrameGenMap.current.clear();
      warpCacheMap.current.clear();
      void tauriInvoke<void>("set_preview_consumers", { editor: false }).catch(
        () => undefined
      );
    };
  }, [setEditorPerf, editorPreviewIntervalMs]);

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
      x: viewRect.x + p.x * viewRect.w,
      y: viewRect.y + p.y * viewRect.h,
    }),
    [viewRect]
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
    void Promise.all(
      pending.layerIds.map((layerId) =>
        applyGeometryTransformDelta(layerId, {
          dx: pending.dx,
          dy: pending.dy,
          dRotation: pending.dRotation,
          sx: 1,
          sy: 1,
        })
      )
    ).finally(() => {
      geometryInFlightRef.current = false;
      if (geometryPendingRef.current) {
        flushGeometryDelta();
      }
    });
  }, [applyGeometryTransformDelta]);

  const enqueueGeometryDelta = useCallback(
    (
      layerIds: string[],
      delta: { dx?: number; dy?: number; dRotation?: number },
      immediate = false
    ) => {
      if (layerIds.length === 0) return;
      const dx = delta.dx ?? 0;
      const dy = delta.dy ?? 0;
      const dRotation = delta.dRotation ?? 0;
      if (Math.abs(dx) < TRANSFORM_EPS
        && Math.abs(dy) < TRANSFORM_EPS
        && Math.abs(dRotation) < TRANSFORM_EPS) {
        return;
      }

      const pending = geometryPendingRef.current;
      const sameSelection = pending
        && pending.layerIds.length === layerIds.length
        && pending.layerIds.every((id, idx) => id === layerIds[idx]);
      if (!pending || !sameSelection) {
        geometryPendingRef.current = { layerIds: [...layerIds], dx, dy, dRotation };
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
    if (layer.type === "circle") {
      const normalizedPts = getPoints(layer.geometry);
      const cp = meshToCircleParams(normalizedPts);
      const center = toCanvas(cp.center);
      const rx = Math.max(cp.radius_x * viewRect.w, 0.0001);
      const ry = Math.max(cp.radius_y * viewRect.h, 0.0001);
      const rot = cp.rotation;
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
    if (pts.length === 0) {
      return { x: viewRect.x + viewRect.w * 0.5, y: viewRect.y + viewRect.h * 0.5 };
    }
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / pts.length, y: sy / pts.length };
  };

  const getSelectionCenterCanvas = (layerIds: string[]): { x: number; y: number } => {
    const centers = layerIds
      .map((id) => layers.find((l) => l.id === id))
      .filter(Boolean)
      .map((layer) => getLayerCenterCanvas(layer!));
    if (centers.length === 0) {
      return { x: viewRect.x + viewRect.w * 0.5, y: viewRect.y + viewRect.h * 0.5 };
    }
    let sx = 0;
    let sy = 0;
    for (const c of centers) {
      sx += c.x;
      sy += c.y;
    }
    return { x: sx / centers.length, y: sy / centers.length };
  };

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const cmdOrCtrl = e.metaKey || e.ctrlKey;

    if (isShapePointMode) {
      const hit = hitTest(mx, my);
      if (hit) {
        setLayerSelection([hit.layerId], hit.layerId);
        selectPoint(hit.index);
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
        if (cmdOrCtrl) {
          toggleLayerSelection(hitLayerId);
          return;
        }
        const layer = layers.find((l) => l.id === hitLayerId);
        if (layer) {
          const activeIds = selectedIdSet.has(layer.id) && effectiveSelectedIds.length > 1
            ? [...effectiveSelectedIds]
            : [layer.id];
          if (activeIds.length === 1 && activeIds[0] !== selectedLayerId) {
            setLayerSelection(activeIds, layer.id);
          }
          beginInteraction();
          const center = isShapeRotateMode
            ? getSelectionCenterCanvas(activeIds)
            : getLayerCenterCanvas(layer);
          const startAngle = Math.atan2(my - center.y, mx - center.x);
          shapeTransformRef.current = {
            layerIds: activeIds,
            mode: isShapeDragMode ? "drag" : "rotate",
            lastMouse: { x: mx, y: my },
            center,
            lastAngle: startAngle,
          };
          shapeDragStartRef.current = { x: mx, y: my };
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
          setLayerSelection([layer.id], layer.id);
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

    // Click on empty area — deselect layer + clear faces + clear point
    clearPointSelection();
    clearLayerSelection();
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const shapeTransform = shapeTransformRef.current;
    if (shapeTransform) {
      if (!shapeTransform.layerIds.every((id) => layers.some((l) => l.id === id))) {
        finishShapeTransform();
        return;
      }
      if (shapeTransform.mode === "drag") {
        const dx = (mx - shapeTransform.lastMouse.x) / viewRect.w;
        const dy = (my - shapeTransform.lastMouse.y) / viewRect.h;
        shapeTransform.lastMouse = { x: mx, y: my };
        enqueueGeometryDelta(shapeTransform.layerIds, { dx, dy }, false);
        // Compute alignment guides from all points of dragged layers
        const draggedPts: Point2D[] = [];
        for (const lid of shapeTransform.layerIds) {
          const l = layers.find((la) => la.id === lid);
          if (l) draggedPts.push(...getLayerGeometryPoints(l.geometry));
        }
        activeGuidesRef.current = findAlignmentGuides(draggedPts, shapeTransform.layerIds, layers);
        const containerRect = containerRef.current?.getBoundingClientRect();
        if (containerRect) {
          const pxDx = mx - shapeDragStartRef.current.x;
          const pxDy = my - shapeDragStartRef.current.y;
          setHudData({ x: pxDx, y: pxDy, cursorX: e.clientX - containerRect.left, cursorY: e.clientY - containerRect.top, mode: "layer-delta", visible: true });
        }
      } else {
        const nextAngle = Math.atan2(my - shapeTransform.center.y, mx - shapeTransform.center.x);
        const dRotation = normalizeAngleDelta(nextAngle - shapeTransform.lastAngle);
        shapeTransform.lastAngle = nextAngle;
        enqueueGeometryDelta(shapeTransform.layerIds, { dRotation }, false);
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

      const dx = (mx - inputDragState.startMouse.x) / viewRect.w;
      const dy = (my - inputDragState.startMouse.y) / viewRect.h;
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

      const dx = (mx - dragState.startMouse.x) / viewRect.w;
      const dy = (my - dragState.startMouse.y) / viewRect.h;

      let nx = Math.max(0, Math.min(1, dragState.startPoint.x + dx));
      let ny = Math.max(0, Math.min(1, dragState.startPoint.y + dy));

      if (snapEnabled) {
        const SNAP_GRID = 0.05;
        nx = Math.round(nx / SNAP_GRID) * SNAP_GRID;
        ny = Math.round(ny / SNAP_GRID) * SNAP_GRID;
      }

      const newPt: Point2D = { x: nx, y: ny };
      activeGuidesRef.current = findAlignmentGuides([newPt], [dragState.layerId], layers);
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (containerRect) {
        setHudData({ x: nx, y: ny, cursorX: e.clientX - containerRect.left, cursorY: e.clientY - containerRect.top, mode: "point", visible: true });
      }
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
    activeGuidesRef.current = [];
    setHudData(prev => ({ ...prev, visible: false }));
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
      // Escape: clear point selection
      if (e.key === "Escape" && selectedPointIndex !== null) {
        e.preventDefault();
        clearPointSelection();
        return;
      }

      // Escape: clear face selection
      if (e.key === "Escape" && selectedFaceIndices.length > 0) {
        e.preventDefault();
        clearFaceSelection();
        return;
      }

      if (effectiveSelectedIds.length === 0) return;
      const targetIds = effectiveSelectedIds.filter((id) => {
        const layer = layers.find((l) => l.id === id);
        return !!layer && !layer.locked;
      });
      if (targetIds.length === 0) return;

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

      if (selectedPointIndex !== null && selectedLayerId) {
        // Nudge single selected point
        const layer = layers.find((l) => l.id === selectedLayerId);
        if (layer && !layer.locked) {
          const pts = getPoints(layer.geometry);
          if (selectedPointIndex < pts.length) {
            const pt = pts[selectedPointIndex];
            const newPt: Point2D = {
              x: Math.max(0, Math.min(1, pt.x + dx)),
              y: Math.max(0, Math.min(1, pt.y + dy)),
            };
            void updateLayerPoint(selectedLayerId, selectedPointIndex, newPt);
          }
        }
      } else {
        // Nudge whole layer(s)
        for (const id of targetIds) {
          void applyGeometryTransformDelta(id, {
            dx,
            dy,
            dRotation: 0,
            sx: 1,
            sy: 1,
          });
        }
      }
    },
    [
      effectiveSelectedIds,
      selectedFaceIndices,
      selectedPointIndex,
      selectedLayerId,
      layers,
      applyGeometryTransformDelta,
      updateLayerPoint,
      beginInteraction,
      clearFaceSelection,
      clearPointSelection,
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

    // Clear + letterbox bars
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvasSize.w, canvasSize.h);
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(viewRect.x, viewRect.y, viewRect.w, viewRect.h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(viewRect.x, viewRect.y, viewRect.w, viewRect.h);
    ctx.clip();

    // Draw grid — batched into 2 stroke() calls instead of ~116
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    const gridStep = 50;
    ctx.beginPath();
    const viewRight = viewRect.x + viewRect.w;
    const viewBottom = viewRect.y + viewRect.h;
    for (let x = viewRect.x; x <= viewRight; x += gridStep) {
      ctx.moveTo(x, viewRect.y);
      ctx.lineTo(x, viewBottom);
    }
    for (let y = viewRect.y; y <= viewBottom; y += gridStep) {
      ctx.moveTo(viewRect.x, y);
      ctx.lineTo(viewRight, y);
    }
    ctx.stroke();

    // Draw layers (bottom to top)
    const sorted = [...layers]
      .filter((l) => l.visible)
      .sort((a, b) => a.zIndex - b.zIndex);

    const currentFrameTick = frameTick.current;

    for (const layer of sorted) {
      const isSelected = selectedIdSet.has(layer.id);
      const isPrimary = layer.id === selectedLayerId;
      const points = getPoints(layer.geometry).map(toCanvas);
      const inputTransform = layer.input_transform ?? DEFAULT_INPUT_TRANSFORM;
      const frame = frameCache.current.get(layer.id);

      ctx.strokeStyle = isSelected
        ? (isPrimary ? SELECTED_STROKE : "#a5b4fc")
        : LAYER_STROKE;
      ctx.lineWidth = isSelected ? (isPrimary ? 2 : 1.5) : 1;

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
          const viewportHash =
            (((viewRect.x * 1e3) | 0) >>> 0)
            ^ (((viewRect.y * 1e3) | 0) >>> 0)
            ^ (((viewRect.w * 1e3) | 0) >>> 0)
            ^ (((viewRect.h * 1e3) | 0) >>> 0);
          const geoHash =
            hashPoints(rawPts)
            ^ uvHash
            ^ maskHash
            ^ inputHash
            ^ viewportHash
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

            const maskedSet = new Set(layer.geometry.data.masked_faces ?? []);

            // Offset all canvas-space points to warp-canvas-space once
            const offsetPts = points.map(p => ({ x: p.x - minX, y: p.y - minY }));

            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const faceIdx = r * cols + c;
                if (maskedSet.has(faceIdx)) continue;

                const tl = offsetPts[r * (cols + 1) + c];
                const tr = offsetPts[r * (cols + 1) + c + 1];
                const br = offsetPts[(r + 1) * (cols + 1) + c + 1];
                const bl = offsetPts[(r + 1) * (cols + 1) + c];

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

                // Check if cell is significantly distorted (needs subdivision for perspective accuracy)
                const edgeLengths = [
                  Math.hypot(tr.x - tl.x, tr.y - tl.y),  // top
                  Math.hypot(br.x - tr.x, br.y - tr.y),  // right
                  Math.hypot(bl.x - br.x, bl.y - br.y),  // bottom
                  Math.hypot(tl.x - bl.x, tl.y - bl.y),  // left
                ];
                const maxEdge = Math.max(...edgeLengths);
                const minEdge = Math.min(...edgeLengths);
                const distortionRatio = minEdge > 0 ? maxEdge / minEdge : 1;

                if (distortionRatio >= 1.3) {
                  // Helpers (defined inline; stable references via closure)
                  function bilinearPt(
                    p00: {x:number;y:number}, p10: {x:number;y:number},
                    p01: {x:number;y:number}, p11: {x:number;y:number},
                    s: number, t: number
                  ): {x:number;y:number} {
                    return {
                      x: (1-s)*(1-t)*p00.x + s*(1-t)*p10.x + (1-s)*t*p01.x + s*t*p11.x,
                      y: (1-s)*(1-t)*p00.y + s*(1-t)*p10.y + (1-s)*t*p01.y + s*t*p11.y,
                    };
                  }

                  // Port of Rust compute_quad_q_weights: Heckbert diagonal-intersection.
                  // corners: TL, TR, BR, BL (screen space)
                  function computeQuadQWeights(
                    c0: {x:number;y:number}, c1: {x:number;y:number},
                    c2: {x:number;y:number}, c3: {x:number;y:number}
                  ): [number,number,number,number] {
                    const d02x = c2.x-c0.x, d02y = c2.y-c0.y;
                    const d13x = c3.x-c1.x, d13y = c3.y-c1.y;
                    const denom = d02x*d13y - d02y*d13x;
                    if (Math.abs(denom) < 1e-9) return [1,1,1,1];
                    const bx = c1.x-c0.x, by = c1.y-c0.y;
                    let tc = (bx*d13y - by*d13x) / denom;
                    let sc = (bx*d02y - by*d02x) / denom;
                    if (Math.abs(tc-0.5) < 0.02 && Math.abs(sc-0.5) < 0.02) return [1,1,1,1];
                    tc = Math.max(0.001, Math.min(0.999, tc));
                    sc = Math.max(0.001, Math.min(0.999, sc));
                    return [1/(1-tc), 1/(1-sc), 1/tc, 1/sc];
                  }

                  // Perspective-correct UV at bilinear parameter (s,t) using homogeneous interp.
                  // uvs: [TL,TR,BR,BL] pixel coords, q: [TL,TR,BR,BL] weights
                  function perspUvAt(
                    uvs: {x:number;y:number}[], q: [number,number,number,number],
                    s: number, t: number
                  ): {x:number;y:number} {
                    const w00=(1-s)*(1-t), w10=s*(1-t), w11=s*t, w01=(1-s)*t;
                    const hx = w00*uvs[0].x*q[0] + w10*uvs[1].x*q[1] + w11*uvs[2].x*q[2] + w01*uvs[3].x*q[3];
                    const hy = w00*uvs[0].y*q[0] + w10*uvs[1].y*q[1] + w11*uvs[2].y*q[2] + w01*uvs[3].y*q[3];
                    const hw = w00*q[0] + w10*q[1] + w11*q[2] + w01*q[3];
                    return hw > 1e-9 ? { x: hx/hw, y: hy/hw } : uvs[0];
                  }

                  // finalUvs order: [TL=0, TR=1, BR=2, BL=3]
                  const cellQ = computeQuadQWeights(tl, tr, br, bl);

                  // More subdivisions for highly distorted quads
                  const subdivN = distortionRatio > 4 ? 4 : 2;

                  // Build (subdivN+1)×(subdivN+1) grid
                  // Screen positions: bilinear (screen space is affine-safe)
                  // UV positions: perspective-correct homogeneous interpolation
                  const subPts: {x:number;y:number}[][] = [];
                  const subUvs: {x:number;y:number}[][] = [];
                  for (let ti = 0; ti <= subdivN; ti++) {
                    const t = ti / subdivN;
                    subPts.push([]);
                    subUvs.push([]);
                    for (let si = 0; si <= subdivN; si++) {
                      const s = si / subdivN;
                      subPts[ti].push(bilinearPt(tl, tr, bl, br, s, t));
                      subUvs[ti].push(perspUvAt(finalUvs, cellQ, s, t));
                    }
                  }

                  // Draw subdivN² sub-quads as 2*subdivN² triangles
                  for (let sti = 0; sti < subdivN; sti++) {
                    for (let ssi = 0; ssi < subdivN; ssi++) {
                      const stl = subPts[sti][ssi];
                      const str_ = subPts[sti][ssi+1];
                      const sbr = subPts[sti+1][ssi+1];
                      const sbl = subPts[sti+1][ssi];
                      const utl = subUvs[sti][ssi];
                      const utr = subUvs[sti][ssi+1];
                      const ubr = subUvs[sti+1][ssi+1];
                      const ubl = subUvs[sti+1][ssi];
                      wCtx.save();
                      drawTriangleTextured(wCtx, tmpC, [utl, utr, ubr], [stl, str_, sbr]);
                      wCtx.restore();
                      wCtx.save();
                      drawTriangleTextured(wCtx, tmpC, [utl, ubr, ubl], [stl, sbr, sbl]);
                      wCtx.restore();
                    }
                  }
                } else {
                  // Normal 2-triangle draw
                  wCtx.save();
                  drawTriangleTextured(
                    wCtx, tmpC,
                    [finalUvs[0], finalUvs[1], finalUvs[2]],
                    [tl, tr, br]
                  );
                  wCtx.restore();

                  wCtx.save();
                  drawTriangleTextured(
                    wCtx, tmpC,
                    [finalUvs[0], finalUvs[2], finalUvs[3]],
                    [tl, br, bl]
                  );
                  wCtx.restore();
                }
              }
            }

            warp.geoHash = geoHash;
            warp.frameGen = currentFrameTick;

            // Draw masked faces (dark overlay) — on top of warped content
            if (maskedSet.size > 0) {
              wCtx.save();
              wCtx.fillStyle = "rgba(0,0,0,0.75)";
              for (const faceIdx of maskedSet) {
                const r = Math.floor(faceIdx / cols);
                const c = faceIdx % cols;
                const tl = offsetPts[r * (cols + 1) + c];
                const tr = offsetPts[r * (cols + 1) + c + 1];
                const br = offsetPts[(r + 1) * (cols + 1) + c + 1];
                const bl = offsetPts[(r + 1) * (cols + 1) + c];
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
          // Non-mesh (Triangle only after mesh unification):
          // bounding-box clip + drawImage approach
          ctx.beginPath();
          let bboxX = 0;
          let bboxY = 0;
          let bboxW = 1;
          let bboxH = 1;
          if (layer.geometry.type === "Triangle") {
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
      if (isInputFaceMode && isPrimary && layer.geometry.type === "Mesh") {
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
      } else if (layer.type === "circle") {
        // Circle layers are stored as 1x1 Mesh — derive display params from corners
        const normalizedPts = getPoints(layer.geometry);
        const cp = meshToCircleParams(normalizedPts);
        const center = toCanvas(cp.center);
        const rx = cp.radius_x * viewRect.w;
        const ry = cp.radius_y * viewRect.h;
        const rotation = cp.rotation;
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
      if (isShapePointMode && (isPrimary || hoveredPoint?.layerId === layer.id)) {
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const isHovered = hoveredPoint?.layerId === layer.id && hoveredPoint.index === i;
          const isDragging = dragState?.layerId === layer.id && dragState.pointIndex === i;
          const isSelected = i === selectedPointIndex && layer.id === selectedLayerId;

          if (isSelected) {
            // Selected point: indigo ring + white fill + glow
            ctx.save();
            ctx.shadowColor = "rgba(129, 140, 248, 0.5)";
            ctx.shadowBlur = 6;

            // Outer indigo ring
            ctx.beginPath();
            ctx.arc(p.x, p.y, POINT_RADIUS + 3, 0, Math.PI * 2);
            ctx.strokeStyle = "#818cf8";
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // White filled circle
            ctx.beginPath();
            ctx.arc(p.x, p.y, POINT_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = "#ffffff";
            ctx.fill();

            ctx.restore();
          } else {
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
    }

    // Draw alignment guides (thin dashed cyan lines)
    const guides = activeGuidesRef.current;
    if (guides.length > 0) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(34, 211, 238, 0.5)";
      ctx.lineWidth = 1;
      for (const guide of guides) {
        ctx.beginPath();
        if (guide.axis === "v") {
          const x = viewRect.x + guide.position * viewRect.w;
          ctx.moveTo(x, viewRect.y);
          ctx.lineTo(x, viewRect.y + viewRect.h);
        } else {
          const y = viewRect.y + guide.position * viewRect.h;
          ctx.moveTo(viewRect.x, y);
          ctx.lineTo(viewRect.x + viewRect.w, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();
  }, [
    layers,
    selectedLayerId,
    effectiveSelectedIds,
    selectedFaceIndices,
    isInputFaceMode,
    isShapePointMode,
    hoveredFaceIndex,
    canvasSize,
    toCanvas,
    hoveredPoint,
    dragState,
    frameTickState,
    selectedPointIndex,
  ]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <div className="absolute top-3 left-3 z-10 pointer-events-auto flex flex-col gap-2">
        <button
          type="button"
          disabled={!singleLayerSelected}
          onClick={handleModeChipToggle}
          className={`px-2 py-1 rounded-md text-[11px] font-semibold tracking-wide border transition ${
            isInputFaceMode
              ? "bg-amber-500/20 border-amber-400/40 text-amber-200"
            : isInputMode
                ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200"
              : "bg-indigo-500/20 border-indigo-400/40 text-indigo-200"
          } ${singleLayerSelected ? "hover:brightness-125" : "opacity-70 cursor-not-allowed"}`}
          title={
            !singleLayerSelected
              ? "Select exactly one layer to edit mode"
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
      <CoordinateHUD {...hudData} />
    </div>
  );
}

export default EditorCanvas;

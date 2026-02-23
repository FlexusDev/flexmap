import { useRef, useEffect, useState, useCallback } from "react";
import { useAppStore } from "../../store/useAppStore";
import { tauriInvoke } from "../../lib/tauri-bridge";
import type { Point2D, LayerGeometry, FrameSnapshot, BlendMode } from "../../types";
import type { PerfStats } from "../../store/useAppStore";

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

interface DragState {
  layerId: string;
  pointIndex: number;
  startMouse: { x: number; y: number };
  startPoint: Point2D;
}

function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{
    layerId: string;
    index: number;
  } | null>(null);

  const { layers, selectedLayerId, selectLayer, updateGeometry, beginInteraction, setEditorPerf, snapEnabled } =
    useAppStore();
  // Track whether we've already pushed undo for the current arrow-nudge burst
  const nudgeUndoPushed = useRef(false);
  // Cached source frame ImageData per layer
  const frameCache = useRef<Map<string, ImageData>>(new Map());
  // Per-layer offscreen canvases (one each to prevent cross-contamination)
  const tmpCanvasMap = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const [frameTick, setFrameTick] = useState(0);

  // Poll source frames at ~15fps for editor preview (non-overlapping)
  useEffect(() => {
    let running = true;
    // FPS / perf tracking
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
          // IPC poll
          const frames = await tauriInvoke<Record<string, FrameSnapshot>>(
            "poll_all_frames"
          );
          const tPoll = performance.now();
          if (!running) break;

          if (frames && Object.keys(frames).length > 0) {
            const cache = frameCache.current;
            let bytes = 0;
            const entries = Object.entries(frames);
            // Decode all frames in parallel using the fast path
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

            setFrameTick((t) => t + 1);
          }
        } catch {
          // ignore
        }

        // Update perf stats every second
        const frametime = performance.now() - t0;
        fpsFrames++;
        const elapsed = performance.now() - fpsLastTime;
        if (elapsed >= 1000) {
          const stats: PerfStats = {
            fps: Math.round((fpsFrames / elapsed) * 1000),
            frametime: Math.round(frametime * 10) / 10,
            pollMs: Math.round(lastPollMs * 10) / 10,
            decodeMs: Math.round(lastDecodeMs * 10) / 10,
            drawMs: 0, // filled by draw effect if needed
            frameCount: lastFrameCount,
            totalBytes: lastTotalBytes,
          };
          setEditorPerf(stats);
          fpsFrames = 0;
          fpsLastTime = performance.now();
        }

        await new Promise((r) => setTimeout(r, 33)); // ~30fps target
      }
    };

    poll();
    return () => { running = false; };
  }, [setEditorPerf]);

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
        return [geom.data.center, ...geom.data.bounds];
    }
  };

  // Update a single point in geometry
  const setPoint = (
    geom: LayerGeometry,
    index: number,
    newPt: Point2D
  ): LayerGeometry => {
    switch (geom.type) {
      case "Quad": {
        const corners = [...geom.data.corners] as [
          Point2D,
          Point2D,
          Point2D,
          Point2D
        ];
        corners[index] = newPt;
        return { type: "Quad", data: { corners } };
      }
      case "Triangle": {
        const vertices = [...geom.data.vertices] as [
          Point2D,
          Point2D,
          Point2D
        ];
        vertices[index] = newPt;
        return { type: "Triangle", data: { vertices } };
      }
      case "Mesh": {
        const points = [...geom.data.points];
        points[index] = newPt;
        return {
          type: "Mesh",
          data: { cols: geom.data.cols, rows: geom.data.rows, points },
        };
      }
      case "Circle": {
        if (index === 0) {
          return {
            type: "Circle",
            data: { ...geom.data, center: newPt },
          };
        } else {
          const bounds = [...geom.data.bounds] as [
            Point2D,
            Point2D,
            Point2D,
            Point2D
          ];
          bounds[index - 1] = newPt;
          return {
            type: "Circle",
            data: { ...geom.data, bounds },
          };
        }
      }
    }
  };

  // Find point under cursor
  const hitTest = (
    mx: number,
    my: number
  ): { layerId: string; index: number } | null => {
    // Test selected layer first for priority
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

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const hit = hitTest(mx, my);
    if (hit) {
      selectLayer(hit.layerId);
      const layer = layers.find((l) => l.id === hit.layerId);
      if (layer) {
        // Snapshot undo ONCE at drag start
        beginInteraction();
        const points = getPoints(layer.geometry);
        setDragState({
          layerId: hit.layerId,
          pointIndex: hit.index,
          startMouse: { x: mx, y: my },
          startPoint: points[hit.index],
        });
      }
    } else {
      // Click on empty space — check if we clicked inside a shape
      // For now, deselect
      selectLayer(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (dragState) {
      const layer = layers.find((l) => l.id === dragState.layerId);
      if (!layer) return;

      const dx = (mx - dragState.startMouse.x) / canvasSize.w;
      const dy = (my - dragState.startMouse.y) / canvasSize.h;

      let nx = Math.max(0, Math.min(1, dragState.startPoint.x + dx));
      let ny = Math.max(0, Math.min(1, dragState.startPoint.y + dy));

      // Snap to grid (0.05 = 20 divisions)
      if (snapEnabled) {
        const SNAP_GRID = 0.05;
        nx = Math.round(nx / SNAP_GRID) * SNAP_GRID;
        ny = Math.round(ny / SNAP_GRID) * SNAP_GRID;
      }

      const newPt: Point2D = { x: nx, y: ny };

      const newGeom = setPoint(layer.geometry, dragState.pointIndex, newPt);
      updateGeometry(layer.id, newGeom);
    } else {
      // Update hover state
      const hit = hitTest(mx, my);
      setHoveredPoint(hit);
    }
  };

  const handleMouseUp = () => {
    setDragState(null);
  };

  // Keyboard handler for nudging
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!selectedLayerId) return;
      const layer = layers.find((l) => l.id === selectedLayerId);
      if (!layer || layer.locked) return;

      const amount = e.shiftKey ? FINE_NUDGE : NUDGE_AMOUNT;
      let dx = 0,
        dy = 0;

      switch (e.key) {
        case "ArrowLeft":
          dx = -amount;
          break;
        case "ArrowRight":
          dx = amount;
          break;
        case "ArrowUp":
          dy = -amount;
          break;
        case "ArrowDown":
          dy = amount;
          break;
        default:
          return;
      }

      e.preventDefault();

      // Snapshot undo once at the start of an arrow-nudge burst
      if (!nudgeUndoPushed.current) {
        nudgeUndoPushed.current = true;
        beginInteraction();
      }

      // Move all points of the selected layer
      const points = getPoints(layer.geometry);
      let newGeom = layer.geometry;
      for (let i = 0; i < points.length; i++) {
        const newPt: Point2D = {
          x: Math.max(0, Math.min(1, points[i].x + dx)),
          y: Math.max(0, Math.min(1, points[i].y + dy)),
        };
        newGeom = setPoint(newGeom, i, newPt);
      }
      updateGeometry(layer.id, newGeom);
    },
    [selectedLayerId, layers, updateGeometry, beginInteraction]
  );

  // Reset nudge undo flag when arrow keys are released
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
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.w * dpr;
    canvas.height = canvasSize.h * dpr;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvasSize.w, canvasSize.h);

    // Draw grid
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 0.5;
    const gridStep = 50;
    for (let x = 0; x <= canvasSize.w; x += gridStep) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasSize.h);
      ctx.stroke();
    }
    for (let y = 0; y <= canvasSize.h; y += gridStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvasSize.w, y);
      ctx.stroke();
    }

    // Draw layers (bottom to top)
    const sorted = [...layers]
      .filter((l) => l.visible)
      .sort((a, b) => a.zIndex - b.zIndex);

    for (const layer of sorted) {
      const isSelected = layer.id === selectedLayerId;
      const points = getPoints(layer.geometry).map(toCanvas);
      const frame = frameCache.current.get(layer.id);

      ctx.strokeStyle = isSelected ? SELECTED_STROKE : LAYER_STROKE;
      ctx.lineWidth = isSelected ? 2 : 1;

      // --- Paint source frame (or fallback fill) inside the shape ---
      if (frame) {
        // Get or create a dedicated offscreen canvas for this layer
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
        tmpCtx.putImageData(frame, 0, 0);

        ctx.save();
        ctx.globalAlpha = layer.properties.opacity;
        ctx.globalCompositeOperation = blendModeToComposite(layer.blend_mode);

        // Clip to shape
        ctx.beginPath();
        if (layer.geometry.type === "Quad") {
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        } else if (layer.geometry.type === "Triangle") {
          ctx.moveTo(points[0].x, points[0].y);
          ctx.lineTo(points[1].x, points[1].y);
          ctx.lineTo(points[2].x, points[2].y);
        } else if (layer.geometry.type === "Circle") {
          const center = points[0];
          const r = (layer.geometry.data as { radius: number }).radius * Math.min(canvasSize.w, canvasSize.h);
          ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
        } else if (layer.geometry.type === "Mesh") {
          // Outer boundary
          const { cols, rows: meshRows } = layer.geometry.data;
          for (let c = 0; c <= cols; c++) ctx.lineTo(points[c].x, points[c].y);
          for (let r = 1; r <= meshRows; r++) ctx.lineTo(points[r * (cols + 1) + cols].x, points[r * (cols + 1) + cols].y);
          for (let c = cols - 1; c >= 0; c--) ctx.lineTo(points[meshRows * (cols + 1) + c].x, points[meshRows * (cols + 1) + c].y);
          for (let r = meshRows - 1; r >= 0; r--) ctx.lineTo(points[r * (cols + 1)].x, points[r * (cols + 1)].y);
        }
        ctx.closePath();
        ctx.clip();

        // Draw frame stretched to bounding box
        const allX = points.map((p) => p.x);
        const allY = points.map((p) => p.y);
        const minX = Math.min(...allX);
        const minY = Math.min(...allY);
        const maxX = Math.max(...allX);
        const maxY = Math.max(...allY);
        ctx.drawImage(tmpC, minX, minY, maxX - minX, maxY - minY);

        ctx.restore();
      } else {
        // No source — use default fill
        ctx.fillStyle = isSelected ? SELECTED_FILL : LAYER_FILL;
      }

      // --- Draw shape outline (always on top) ---
      if (
        layer.geometry.type === "Quad" ||
        layer.geometry.type === "Circle"
      ) {
        const pts =
          layer.geometry.type === "Quad"
            ? points
            : points.slice(1);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.closePath();
        if (!frame) ctx.fill();
        ctx.stroke();

        if (layer.geometry.type === "Circle") {
          const center = points[0];
          const r =
            (layer.geometry.data as { radius: number }).radius *
            Math.min(canvasSize.w, canvasSize.h);
          ctx.beginPath();
          ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
          ctx.strokeStyle = isSelected ? "#fbbf24" : "#d97706";
          ctx.stroke();
        }
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
        for (let r = 0; r <= rows; r++) {
          ctx.beginPath();
          for (let c = 0; c <= cols; c++) {
            const idx = r * (cols + 1) + c;
            const p = points[idx];
            if (c === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }
        for (let c = 0; c <= cols; c++) {
          ctx.beginPath();
          for (let r = 0; r <= rows; r++) {
            const idx = r * (cols + 1) + c;
            const p = points[idx];
            if (r === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }
      }

      // Draw control points
      if (isSelected || hoveredPoint?.layerId === layer.id) {
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const isHovered =
            hoveredPoint?.layerId === layer.id && hoveredPoint.index === i;
          const isDragging =
            dragState?.layerId === layer.id && dragState.pointIndex === i;

          ctx.beginPath();
          ctx.arc(
            p.x,
            p.y,
            isDragging || isHovered ? POINT_RADIUS + 2 : POINT_RADIUS,
            0,
            Math.PI * 2
          );
          ctx.fillStyle =
            isDragging || isHovered ? POINT_SELECTED_COLOR : POINT_COLOR;
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
    canvasSize,
    toCanvas,
    hoveredPoint,
    dragState,
    frameTick,
  ]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        style={{ width: canvasSize.w, height: canvasSize.h }}
        className="cursor-crosshair"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  );
}

export default EditorCanvas;

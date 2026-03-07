import NumericField from "../../controls/NumericField";
import type { EditorSelectionMode, Layer, Point2D } from "../../../types";

interface EditSectionProps {
  layer: Layer | null;
  mode: EditorSelectionMode;
  selectedPointIndex: number | null;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  // Shape mode, no point
  centerX: number;
  centerY: number;
  onCenterChange: (x: number, y: number) => void;
  onSubdivide: () => void;
  // Shape mode, point selected
  pointPosition: Point2D | null;
  pointCount: number;
  onPointChange: (pt: Point2D) => void;
  // UV/Input mode
  inputTransform: {
    offsetX: number;
    offsetY: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
  };
  onInputTransformChange: (key: string, value: number) => void;
  onInputTransformReset: () => void;
  // Per-face UV (mesh + faces selected)
  facesSelected: number;
  faceUv: {
    offsetX: number;
    offsetY: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
  } | null;
  onFaceUvChange: (key: string, value: number) => void;
  onFaceUvReset: () => void;
  // Undo
  onSliderDown: () => void;
  onSliderUp: () => void;
}

function geometryLabel(layer: Layer): string {
  const g = layer.geometry;
  switch (g.type) {
    case "Quad":
      return "Quad (4 pts)";
    case "Triangle":
      return "Triangle (3 pts)";
    case "Circle":
      return "Circle";
    case "Mesh":
      return `Mesh ${g.data.cols}\u00D7${g.data.rows} (${g.data.points.length} pts)`;
  }
}

export default function EditSection({
  layer,
  mode,
  selectedPointIndex,
  snapEnabled,
  onToggleSnap,
  centerX,
  centerY,
  onCenterChange,
  onSubdivide,
  pointPosition,
  pointCount,
  onPointChange,
  inputTransform,
  onInputTransformChange,
  onInputTransformReset,
  facesSelected,
  faceUv,
  onFaceUvChange,
  onFaceUvReset,
  onSliderDown,
  onSliderUp,
}: EditSectionProps) {
  if (!layer) return null;

  // View 1: UV/Input mode
  if (mode === "uv") {
    return (
      <div className="px-2 py-2 space-y-1.5">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
          Input Transform
        </span>
        <div className="grid grid-cols-2 gap-1">
          <NumericField
            label="X"
            value={inputTransform.offsetX}
            min={-1}
            max={1}
            step={0.001}
            decimals={3}
            onChange={(v) => onInputTransformChange("offsetX", v)}
            onPointerDown={onSliderDown}
            onPointerUp={onSliderUp}
          />
          <NumericField
            label="Y"
            value={inputTransform.offsetY}
            min={-1}
            max={1}
            step={0.001}
            decimals={3}
            onChange={(v) => onInputTransformChange("offsetY", v)}
            onPointerDown={onSliderDown}
            onPointerUp={onSliderUp}
          />
          <NumericField
            label="R"
            value={inputTransform.rotation}
            min={-180}
            max={180}
            step={1}
            decimals={0}
            suffix={"\u00B0"}
            onChange={(v) => onInputTransformChange("rotation", v)}
            onPointerDown={onSliderDown}
            onPointerUp={onSliderUp}
          />
          <NumericField
            label="S"
            value={inputTransform.scaleX}
            min={0.1}
            max={3}
            step={0.01}
            onChange={(v) => onInputTransformChange("scaleX", v)}
            onPointerDown={onSliderDown}
            onPointerUp={onSliderUp}
          />
        </div>
        <button
          type="button"
          className="text-[10px] text-zinc-500 hover:text-zinc-300"
          onClick={onInputTransformReset}
        >
          Reset
        </button>

        {facesSelected > 0 && faceUv && (
          <>
            <div className="border-t border-zinc-700/50" />
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
              {facesSelected} Face{facesSelected !== 1 ? "s" : ""} UV
            </span>
            <div className="grid grid-cols-2 gap-1">
              <NumericField
                label="X"
                value={faceUv.offsetX}
                min={-1}
                max={1}
                step={0.001}
                decimals={3}
                onChange={(v) => onFaceUvChange("offsetX", v)}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="Y"
                value={faceUv.offsetY}
                min={-1}
                max={1}
                step={0.001}
                decimals={3}
                onChange={(v) => onFaceUvChange("offsetY", v)}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="R"
                value={faceUv.rotation}
                min={-180}
                max={180}
                step={1}
                decimals={0}
                suffix={"\u00B0"}
                onChange={(v) => onFaceUvChange("rotation", v)}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="S"
                value={faceUv.scaleX}
                min={0.1}
                max={3}
                step={0.01}
                onChange={(v) => onFaceUvChange("scaleX", v)}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
            </div>
            <button
              type="button"
              className="text-[10px] text-zinc-500 hover:text-zinc-300"
              onClick={onFaceUvReset}
            >
              Reset
            </button>
          </>
        )}
      </div>
    );
  }

  // View 2: Shape mode, point selected
  if (
    mode === "shape" &&
    selectedPointIndex !== null &&
    pointPosition
  ) {
    return (
      <div className="px-2 py-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
            Point {selectedPointIndex + 1} of {pointCount}
          </span>
          <button
            type="button"
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              snapEnabled
                ? "bg-cyan-500/20 text-cyan-300"
                : "bg-zinc-800 text-zinc-500"
            }`}
            onClick={onToggleSnap}
          >
            Snap
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <NumericField
            label="X"
            value={pointPosition.x}
            min={0}
            max={1}
            step={0.001}
            decimals={3}
            onChange={(v) => onPointChange({ x: v, y: pointPosition.y })}
            onPointerDown={onSliderDown}
            onPointerUp={onSliderUp}
          />
          <NumericField
            label="Y"
            value={pointPosition.y}
            min={0}
            max={1}
            step={0.001}
            decimals={3}
            onChange={(v) => onPointChange({ x: pointPosition.x, y: v })}
            onPointerDown={onSliderDown}
            onPointerUp={onSliderUp}
          />
        </div>
      </div>
    );
  }

  // View 3: Shape mode, no point (default)
  const isMesh = layer.geometry.type === "Mesh";

  return (
    <div className="px-2 py-2 space-y-1.5">
      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
        {geometryLabel(layer)}
      </span>
      <div className="grid grid-cols-2 gap-1">
        <NumericField
          label="X"
          value={centerX}
          min={0}
          max={4000}
          step={1}
          decimals={0}
          suffix="px"
          onChange={(v) => onCenterChange(v, centerY)}
          onPointerDown={onSliderDown}
          onPointerUp={onSliderUp}
        />
        <NumericField
          label="Y"
          value={centerY}
          min={0}
          max={4000}
          step={1}
          decimals={0}
          suffix="px"
          onChange={(v) => onCenterChange(centerX, v)}
          onPointerDown={onSliderDown}
          onPointerUp={onSliderUp}
        />
      </div>
      {isMesh && (
        <button
          type="button"
          className="text-[11px] bg-zinc-800 text-zinc-300 hover:bg-zinc-700 px-2 py-1 rounded w-full"
          onClick={onSubdivide}
        >
          Subdivide
        </button>
      )}
    </div>
  );
}

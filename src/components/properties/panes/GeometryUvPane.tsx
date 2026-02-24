import type { UvAdjustment } from "../../../types";

interface GeometryUvPaneProps {
  geometrySummaryLines: string[];
  isMesh: boolean;
  meshDims: { cols: number; rows: number } | null;
  canSubdivide: boolean;
  onSubdivide: () => void;
  isUvMode: boolean;
  facesSelected: boolean;
  selectedFaceIndices: number[];
  currentUV: UvAdjustment;
  uvRotDeg: number;
  onUVReset: () => void;
  onUVChange: (adjustment: UvAdjustment) => void;
  onBeginInteraction: () => void;
}

function GeometryUvPane({
  geometrySummaryLines,
  isMesh,
  meshDims,
  canSubdivide,
  onSubdivide,
  isUvMode,
  facesSelected,
  selectedFaceIndices,
  currentUV,
  uvRotDeg,
  onUVReset,
  onUVChange,
  onBeginInteraction,
}: GeometryUvPaneProps) {
  return (
    <div className="space-y-4">
      <div>
        <span className="text-xs text-aura-text-dim">Geometry</span>
        <div className="mt-1 text-xs font-mono text-aura-text-dim space-y-1">
          {geometrySummaryLines.map((line, index) => (
            <div key={`${line}-${index}`}>{line}</div>
          ))}
        </div>
      </div>

      {canSubdivide && meshDims && (
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-aura-text-dim">Subdivide</span>
            <span className="text-xs font-mono text-aura-text-dim">
              {meshDims.cols}×{meshDims.rows} → {meshDims.cols * 2}×{meshDims.rows * 2}
            </span>
          </div>
          <button
            type="button"
            onClick={onSubdivide}
            className="btn text-xs mt-2 w-full py-1"
          >
            Subdivide Mesh
          </button>
        </div>
      )}

      {!isMesh && (
        <div className="rounded-md border border-aura-border/60 bg-aura-hover/20 px-2 py-2 text-xs text-aura-text-dim">
          UV controls are available for mesh layers only.
        </div>
      )}

      {isMesh && !isUvMode && (
        <div className="rounded-md border border-aura-border/60 bg-aura-hover/20 px-2 py-2 text-xs text-aura-text-dim">
          Switch to UV mode in Assignment to edit per-face UV transforms.
        </div>
      )}

      {isMesh && isUvMode && !facesSelected && (
        <div className="rounded-md border border-aura-border/60 bg-aura-hover/20 px-2 py-2 text-xs text-aura-text-dim">
          Click one or more mesh faces in the canvas to edit UV.
        </div>
      )}

      {isMesh && isUvMode && facesSelected && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
              Face UV
              {selectedFaceIndices.length > 1 && (
                <span className="ml-1 normal-case font-normal text-aura-text-dim">
                  ({selectedFaceIndices.length} faces)
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={onUVReset}
              className="text-xs text-aura-text-dim hover:text-aura-text"
              title="Reset UV to default"
            >
              ↺ Reset
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Offset X</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {currentUV.offset[0].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={currentUV.offset[0]}
                onMouseDown={onBeginInteraction}
                onChange={(e) => onUVChange({
                  ...currentUV,
                  offset: [parseFloat(e.target.value), currentUV.offset[1]],
                })}
                className="slider"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Offset Y</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {currentUV.offset[1].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={currentUV.offset[1]}
                onMouseDown={onBeginInteraction}
                onChange={(e) => onUVChange({
                  ...currentUV,
                  offset: [currentUV.offset[0], parseFloat(e.target.value)],
                })}
                className="slider"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Rotation</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {uvRotDeg.toFixed(0)}°
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={uvRotDeg}
                onMouseDown={onBeginInteraction}
                onChange={(e) => onUVChange({
                  ...currentUV,
                  rotation: (parseFloat(e.target.value) / 360) * Math.PI * 2,
                })}
                className="slider"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Scale X</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {currentUV.scale[0].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.01}
                value={currentUV.scale[0]}
                onMouseDown={onBeginInteraction}
                onChange={(e) => onUVChange({
                  ...currentUV,
                  scale: [parseFloat(e.target.value), currentUV.scale[1]],
                })}
                className="slider"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Scale Y</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {currentUV.scale[1].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.01}
                value={currentUV.scale[1]}
                onMouseDown={onBeginInteraction}
                onChange={(e) => onUVChange({
                  ...currentUV,
                  scale: [currentUV.scale[0], parseFloat(e.target.value)],
                })}
                className="slider"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default GeometryUvPane;

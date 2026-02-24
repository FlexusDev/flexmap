import type { BlendMode, EditorSelectionMode, SourceInfo } from "../../../types";
import { BLEND_MODES } from "../../../types";

interface AssignmentPaneProps {
  sharedSourceId: string;
  sourceMixed: boolean;
  sources: SourceInfo[];
  hasMissingSource: boolean;
  onSourceChange: (sourceId: string) => void;
  sharedBlend: string;
  blendMixed: boolean;
  onBlendChange: (blendMode: BlendMode) => void;
  selectionMode: EditorSelectionMode;
  isMulti: boolean;
  isMesh: boolean;
  secondaryModeLabel: string;
  onSelectionModeChange: (mode: EditorSelectionMode) => void;
}

function AssignmentPane({
  sharedSourceId,
  sourceMixed,
  sources,
  hasMissingSource,
  onSourceChange,
  sharedBlend,
  blendMixed,
  onBlendChange,
  selectionMode,
  isMulti,
  isMesh,
  secondaryModeLabel,
  onSelectionModeChange,
}: AssignmentPaneProps) {
  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-aura-text-dim block mb-1">Source</label>
        <select
          value={sharedSourceId}
          onChange={(e) => onSourceChange(e.target.value)}
          className="input w-full text-xs"
        >
          {sourceMixed && <option value="__mixed__" disabled>Mixed</option>}
          <option value="">None</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              [{source.protocol}] {source.name}
              {source.width && source.height ? ` (${source.width}x${source.height})` : ""}
            </option>
          ))}
        </select>
        {hasMissingSource && (
          <div className="mt-1 text-xs text-aura-warning">
            One or more selected layers reference missing sources
          </div>
        )}
      </div>

      <div>
        <label className="text-xs text-aura-text-dim block mb-1">Blend Mode</label>
        <select
          value={sharedBlend}
          onChange={(e) => onBlendChange(e.target.value as BlendMode)}
          className="input w-full text-xs"
        >
          {blendMixed && <option value="__mixed__" disabled>Mixed</option>}
          {BLEND_MODES.map((bm) => (
            <option key={bm.value} value={bm.value}>
              {bm.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
            Selection Mode
          </span>
          <span className="text-[11px] text-aura-text-dim">Tab</span>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => onSelectionModeChange("shape")}
            className={`btn text-xs py-1 ${
              selectionMode === "shape"
                ? "bg-indigo-600 text-white"
                : "bg-aura-hover text-aura-text-dim"
            }`}
          >
            Shape
          </button>
          <button
            type="button"
            onClick={() => onSelectionModeChange("uv")}
            disabled={isMulti}
            className={`btn text-xs py-1 ${
              selectionMode === "uv"
                ? (isMesh ? "bg-amber-600 text-white" : "bg-cyan-600 text-white")
                : "bg-aura-hover text-aura-text-dim"
            } ${isMulti ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            {secondaryModeLabel}
          </button>
        </div>
        <div className="mt-2 text-[11px] text-aura-text-dim">
          {isMulti
            ? "Multi-selection: Shape mode only"
            : selectionMode === "shape"
            ? "Point/shape controls active"
            : isMesh
              ? "Face selection and UV controls active"
              : "Input pan mode active (drag layer in preview)"}
        </div>
      </div>
    </div>
  );
}

export default AssignmentPane;

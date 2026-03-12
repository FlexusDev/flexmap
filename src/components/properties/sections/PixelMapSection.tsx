import NumericField from "../../controls/NumericField";
import Slider from "../../controls/Slider";
import type { PixelMapEffect, PixelMapPattern, PatternCoordMode } from "../../../types";
import { PIXEL_MAP_PATTERNS, DEFAULT_PIXEL_MAP_EFFECT } from "../../../types";

interface PixelMapSectionProps {
  pixelMap: PixelMapEffect | null;
  onPixelMapChange: (pm: PixelMapEffect | null) => void;
  onSliderDown: () => void;
  onSliderUp: () => void;
}

export default function PixelMapSection({
  pixelMap,
  onPixelMapChange,
  onSliderDown,
  onSliderUp,
}: PixelMapSectionProps) {
  const enabled = pixelMap?.enabled ?? false;

  const handleToggleEnabled = () => {
    if (!pixelMap) {
      // First enable: create from defaults
      onPixelMapChange({ ...DEFAULT_PIXEL_MAP_EFFECT });
    } else {
      onPixelMapChange({ ...pixelMap, enabled: !pixelMap.enabled });
    }
  };

  const update = (patch: Partial<PixelMapEffect>) => {
    if (!pixelMap) return;
    onPixelMapChange({ ...pixelMap, ...patch });
  };

  const handlePatternChange = (pattern: PixelMapPattern) => {
    update({ pattern });
  };

  const handleCoordMode = (mode: PatternCoordMode) => {
    update({ coordMode: mode });
  };

  const handleReset = () => {
    onPixelMapChange({ ...DEFAULT_PIXEL_MAP_EFFECT });
  };

  return (
    <div className="px-2 py-2 space-y-2">
      {/* Section header with enable toggle */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
          Pixel Mapping
        </span>
        <button
          type="button"
          onClick={handleToggleEnabled}
          className={`relative w-7 h-4 rounded-full transition-colors ${
            enabled ? "bg-indigo-600" : "bg-zinc-700"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-3" : ""
            }`}
          />
        </button>
      </div>

      {enabled && pixelMap && (
        <div className="space-y-2">
          {/* Pattern pills */}
          <div>
            <span className="block text-[10px] text-zinc-500 mb-1">Pattern</span>
            <div className="grid grid-cols-3 gap-1">
              {PIXEL_MAP_PATTERNS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => handlePatternChange(p.value)}
                  className={`text-[10px] py-1 rounded transition-colors ${
                    pixelMap.pattern === p.value
                      ? "bg-indigo-600 text-white"
                      : "bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Coord mode toggle */}
          <div>
            <span className="block text-[10px] text-zinc-500 mb-0.5">Coord Mode</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => handleCoordMode("perShape")}
                className={`flex-1 text-[11px] py-0.5 rounded ${
                  pixelMap.coordMode === "perShape"
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-500"
                }`}
              >
                Shape
              </button>
              <button
                type="button"
                onClick={() => handleCoordMode("worldSpace")}
                className={`flex-1 text-[11px] py-0.5 rounded ${
                  pixelMap.coordMode === "worldSpace"
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-500"
                }`}
              >
                World
              </button>
            </div>
          </div>

          {/* Parameter controls */}
          <div className="space-y-1">
            <Slider
              label="Speed"
              value={pixelMap.speed}
              min={0.1}
              max={10}
              step={0.1}
              decimals={1}
              onChange={(v) => update({ speed: v })}
              onPointerDown={onSliderDown}
              onPointerUp={onSliderUp}
            />
            <Slider
              label="Width"
              value={pixelMap.width}
              min={0.01}
              max={1}
              step={0.01}
              onChange={(v) => update({ width: v })}
              onPointerDown={onSliderDown}
              onPointerUp={onSliderUp}
            />
            <Slider
              label="Intensity"
              value={pixelMap.intensity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => update({ intensity: v })}
              onPointerDown={onSliderDown}
              onPointerUp={onSliderUp}
            />
            <div className="grid grid-cols-2 gap-1">
              <NumericField
                label="Dir"
                value={pixelMap.direction}
                min={-180}
                max={180}
                step={1}
                decimals={0}
                suffix={"\u00B0"}
                onChange={(v) => update({ direction: v })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
            </div>
          </div>

          {/* Invert toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={pixelMap.invert}
              onChange={() => update({ invert: !pixelMap.invert })}
              className="accent-indigo-500"
            />
            <span className="text-[11px] text-zinc-300">Invert</span>
          </label>

          {/* Per-shape transform controls */}
          {pixelMap.coordMode === "perShape" && (
            <div>
              <span className="block text-[10px] text-zinc-500 mb-0.5">Transform</span>
              <div className="grid grid-cols-2 gap-1">
                <NumericField
                  label="OX"
                  value={pixelMap.offsetX}
                  min={-1}
                  max={1}
                  step={0.01}
                  decimals={2}
                  onChange={(v) => update({ offsetX: v })}
                  onPointerDown={onSliderDown}
                  onPointerUp={onSliderUp}
                />
                <NumericField
                  label="OY"
                  value={pixelMap.offsetY}
                  min={-1}
                  max={1}
                  step={0.01}
                  decimals={2}
                  onChange={(v) => update({ offsetY: v })}
                  onPointerDown={onSliderDown}
                  onPointerUp={onSliderUp}
                />
                <NumericField
                  label="SX"
                  value={pixelMap.scaleX}
                  min={0.1}
                  max={10}
                  step={0.01}
                  onChange={(v) => update({ scaleX: v })}
                  onPointerDown={onSliderDown}
                  onPointerUp={onSliderUp}
                />
                <NumericField
                  label="SY"
                  value={pixelMap.scaleY}
                  min={0.1}
                  max={10}
                  step={0.01}
                  onChange={(v) => update({ scaleY: v })}
                  onPointerDown={onSliderDown}
                  onPointerUp={onSliderUp}
                />
              </div>
            </div>
          )}

          {/* World box controls */}
          {pixelMap.coordMode === "worldSpace" && (
            <div>
              <span className="block text-[10px] text-zinc-500 mb-0.5">World Box</span>
              <div className="grid grid-cols-2 gap-1">
                <NumericField
                  label="X"
                  value={pixelMap.worldBox[0]}
                  min={-1}
                  max={2}
                  step={0.01}
                  decimals={2}
                  onChange={(v) =>
                    update({
                      worldBox: [v, pixelMap.worldBox[1], pixelMap.worldBox[2], pixelMap.worldBox[3]],
                    })
                  }
                  onPointerDown={onSliderDown}
                  onPointerUp={onSliderUp}
                />
                <NumericField
                  label="Y"
                  value={pixelMap.worldBox[1]}
                  min={-1}
                  max={2}
                  step={0.01}
                  decimals={2}
                  onChange={(v) =>
                    update({
                      worldBox: [pixelMap.worldBox[0], v, pixelMap.worldBox[2], pixelMap.worldBox[3]],
                    })
                  }
                  onPointerDown={onSliderDown}
                  onPointerUp={onSliderUp}
                />
                <NumericField
                  label="W"
                  value={pixelMap.worldBox[2]}
                  min={0.01}
                  max={4}
                  step={0.01}
                  decimals={2}
                  onChange={(v) =>
                    update({
                      worldBox: [pixelMap.worldBox[0], pixelMap.worldBox[1], v, pixelMap.worldBox[3]],
                    })
                  }
                  onPointerDown={onSliderDown}
                  onPointerUp={onSliderUp}
                />
                <NumericField
                  label="H"
                  value={pixelMap.worldBox[3]}
                  min={0.01}
                  max={4}
                  step={0.01}
                  decimals={2}
                  onChange={(v) =>
                    update({
                      worldBox: [pixelMap.worldBox[0], pixelMap.worldBox[1], pixelMap.worldBox[2], v],
                    })
                  }
                  onPointerDown={onSliderDown}
                  onPointerUp={onSliderUp}
                />
              </div>
            </div>
          )}

          {/* Reset button */}
          <button
            type="button"
            className="text-[10px] text-zinc-500 hover:text-zinc-300"
            onClick={handleReset}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

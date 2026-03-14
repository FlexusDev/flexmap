import Slider from "../../controls/Slider";
import type { DimmerCurve, DimmerEffect } from "../../../types";
import { DEFAULT_DIMMER_EFFECT, DIMMER_CURVES } from "../../../types";
import { evaluateDimmerCurve, isDutyCurve } from "../../../lib/dimmer-fx";

interface DimmerFxSectionProps {
  title: string;
  dimmerFx: DimmerEffect | null;
  groupMode?: boolean;
  overrideNote?: string | null;
  onDimmerFxChange: (effect: DimmerEffect | null) => void;
  onSliderDown: () => void;
  onSliderUp: () => void;
}

function curvePath(curve: DimmerCurve, dutyCycle: number): string {
  const samples = 24;
  const points: string[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const phase = index / samples;
    const sample = evaluateDimmerCurve(curve, phase, dutyCycle);
    const x = 4 + phase * 40;
    const y = 20 - sample * 16;
    points.push(`${x},${y}`);
  }
  return points.join(" ");
}

export default function DimmerFxSection({
  title,
  dimmerFx,
  groupMode = false,
  overrideNote,
  onDimmerFxChange,
  onSliderDown,
  onSliderUp,
}: DimmerFxSectionProps) {
  const enabled = dimmerFx?.enabled ?? false;

  const update = (patch: Partial<DimmerEffect>) => {
    if (!dimmerFx) return;
    onDimmerFxChange({ ...dimmerFx, ...patch });
  };

  const handleToggleEnabled = () => {
    if (!dimmerFx) {
      onDimmerFxChange({ ...DEFAULT_DIMMER_EFFECT });
      return;
    }
    onDimmerFxChange({ ...dimmerFx, enabled: !dimmerFx.enabled });
  };

  const handleReset = () => {
    onDimmerFxChange({ ...DEFAULT_DIMMER_EFFECT });
  };

  return (
    <div className="px-2 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
          {title}
        </span>
        <div className="flex items-center gap-2">
          {enabled && (
            <button
              type="button"
              onClick={handleReset}
              className="text-[10px] text-zinc-500 hover:text-zinc-200"
            >
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={handleToggleEnabled}
            className={`relative w-7 h-4 rounded-full transition-colors ${
              enabled ? "bg-amber-500" : "bg-zinc-700"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                enabled ? "translate-x-3" : ""
              }`}
            />
          </button>
        </div>
      </div>

      {overrideNote && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-100">
          {overrideNote}
        </div>
      )}

      {enabled && dimmerFx && (
        <div className="space-y-2">
          <div>
            <span className="block text-[10px] text-zinc-500 mb-1">Curve</span>
            <div className="grid grid-cols-3 gap-1">
              {DIMMER_CURVES.map((curve) => (
                <button
                  key={curve.value}
                  type="button"
                  onClick={() => update({ curve: curve.value })}
                  className={`rounded px-1 py-1 transition-colors ${
                    dimmerFx.curve === curve.value
                      ? "bg-amber-500 text-white"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                  }`}
                >
                  <svg
                    viewBox="0 0 48 24"
                    className="mx-auto mb-1 h-5 w-full"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points={curvePath(curve.value, dimmerFx.dutyCycle)} />
                  </svg>
                  <span className="block text-[9px]">{curve.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <Slider
              label="Depth"
              value={dimmerFx.depth}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => update({ depth: value })}
              onPointerDown={onSliderDown}
              onPointerUp={onSliderUp}
            />
            <Slider
              label="Speed"
              value={dimmerFx.speed}
              min={0.1}
              max={8}
              step={0.1}
              decimals={1}
              onChange={(value) => update({ speed: value })}
              onPointerDown={onSliderDown}
              onPointerUp={onSliderUp}
            />
            <Slider
              label="Phase"
              value={dimmerFx.phaseOffset}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => update({ phaseOffset: value })}
              onPointerDown={onSliderDown}
              onPointerUp={onSliderUp}
            />
            {isDutyCurve(dimmerFx.curve) && (
              <Slider
                label="Duty"
                value={dimmerFx.dutyCycle}
                min={0.05}
                max={0.95}
                step={0.01}
                onChange={(value) => update({ dutyCycle: value })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
            )}
            {groupMode && (
              <>
                <Slider
                  label="Spread"
                  value={dimmerFx.phaseSpread}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(value) => update({ phaseSpread: value })}
                  onPointerDown={onSliderDown}
                  onPointerUp={onSliderUp}
                />
                <div>
                  <span className="block text-[10px] text-zinc-500 mb-0.5">Direction</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => update({ phaseDirection: "forward" })}
                      className={`flex-1 text-[11px] py-0.5 rounded ${
                        dimmerFx.phaseDirection === "forward"
                          ? "bg-amber-500 text-white"
                          : "bg-zinc-800 text-zinc-500"
                      }`}
                    >
                      Forward
                    </button>
                    <button
                      type="button"
                      onClick={() => update({ phaseDirection: "reverse" })}
                      className={`flex-1 text-[11px] py-0.5 rounded ${
                        dimmerFx.phaseDirection === "reverse"
                          ? "bg-amber-500 text-white"
                          : "bg-zinc-800 text-zinc-500"
                      }`}
                    >
                      Reverse
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

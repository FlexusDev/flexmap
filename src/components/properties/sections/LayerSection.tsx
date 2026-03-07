import { useState } from "react";
import Slider from "../../controls/Slider";
import { BlendModePicker } from "../../controls/BlendModePicker";
import { SourcePicker } from "../../controls/SourcePicker";
import type { BlendMode } from "../../../types";

interface LayerSectionProps {
  // Source
  sourceId: string | null;
  sources: Array<{
    id: string;
    protocol: string;
    display_name: string;
    resolution?: { width: number; height: number } | null;
  }>;
  sourceMixed: boolean;
  onSourceChange: (id: string) => void;
  // Blend
  blendMode: BlendMode | null;
  blendMixed: boolean;
  onBlendChange: (mode: BlendMode) => void;
  // Opacity
  opacity: number;
  opacityMixed: boolean;
  onOpacityChange: (v: number) => void;
  // Visibility/Lock
  visible: boolean;
  locked: boolean;
  visibleMixed: boolean;
  lockedMixed: boolean;
  onToggleVisible: () => void;
  onToggleLock: () => void;
  // Advanced look
  brightness: number;
  contrast: number;
  gamma: number;
  feather: number;
  beatReactive: boolean;
  beatAmount: number;
  beatEligible: boolean;
  lookMixed: boolean;
  onLookChange: (key: string, value: number) => void;
  onBeatToggle: () => void;
  onBeatAmountChange: (v: number) => void;
  // Undo
  onSliderDown: () => void;
  onSliderUp: () => void;
  onLookReset: (key: string) => void;
}

const LOOK_SLIDERS = [
  { key: "brightness", label: "Brightness", min: 0, max: 2, step: 0.01 },
  { key: "contrast", label: "Contrast", min: 0, max: 2, step: 0.01 },
  { key: "gamma", label: "Gamma", min: 0.2, max: 3, step: 0.01 },
  { key: "feather", label: "Feather", min: 0, max: 1, step: 0.01 },
] as const;

export default function LayerSection({
  sourceId,
  sources,
  sourceMixed,
  onSourceChange,
  blendMode,
  blendMixed,
  onBlendChange,
  opacity,
  opacityMixed,
  onOpacityChange,
  visible,
  locked,
  visibleMixed,
  lockedMixed,
  onToggleVisible,
  onToggleLock,
  brightness,
  contrast,
  gamma,
  feather,
  beatReactive,
  beatAmount,
  beatEligible,
  lookMixed,
  onLookChange,
  onBeatToggle,
  onBeatAmountChange,
  onSliderDown,
  onSliderUp,
  onLookReset,
}: LayerSectionProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const lookValues: Record<string, number> = {
    brightness,
    contrast,
    gamma,
    feather,
  };

  return (
    <div className="px-2 py-2 space-y-2">
      {/* Source + Blend: 2-col grid */}
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <span className="block text-[10px] text-zinc-500 mb-0.5">Source</span>
          <SourcePicker
            value={sourceId}
            sources={sources}
            mixed={sourceMixed}
            onChange={onSourceChange}
          />
        </div>
        <div>
          <span className="block text-[10px] text-zinc-500 mb-0.5">Blend</span>
          <BlendModePicker
            value={blendMode}
            mixed={blendMixed}
            onChange={onBlendChange}
          />
        </div>
      </div>

      {/* Opacity slider */}
      <Slider
        label="Opacity"
        value={opacity}
        min={0}
        max={1}
        step={0.01}
        mixed={opacityMixed}
        onChange={onOpacityChange}
        onPointerDown={onSliderDown}
        onPointerUp={onSliderUp}
      />

      {/* Visibility + Lock toggles */}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onToggleVisible}
          className={`flex-1 text-[11px] py-0.5 rounded ${
            visibleMixed
              ? "bg-zinc-800 text-zinc-500"
              : visible
                ? "bg-zinc-700 text-zinc-200"
                : "bg-zinc-800 text-zinc-500"
          }`}
        >
          {visibleMixed ? "Mixed" : visible ? "Visible" : "Hidden"}
        </button>
        <button
          type="button"
          onClick={onToggleLock}
          className={`flex-1 text-[11px] py-0.5 rounded ${
            lockedMixed
              ? "bg-zinc-800 text-zinc-500"
              : locked
                ? "bg-amber-500/20 text-amber-300"
                : "bg-zinc-800 text-zinc-500"
          }`}
        >
          {lockedMixed ? "Mixed" : locked ? "Locked" : "Unlocked"}
        </button>
      </div>

      {/* Advanced Look accordion */}
      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          className="text-[10px] text-zinc-500 hover:text-zinc-400 flex items-center gap-1"
        >
          <span
            className="inline-block transition-transform"
            style={{ transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            &#9656;
          </span>
          Advanced Look
        </button>

        {advancedOpen && (
          <div className="mt-1.5 space-y-1">
            {LOOK_SLIDERS.map(({ key, label, min, max, step }) => (
              <Slider
                key={key}
                label={label}
                value={lookValues[key]}
                min={min}
                max={max}
                step={step}
                mixed={lookMixed}
                onChange={(v) => onLookChange(key, v)}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
                onReset={() => onLookReset(key)}
              />
            ))}

            {/* Beat reactivity */}
            {beatEligible && (
              <div className="pt-1 space-y-1">
                <button
                  type="button"
                  onClick={onBeatToggle}
                  className={`w-full text-[11px] py-0.5 rounded ${
                    beatReactive
                      ? "bg-emerald-600 text-white"
                      : "bg-zinc-800 text-zinc-500"
                  }`}
                >
                  Beat Reactive: {beatReactive ? "On" : "Off"}
                </button>
                {beatReactive && (
                  <Slider
                    label="Beat Amt"
                    value={beatAmount}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={onBeatAmountChange}
                    onPointerDown={onSliderDown}
                    onPointerUp={onSliderUp}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

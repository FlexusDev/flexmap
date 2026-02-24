import type { LayerProperties } from "../../../types";

export type LookNumericKey = "brightness" | "contrast" | "gamma" | "opacity" | "feather";

export type LookControl = {
  key: LookNumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
};

interface LookPaneProps {
  controls: LookControl[];
  properties: LayerProperties;
  mixedPropKeys: Set<LookNumericKey>;
  onPropChange: (key: LookNumericKey, value: number) => void;
  onPropReset: (key: LookNumericKey) => void;
  beatEligible: boolean;
  beatReactive: boolean;
  beatAmount: number;
  beatReactiveMixed: boolean;
  beatAmountMixed: boolean;
  onBeatReactiveChange: (value: boolean) => void;
  onBeatAmountChange: (value: number) => void;
}

function LookPane({
  controls,
  properties,
  mixedPropKeys,
  onPropChange,
  onPropReset,
  beatEligible,
  beatReactive,
  beatAmount,
  beatReactiveMixed,
  beatAmountMixed,
  onBeatReactiveChange,
  onBeatAmountChange,
}: LookPaneProps) {
  return (
    <div className="space-y-4">
      {controls.map(({ key, label, min, max, step }) => (
        <div key={key}>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">{label}</label>
            <div className="flex items-center gap-1">
              <span className="text-xs font-mono text-aura-text w-10 text-right">
                {mixedPropKeys.has(key) ? "Mixed" : properties[key].toFixed(2)}
              </span>
              <button
                type="button"
                onClick={() => onPropReset(key)}
                className="text-xs text-aura-text-dim hover:text-aura-text px-1"
                title="Reset to default"
              >
                ↺
              </button>
            </div>
          </div>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={properties[key]}
            onChange={(event) => onPropChange(key, parseFloat(event.target.value))}
            className="slider"
          />
        </div>
      ))}

      {beatEligible ? (
        <div className="pt-2 border-t border-aura-border/60 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-aura-text-dim">Beat Reactive</span>
            <button
              type="button"
              className={`px-2 py-1 rounded text-[11px] ${
                beatReactive
                  ? "bg-emerald-600 text-white"
                  : "bg-aura-hover text-aura-text-dim"
              }`}
              onClick={() => onBeatReactiveChange(!beatReactive)}
            >
              {beatReactiveMixed ? "Mixed" : beatReactive ? "On" : "Off"}
            </button>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-aura-text-dim">Beat Amount</span>
              <span className="text-xs font-mono text-aura-text">
                {beatAmountMixed ? "Mixed" : beatAmount.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={beatAmount}
              onChange={(event) => onBeatAmountChange(parseFloat(event.target.value))}
              className="slider"
            />
          </div>
        </div>
      ) : (
        <div className="pt-2 border-t border-aura-border/60 text-[11px] text-aura-text-dim">
          Beat controls are available for shader-backed sources.
        </div>
      )}
    </div>
  );
}

export default LookPane;

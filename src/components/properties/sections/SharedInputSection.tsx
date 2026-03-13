import NumericField from "../../controls/NumericField";
import type { SharedInputMapping } from "../../../types";

interface SharedInputSectionProps {
  sharedInput: SharedInputMapping | null;
  defaultMapping: SharedInputMapping;
  hasMixedSources: boolean;
  onSharedInputChange: (mapping: SharedInputMapping | null) => void;
  onSliderDown: () => void;
  onSliderUp: () => void;
}

export default function SharedInputSection({
  sharedInput,
  defaultMapping,
  hasMixedSources,
  onSharedInputChange,
  onSliderDown,
  onSliderUp,
}: SharedInputSectionProps) {
  const enabled = sharedInput?.enabled ?? false;

  const update = (patch: Partial<SharedInputMapping>) => {
    if (!sharedInput) return;
    onSharedInputChange({ ...sharedInput, ...patch });
  };

  const handleToggleEnabled = () => {
    if (!sharedInput) {
      onSharedInputChange({ ...defaultMapping, enabled: true });
      return;
    }
    onSharedInputChange({ ...sharedInput, enabled: !sharedInput.enabled });
  };

  return (
    <div className="px-2 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
          Shared Input
        </span>
        <button
          type="button"
          onClick={handleToggleEnabled}
          className={`relative w-7 h-4 rounded-full transition-colors ${
            enabled ? "bg-cyan-600" : "bg-zinc-700"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-3" : ""
            }`}
          />
        </button>
      </div>

      {hasMixedSources && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
          Group members use different sources. Shared UVs will still span them, but each layer samples its own source.
        </div>
      )}

      {enabled && sharedInput && (
        <div className="space-y-2">
          <div>
            <span className="block text-[10px] text-zinc-500 mb-0.5">Group Box</span>
            <div className="grid grid-cols-2 gap-1">
              <NumericField
                label="X"
                value={sharedInput.box[0]}
                min={-1}
                max={2}
                step={0.01}
                decimals={2}
                onChange={(v) => update({ box: [v, sharedInput.box[1], sharedInput.box[2], sharedInput.box[3]] })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="Y"
                value={sharedInput.box[1]}
                min={-1}
                max={2}
                step={0.01}
                decimals={2}
                onChange={(v) => update({ box: [sharedInput.box[0], v, sharedInput.box[2], sharedInput.box[3]] })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="W"
                value={sharedInput.box[2]}
                min={0.01}
                max={4}
                step={0.01}
                decimals={2}
                onChange={(v) => update({ box: [sharedInput.box[0], sharedInput.box[1], v, sharedInput.box[3]] })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="H"
                value={sharedInput.box[3]}
                min={0.01}
                max={4}
                step={0.01}
                decimals={2}
                onChange={(v) => update({ box: [sharedInput.box[0], sharedInput.box[1], sharedInput.box[2], v] })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
            </div>
          </div>

          <div>
            <span className="block text-[10px] text-zinc-500 mb-0.5">Warp</span>
            <div className="grid grid-cols-2 gap-1">
              <NumericField
                label="OX"
                value={sharedInput.offsetX}
                min={-2}
                max={2}
                step={0.01}
                decimals={2}
                onChange={(v) => update({ offsetX: v })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="OY"
                value={sharedInput.offsetY}
                min={-2}
                max={2}
                step={0.01}
                decimals={2}
                onChange={(v) => update({ offsetY: v })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="Rot"
                value={(sharedInput.rotation * 180) / Math.PI}
                min={-180}
                max={180}
                step={1}
                decimals={0}
                suffix={"°"}
                onChange={(v) => update({ rotation: (v * Math.PI) / 180 })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="SX"
                value={sharedInput.scaleX}
                min={0.1}
                max={10}
                step={0.01}
                decimals={2}
                onChange={(v) => update({ scaleX: v })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
              <NumericField
                label="SY"
                value={sharedInput.scaleY}
                min={0.1}
                max={10}
                step={0.01}
                decimals={2}
                onChange={(v) => update({ scaleY: v })}
                onPointerDown={onSliderDown}
                onPointerUp={onSliderUp}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

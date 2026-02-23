import { useAppStore } from "../../store/useAppStore";
import type { CalibrationPattern } from "../../types";

const PATTERNS: { value: CalibrationPattern; label: string }[] = [
  { value: "grid", label: "Grid" },
  { value: "crosshair", label: "Crosshair" },
  { value: "checkerboard", label: "Checker" },
  { value: "fullWhite", label: "White" },
  { value: "colorBars", label: "Color Bars" },
  { value: "black", label: "Black" },
];

function CalibrationBar() {
  const {
    calibrationEnabled,
    calibrationPattern,
    toggleCalibration,
    setCalibrationPattern,
    selectedLayerId,
    setCalibrationTarget,
    project,
    layers,
  } = useAppStore();

  const hasTarget = !!project?.calibration?.target_layer;
  const canTargetLayer = calibrationEnabled && !!selectedLayerId;

  const handleLayerTargetToggle = () => {
    if (hasTarget) {
      setCalibrationTarget(null);
    } else if (selectedLayerId) {
      setCalibrationTarget({ layer_id: selectedLayerId });
    }
  };

  const targetLayerName = hasTarget
    ? layers.find((l) => l.id === project?.calibration?.target_layer?.layer_id)?.name
      ?? project?.calibration?.target_layer?.layer_id
    : null;

  return (
    <div
      className={`flex items-center h-8 px-3 gap-3 border-b transition-colors ${
        calibrationEnabled
          ? "bg-amber-900/30 border-amber-700/50"
          : "bg-aura-surface border-aura-border"
      }`}
    >
      <button
        onClick={toggleCalibration}
        className={`btn text-xs px-2 py-0.5 ${
          calibrationEnabled
            ? "bg-amber-600 text-white"
            : "bg-aura-hover text-aura-text-dim"
        }`}
      >
        {calibrationEnabled ? "Calibration ON" : "Calibration OFF"}
      </button>

      {calibrationEnabled && (
        <>
          <div className="w-px h-4 bg-aura-border" />
          <span className="text-xs text-aura-text-dim">Pattern:</span>
          <div className="flex gap-1">
            {PATTERNS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setCalibrationPattern(value)}
                className={`btn text-xs px-2 py-0.5 ${
                  calibrationPattern === value
                    ? "bg-amber-700 text-white"
                    : "bg-aura-hover text-aura-text-dim hover:text-aura-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Target Layer toggle */}
          {(canTargetLayer || hasTarget) && (
            <>
              <div className="w-px h-4 bg-aura-border" />
              <button
                onClick={handleLayerTargetToggle}
                className={`btn text-xs px-2 py-0.5 ${
                  hasTarget
                    ? "bg-amber-500 text-white"
                    : "bg-aura-hover text-aura-text-dim hover:text-aura-text"
                }`}
                title={hasTarget ? "Calibrating target layer — click to go global" : "Calibrate selected layer only"}
              >
                {hasTarget ? targetLayerName ?? "Target Layer" : "Target Layer"}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default CalibrationBar;

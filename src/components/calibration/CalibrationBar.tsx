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
  } = useAppStore();

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
        </>
      )}
    </div>
  );
}

export default CalibrationBar;

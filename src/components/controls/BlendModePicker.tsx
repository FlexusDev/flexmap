import { Popover } from "./Popover";
import type { BlendMode } from "../../types";

interface BlendModePickerProps {
  value: BlendMode | null;
  mixed?: boolean;
  onChange: (mode: BlendMode) => void;
}

interface BlendModeGroup {
  label: string;
  colorClass: string;
  selectedClass: string;
  modes: { value: BlendMode; label: string }[];
}

const GROUPS: BlendModeGroup[] = [
  {
    label: "Normal",
    colorClass: "text-indigo-300",
    selectedClass: "ring-1 ring-indigo-400 bg-indigo-500/20",
    modes: [{ value: "normal", label: "Normal" }],
  },
  {
    label: "Darken",
    colorClass: "text-orange-300",
    selectedClass: "ring-1 ring-indigo-400 bg-indigo-500/20",
    modes: [
      { value: "multiply", label: "Multiply" },
      { value: "darken", label: "Darken" },
      { value: "colorBurn", label: "Color Burn" },
    ],
  },
  {
    label: "Lighten",
    colorClass: "text-sky-300",
    selectedClass: "ring-1 ring-indigo-400 bg-indigo-500/20",
    modes: [
      { value: "screen", label: "Screen" },
      { value: "lighten", label: "Lighten" },
      { value: "colorDodge", label: "Color Dodge" },
    ],
  },
  {
    label: "Contrast",
    colorClass: "text-zinc-300",
    selectedClass: "ring-1 ring-indigo-400 bg-indigo-500/20",
    modes: [
      { value: "overlay", label: "Overlay" },
      { value: "softLight", label: "Soft Light" },
      { value: "hardLight", label: "Hard Light" },
    ],
  },
  {
    label: "Math",
    colorClass: "text-violet-300",
    selectedClass: "ring-1 ring-indigo-400 bg-indigo-500/20",
    modes: [
      { value: "difference", label: "Difference" },
      { value: "exclusion", label: "Exclusion" },
      { value: "additive", label: "Additive" },
    ],
  },
];

const MODE_LABELS: Record<BlendMode, string> = Object.fromEntries(
  GROUPS.flatMap((g) => g.modes.map((m) => [m.value, m.label]))
) as Record<BlendMode, string>;

export function BlendModePicker({
  value,
  mixed,
  onChange,
}: BlendModePickerProps) {
  const displayLabel = mixed ? "Mixed" : value ? MODE_LABELS[value] : "None";

  return (
    <Popover
      trigger={
        <button
          type="button"
          className="text-[11px] bg-zinc-800/50 rounded hover:bg-zinc-700 px-2 py-1 text-zinc-200 text-left w-full"
        >
          {displayLabel}
        </button>
      }
      className="w-52 p-2"
    >
      <div className="flex flex-col gap-2">
        {GROUPS.map((group) => (
          <div key={group.label}>
            <div
              className={`text-[10px] uppercase tracking-wider mb-1 ${group.colorClass}`}
            >
              {group.label}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {group.modes.map((mode) => {
                const selected = value === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => onChange(mode.value)}
                    className={`text-[11px] text-zinc-200 rounded px-2 py-1 text-left hover:bg-zinc-700 ${
                      selected ? group.selectedClass : ""
                    }`}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Popover>
  );
}

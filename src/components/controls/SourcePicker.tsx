import { useMemo } from "react";
import { Popover } from "./Popover";

export interface SourceOption {
  id: string;
  protocol: string;
  display_name: string;
  resolution?: { width: number; height: number } | null;
}

interface SourcePickerProps {
  value: string | null;
  sources: SourceOption[];
  mixed?: boolean;
  onChange: (sourceId: string) => void;
}

const PROTOCOL_ICONS: Record<string, string> = {
  syphon: "\u25C9",
  spout: "\u25C8",
  ndi: "\u25CE",
  shader: "\u2726",
  file: "\u25B6",
  test: "\u25A3",
};

function protocolIcon(protocol: string): string {
  return PROTOCOL_ICONS[protocol.toLowerCase()] ?? "\u25CB";
}

export function SourcePicker({
  value,
  sources,
  mixed,
  onChange,
}: SourcePickerProps) {
  const selected = useMemo(
    () => sources.find((s) => s.id === value) ?? null,
    [sources, value],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, SourceOption[]>();
    for (const src of sources) {
      const key = src.protocol.toLowerCase();
      const list = map.get(key);
      if (list) {
        list.push(src);
      } else {
        map.set(key, [src]);
      }
    }
    return map;
  }, [sources]);

  const triggerLabel = mixed
    ? "Mixed"
    : selected
      ? selected.display_name
      : "None";

  const triggerIcon = mixed
    ? "\u25CB"
    : selected
      ? protocolIcon(selected.protocol)
      : "\u25CB";

  const trigger = (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded bg-zinc-800/50 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700/50 transition-colors"
    >
      <span className="text-indigo-400">{triggerIcon}</span>
      <span className="truncate max-w-[120px]">{triggerLabel}</span>
    </button>
  );

  return (
    <Popover trigger={trigger} className="w-56 p-1.5">
      {/* None option */}
      <button
        type="button"
        onClick={() => onChange("")}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] transition-colors ${
          !value && !mixed
            ? "bg-indigo-500/20 ring-1 ring-indigo-400"
            : "hover:bg-zinc-700/50"
        }`}
      >
        <span className="text-zinc-500">{"\u25CB"}</span>
        <span className="text-zinc-300">None</span>
      </button>

      <div className="my-1 border-t border-zinc-700" />

      {/* Grouped sources */}
      {[...grouped.entries()].map(([protocol, items]) => (
        <div key={protocol}>
          <div className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase text-zinc-500">
            {protocol}
          </div>
          {items.map((src) => {
            const isSelected = src.id === value;
            return (
              <button
                key={src.id}
                type="button"
                onClick={() => onChange(src.id)}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] transition-colors ${
                  isSelected
                    ? "bg-indigo-500/20 ring-1 ring-indigo-400"
                    : "hover:bg-zinc-700/50"
                }`}
              >
                <span className="text-indigo-400">
                  {protocolIcon(src.protocol)}
                </span>
                <span className="flex-1 truncate text-zinc-200">
                  {src.display_name}
                </span>
                {src.resolution && (
                  <span className="text-[10px] text-zinc-500">
                    {src.resolution.width}x{src.resolution.height}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </Popover>
  );
}

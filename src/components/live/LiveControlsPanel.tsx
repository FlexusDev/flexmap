import { useAppStore } from "../../store/useAppStore";
import { TempoCard } from "./TempoCard";

export function LiveControlsPanel() {
  const liveControlsOpen = useAppStore((s) => s.liveControlsOpen);

  if (!liveControlsOpen) return null;

  return (
    <div className="border-t border-aura-border bg-aura-bg p-2 overflow-x-auto">
      <div className="flex gap-2">
        <TempoCard />
      </div>
    </div>
  );
}

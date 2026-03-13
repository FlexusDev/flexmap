import { useCallback } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { TempoCard } from "./TempoCard";

interface LiveControlsPanelProps {
  panelRef: React.RefObject<PanelImperativeHandle | null>;
  collapsed: boolean;
}

export function LiveControlsPanel({ panelRef, collapsed }: LiveControlsPanelProps) {
  const toggle = useCallback(() => {
    const handle = panelRef.current;
    if (!handle) return;
    if (handle.isCollapsed()) {
      handle.expand();
    } else {
      handle.collapse();
    }
  }, [panelRef]);

  return (
    <div className="h-full flex flex-col min-h-0 border-t border-aura-border bg-aura-bg">
      {/* Titlebar — always visible even when collapsed */}
      <div
        className="flex items-center justify-between px-3 py-1 shrink-0 cursor-pointer select-none hover:bg-aura-hover/50"
        onClick={toggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className="text-[10px] text-aura-text-dim uppercase tracking-wider">
          Live Controls
        </span>
        <span className="text-[10px] text-aura-text-dim">
          {collapsed ? "▸" : "▾"}
        </span>
      </div>

      {/* Body — hidden when panel is collapsed to titlebar height */}
      {!collapsed && (
        <div className="flex-1 min-h-0 overflow-auto p-2">
          <div className="flex gap-2">
            <TempoCard />
          </div>
        </div>
      )}
    </div>
  );
}

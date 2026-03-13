import { useState } from "react";
import { TempoCard } from "./TempoCard";

export function LiveControlsPanel() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="h-full flex flex-col min-h-0 border-t border-aura-border bg-aura-bg">
      {/* Titlebar */}
      <div
        className="flex items-center justify-between px-3 py-1 shrink-0 cursor-pointer select-none hover:bg-aura-hover/50"
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed((c) => !c);
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

      {/* Body */}
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

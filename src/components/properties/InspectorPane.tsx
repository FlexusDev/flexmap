import type { ReactNode } from "react";

interface InspectorPaneProps {
  title: string;
  status?: string;
  active?: boolean;
  collapsed: boolean;
  onHeaderClick?: () => void;
  onToggleCollapsed: () => void;
  children: ReactNode;
}

function InspectorPane({
  title,
  status,
  active = false,
  collapsed,
  onHeaderClick,
  onToggleCollapsed,
  children,
}: InspectorPaneProps) {
  return (
    <div className={`inspector-pane ${collapsed ? "is-collapsed" : ""}`}>
      <div
        className={`inspector-pane-header ${active ? "is-active" : ""}`}
        onClick={onHeaderClick}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onHeaderClick?.();
        }}
        role="button"
        tabIndex={0}
      >
        <div className="min-w-0">
          <div className="inspector-pane-title">{title}</div>
          {status && <div className="inspector-pane-status">{status}</div>}
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed();
          }}
          className="inspector-pane-toggle"
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand section" : "Collapse section"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>

      {!collapsed && <div className="inspector-pane-body">{children}</div>}
    </div>
  );
}

export default InspectorPane;

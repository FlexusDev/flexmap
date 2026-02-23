import { useState } from "react";
import { useAppStore } from "../../store/useAppStore";

function LayerPanel() {
  const {
    layers,
    selectedLayerId,
    selectLayer,
    addLayer,
    removeLayer,
    duplicateLayer,
    setLayerVisibility,
    setLayerLocked,
    renameLayer,
  } = useAppStore();

  const [showAddMenu, setShowAddMenu] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const handleAddLayer = (type: string) => {
    const count = layers.filter((l) => l.type === type).length + 1;
    const name = `${type.charAt(0).toUpperCase() + type.slice(1)} ${count}`;
    addLayer(name, type);
    setShowAddMenu(false);
  };

  const handleDoubleClick = (id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
  };

  const handleRenameSubmit = (id: string) => {
    if (editName.trim()) {
      renameLayer(id, editName.trim());
    }
    setEditingId(null);
  };

  // Sort by z-index descending (top layer first)
  const sortedLayers = [...layers].sort((a, b) => b.zIndex - a.zIndex);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-aura-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
          Layers
        </span>
        <div className="relative">
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="btn-ghost text-xs px-2 py-0.5"
          >
            + Add
          </button>
          {showAddMenu && (
            <div className="absolute right-0 top-full mt-1 bg-aura-surface border border-aura-border rounded-md shadow-xl z-50 py-1 min-w-[120px]">
              {["quad", "triangle", "mesh", "circle"].map((type) => (
                <button
                  key={type}
                  onClick={() => handleAddLayer(type)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-aura-hover transition-colors"
                >
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Layer list */}
      <div className="flex-1 overflow-y-auto">
        {sortedLayers.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-aura-text-dim">
            No layers yet
          </div>
        ) : (
          sortedLayers.map((layer) => (
            <div
              key={layer.id}
              onClick={() => selectLayer(layer.id)}
              className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors border-b border-aura-border/50 ${
                selectedLayerId === layer.id
                  ? "bg-aura-accent/20"
                  : "hover:bg-aura-hover"
              }`}
            >
              {/* Visibility toggle */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setLayerVisibility(layer.id, !layer.visible);
                }}
                className={`text-xs w-5 h-5 flex items-center justify-center rounded ${
                  layer.visible ? "text-aura-text" : "text-aura-text-dim"
                }`}
                title={layer.visible ? "Hide" : "Show"}
              >
                {layer.visible ? "👁" : "—"}
              </button>

              {/* Layer type icon */}
              <span className="text-xs text-aura-text-dim w-5 text-center">
                {layer.type === "quad"
                  ? "◻"
                  : layer.type === "triangle"
                  ? "△"
                  : layer.type === "mesh"
                  ? "▦"
                  : "○"}
              </span>

              {/* Name */}
              <div className="flex-1 min-w-0">
                {editingId === layer.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => handleRenameSubmit(layer.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSubmit(layer.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="input text-xs w-full py-0 px-1"
                    autoFocus
                  />
                ) : (
                  <span
                    className="text-xs truncate block"
                    onDoubleClick={() =>
                      handleDoubleClick(layer.id, layer.name)
                    }
                  >
                    {layer.name}
                  </span>
                )}
              </div>

              {/* Lock toggle */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setLayerLocked(layer.id, !layer.locked);
                }}
                className={`text-xs w-5 h-5 flex items-center justify-center rounded ${
                  layer.locked ? "text-aura-warning" : "text-aura-text-dim"
                }`}
                title={layer.locked ? "Unlock" : "Lock"}
              >
                {layer.locked ? "🔒" : ""}
              </button>

              {/* Actions */}
              <div className="flex gap-0.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicateLayer(layer.id);
                  }}
                  className="text-xs text-aura-text-dim hover:text-aura-text px-1"
                  title="Duplicate"
                >
                  ⧉
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeLayer(layer.id);
                  }}
                  className="text-xs text-aura-text-dim hover:text-aura-error px-1"
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default LayerPanel;

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/useAppStore";

function LayerPanel() {
  const {
    layers,
    selectedLayerId,
    selectedLayerIds,
    setLayerSelection,
    toggleLayerSelection,
    addLayer,
    removeLayer,
    duplicateLayer,
    removeSelectedLayers,
    duplicateSelectedLayers,
    setLayerVisibility,
    setLayerLocked,
    renameLayer,
  } = useAppStore();

  const [showAddMenu, setShowAddMenu] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [rangeAnchorId, setRangeAnchorId] = useState<string | null>(null);

  const handleAddLayer = (type: string) => {
    const count = layers.filter((l) => l.type === type).length + 1;
    const name = `${type.charAt(0).toUpperCase() + type.slice(1)} ${count}`;
    void addLayer(name, type);
    setShowAddMenu(false);
  };

  const handleDoubleClick = (id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
  };

  const handleRenameSubmit = (id: string) => {
    if (editName.trim()) {
      void renameLayer(id, editName.trim());
    }
    setEditingId(null);
  };

  // Sort by z-index descending (top layer first)
  const sortedLayers = useMemo(
    () => [...layers].sort((a, b) => b.zIndex - a.zIndex),
    [layers]
  );

  useEffect(() => {
    if (!rangeAnchorId) return;
    if (!sortedLayers.some((l) => l.id === rangeAnchorId)) {
      setRangeAnchorId(null);
    }
  }, [rangeAnchorId, sortedLayers]);

  const effectiveSelectedIds = selectedLayerIds.length > 0
    ? selectedLayerIds
    : selectedLayerId
      ? [selectedLayerId]
      : [];
  const selectedSet = useMemo(() => new Set(effectiveSelectedIds), [effectiveSelectedIds]);

  const handleLayerClick = (
    e: React.MouseEvent<HTMLDivElement>,
    layerId: string
  ) => {
    const cmdOrCtrl = e.metaKey || e.ctrlKey;
    if (e.shiftKey) {
      const anchor = rangeAnchorId ?? selectedLayerId ?? layerId;
      const start = sortedLayers.findIndex((l) => l.id === anchor);
      const end = sortedLayers.findIndex((l) => l.id === layerId);
      if (start >= 0 && end >= 0) {
        const [lo, hi] = start <= end ? [start, end] : [end, start];
        const rangeIds = sortedLayers.slice(lo, hi + 1).map((l) => l.id);
        setLayerSelection(rangeIds, layerId);
      } else {
        setLayerSelection([layerId], layerId);
      }
      setRangeAnchorId(layerId);
      return;
    }

    if (cmdOrCtrl) {
      toggleLayerSelection(layerId);
      setRangeAnchorId(layerId);
      return;
    }

    setLayerSelection([layerId], layerId);
    setRangeAnchorId(layerId);
  };

  const resolveActionTargets = (rowLayerId: string): string[] => {
    if (selectedSet.has(rowLayerId) && effectiveSelectedIds.length > 1) {
      return effectiveSelectedIds;
    }
    return [rowLayerId];
  };

  const handleVisibilityToggle = (
    e: React.MouseEvent<HTMLButtonElement>,
    rowLayerId: string,
    nextVisible: boolean
  ) => {
    e.stopPropagation();
    const targetIds = resolveActionTargets(rowLayerId);
    for (const id of targetIds) {
      void setLayerVisibility(id, nextVisible);
    }
  };

  const handleLockToggle = (
    e: React.MouseEvent<HTMLButtonElement>,
    rowLayerId: string,
    nextLocked: boolean
  ) => {
    e.stopPropagation();
    const targetIds = resolveActionTargets(rowLayerId);
    for (const id of targetIds) {
      void setLayerLocked(id, nextLocked);
    }
  };

  const handleDuplicate = (
    e: React.MouseEvent<HTMLButtonElement>,
    rowLayerId: string
  ) => {
    e.stopPropagation();
    const targetIds = resolveActionTargets(rowLayerId);
    if (targetIds.length > 1) {
      void duplicateSelectedLayers();
    } else {
      void duplicateLayer(rowLayerId);
    }
  };

  const handleDelete = (
    e: React.MouseEvent<HTMLButtonElement>,
    rowLayerId: string
  ) => {
    e.stopPropagation();
    const targetIds = resolveActionTargets(rowLayerId);
    if (targetIds.length > 1) {
      void removeSelectedLayers();
    } else {
      void removeLayer(rowLayerId);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0" role="region" aria-label="Layers">
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-aura-border/50">
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

      <div className="flex-1 overflow-y-auto">
        {sortedLayers.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-aura-text-dim">
            No layers yet
          </div>
        ) : (
          sortedLayers.map((layer) => (
            <div
              key={layer.id}
              onClick={(e) => handleLayerClick(e, layer.id)}
              className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors border-b border-aura-border/50 ${
                selectedSet.has(layer.id)
                  ? selectedLayerId === layer.id
                    ? "bg-aura-accent/30 ring-1 ring-aura-accent/40"
                    : "bg-aura-accent/15"
                  : "hover:bg-aura-hover"
              }`}
            >
              {/* Visibility toggle */}
              <button
                onClick={(e) => handleVisibilityToggle(e, layer.id, !layer.visible)}
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
                onClick={(e) => handleLockToggle(e, layer.id, !layer.locked)}
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
                  onClick={(e) => handleDuplicate(e, layer.id)}
                  className="text-xs text-aura-text-dim hover:text-aura-text px-1"
                  title="Duplicate"
                >
                  ⧉
                </button>
                <button
                  onClick={(e) => handleDelete(e, layer.id)}
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

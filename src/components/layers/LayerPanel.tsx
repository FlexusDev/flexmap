import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/useAppStore";
import type { Layer, LayerGroup } from "../../types";

/** A row in the flat render list: either a group header or a layer. */
type ListItem =
  | { kind: "group"; group: LayerGroup; memberLayers: Layer[] }
  | { kind: "layer"; layer: Layer; indented: boolean };

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
    groups,
    createGroup,
    deleteGroup,
  } = useAppStore(
    useShallow((s) => ({
      layers: s.layers,
      selectedLayerId: s.selectedLayerId,
      selectedLayerIds: s.selectedLayerIds,
      setLayerSelection: s.setLayerSelection,
      toggleLayerSelection: s.toggleLayerSelection,
      addLayer: s.addLayer,
      removeLayer: s.removeLayer,
      duplicateLayer: s.duplicateLayer,
      removeSelectedLayers: s.removeSelectedLayers,
      duplicateSelectedLayers: s.duplicateSelectedLayers,
      setLayerVisibility: s.setLayerVisibility,
      setLayerLocked: s.setLayerLocked,
      renameLayer: s.renameLayer,
      groups: s.groups,
      createGroup: s.createGroup,
      deleteGroup: s.deleteGroup,
    }))
  );

  const [showAddMenu, setShowAddMenu] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [rangeAnchorId, setRangeAnchorId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");

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

  // Build the flat render list: group headers interspersed with layers
  const listItems: ListItem[] = useMemo(() => {
    const groupMap = new Map<string, LayerGroup>();
    for (const g of groups) {
      groupMap.set(g.id, g);
    }

    // Collect grouped layers per group, preserving z-index sort order
    const groupedLayers = new Map<string, Layer[]>();
    const ungroupedLayers: Layer[] = [];

    for (const layer of sortedLayers) {
      if (layer.groupId && groupMap.has(layer.groupId)) {
        let arr = groupedLayers.get(layer.groupId);
        if (!arr) {
          arr = [];
          groupedLayers.set(layer.groupId, arr);
        }
        arr.push(layer);
      } else {
        ungroupedLayers.push(layer);
      }
    }

    // Determine effective z-index for each group (max of its members)
    const groupMaxZ = new Map<string, number>();
    for (const [gid, members] of groupedLayers) {
      const maxZ = Math.max(...members.map((l) => l.zIndex));
      groupMaxZ.set(gid, maxZ);
    }

    // Build items: we need to merge ungrouped layers and groups by z-index
    type Positionable =
      | { kind: "ungrouped"; layer: Layer; sortZ: number }
      | { kind: "group"; groupId: string; sortZ: number };

    const positionables: Positionable[] = [];

    for (const layer of ungroupedLayers) {
      positionables.push({
        kind: "ungrouped",
        layer,
        sortZ: layer.zIndex,
      });
    }

    for (const [gid, maxZ] of groupMaxZ) {
      positionables.push({ kind: "group", groupId: gid, sortZ: maxZ });
    }

    // Sort descending by z-index
    positionables.sort((a, b) => b.sortZ - a.sortZ);

    const items: ListItem[] = [];
    for (const p of positionables) {
      if (p.kind === "ungrouped") {
        items.push({ kind: "layer", layer: p.layer, indented: false });
      } else {
        const group = groupMap.get(p.groupId)!;
        const members = groupedLayers.get(p.groupId) ?? [];
        items.push({ kind: "group", group, memberLayers: members });
        if (!collapsedGroups.has(p.groupId)) {
          for (const layer of members) {
            items.push({ kind: "layer", layer, indented: true });
          }
        }
      }
    }

    return items;
  }, [sortedLayers, groups, collapsedGroups]);

  useEffect(() => {
    if (!rangeAnchorId) return;
    if (!sortedLayers.some((l) => l.id === rangeAnchorId)) {
      setRangeAnchorId(null);
    }
  }, [rangeAnchorId, sortedLayers]);

  const effectiveSelectedIds =
    selectedLayerIds.length > 0
      ? selectedLayerIds
      : selectedLayerId
        ? [selectedLayerId]
        : [];
  const selectedSet = useMemo(
    () => new Set(effectiveSelectedIds),
    [effectiveSelectedIds]
  );

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

  // --- Group actions ---

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleGroupClick = (
    _e: React.MouseEvent<HTMLDivElement>,
    group: LayerGroup
  ) => {
    // Select all layers in the group
    if (group.layerIds.length > 0) {
      setLayerSelection(group.layerIds, group.layerIds[0]);
    }
  };

  const handleGroupVisibilityToggle = (
    e: React.MouseEvent<HTMLButtonElement>,
    _group: LayerGroup,
    memberLayers: Layer[]
  ) => {
    e.stopPropagation();
    // If all members visible, hide all. Otherwise, show all.
    const allVisible = memberLayers.every((l) => l.visible);
    const nextVisible = !allVisible;
    for (const layer of memberLayers) {
      void setLayerVisibility(layer.id, nextVisible);
    }
  };

  const handleGroupLockToggle = (
    e: React.MouseEvent<HTMLButtonElement>,
    _group: LayerGroup,
    memberLayers: Layer[]
  ) => {
    e.stopPropagation();
    const allLocked = memberLayers.every((l) => l.locked);
    const nextLocked = !allLocked;
    for (const layer of memberLayers) {
      void setLayerLocked(layer.id, nextLocked);
    }
  };

  const handleGroupDoubleClick = (groupId: string, name: string) => {
    setEditingGroupId(groupId);
    setEditGroupName(name);
  };

  const handleGroupRenameSubmit = (_groupId: string) => {
    // No backend rename command yet — just close editor
    setEditingGroupId(null);
  };

  const handleUngroup = (
    e: React.MouseEvent<HTMLButtonElement>,
    groupId: string
  ) => {
    e.stopPropagation();
    void deleteGroup(groupId);
  };

  const handleCreateGroup = () => {
    if (effectiveSelectedIds.length < 2) return;
    const groupCount = groups.length + 1;
    void createGroup(`Group ${groupCount}`, effectiveSelectedIds);
  };

  // Determine if the "Group" button should be enabled
  const canGroup = effectiveSelectedIds.length >= 2;

  return (
    <div
      data-testid="layer-panel"
      className="flex-1 flex flex-col min-h-0"
      role="region"
      aria-label="Layers"
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-aura-border/50">
        <button
          data-testid="group-layers-btn"
          onClick={handleCreateGroup}
          disabled={!canGroup}
          className={`btn-ghost text-xs px-2 py-0.5 ${
            canGroup
              ? "text-aura-text"
              : "text-aura-text-dim opacity-50 cursor-not-allowed"
          }`}
          title={
            canGroup
              ? "Group selected layers"
              : "Select 2+ layers to group"
          }
        >
          Group
        </button>
        <div className="relative">
          <button
            data-testid="add-layer-btn"
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
                  data-testid={`add-${type}`}
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
        {listItems.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-aura-text-dim">
            No layers yet
          </div>
        ) : (
          listItems.map((item) => {
            if (item.kind === "group") {
              const { group, memberLayers } = item;
              const isCollapsed = collapsedGroups.has(group.id);
              const allVisible = memberLayers.every((l) => l.visible);
              const allLocked = memberLayers.every((l) => l.locked);
              const allSelected =
                memberLayers.length > 0 &&
                memberLayers.every((l) => selectedSet.has(l.id));

              return (
                <div
                  key={`group-${group.id}`}
                  data-testid="group-header"
                  onClick={(e) => handleGroupClick(e, group)}
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors border-b border-aura-border/50 bg-aura-surface/60 ${
                    allSelected ? "bg-aura-accent/15" : "hover:bg-aura-hover"
                  }`}
                >
                  {/* Collapse toggle */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleGroupCollapsed(group.id);
                    }}
                    className="text-xs w-5 h-5 flex items-center justify-center rounded text-aura-text-dim"
                    title={isCollapsed ? "Expand group" : "Collapse group"}
                  >
                    {isCollapsed ? "\u25b6" : "\u25bc"}
                  </button>

                  {/* Visibility toggle */}
                  <button
                    onClick={(e) =>
                      handleGroupVisibilityToggle(e, group, memberLayers)
                    }
                    className={`text-xs w-5 h-5 flex items-center justify-center rounded ${
                      allVisible ? "text-aura-text" : "text-aura-text-dim"
                    }`}
                    title={allVisible ? "Hide group" : "Show group"}
                  >
                    {allVisible ? "\ud83d\udc41" : "\u2014"}
                  </button>

                  {/* Folder icon */}
                  <span className="text-xs text-aura-text-dim w-5 text-center">
                    {isCollapsed ? "\ud83d\udcc1" : "\ud83d\udcc2"}
                  </span>

                  {/* Group name */}
                  <div className="flex-1 min-w-0">
                    {editingGroupId === group.id ? (
                      <input
                        value={editGroupName}
                        onChange={(e) => setEditGroupName(e.target.value)}
                        onBlur={() => handleGroupRenameSubmit(group.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter")
                            handleGroupRenameSubmit(group.id);
                          if (e.key === "Escape") setEditingGroupId(null);
                        }}
                        className="input text-xs w-full py-0 px-1"
                        autoFocus
                      />
                    ) : (
                      <span
                        className="text-xs truncate block font-medium"
                        onDoubleClick={() =>
                          handleGroupDoubleClick(group.id, group.name)
                        }
                      >
                        {group.name}
                        <span className="text-aura-text-dim font-normal ml-1">
                          ({memberLayers.length})
                        </span>
                      </span>
                    )}
                  </div>

                  {/* Lock toggle */}
                  <button
                    onClick={(e) =>
                      handleGroupLockToggle(e, group, memberLayers)
                    }
                    className={`text-xs w-5 h-5 flex items-center justify-center rounded ${
                      allLocked ? "text-aura-warning" : "text-aura-text-dim"
                    }`}
                    title={allLocked ? "Unlock group" : "Lock group"}
                  >
                    {allLocked ? "\uD83D\uDD12" : ""}
                  </button>

                  {/* Ungroup button */}
                  <div className="flex gap-0.5">
                    <button
                      onClick={(e) => handleUngroup(e, group.id)}
                      className="text-xs text-aura-text-dim hover:text-aura-error px-1"
                      title="Ungroup"
                    >
                      {"\u2715"}
                    </button>
                  </div>
                </div>
              );
            }

            // Layer row
            const { layer, indented } = item;
            return (
              <div
                key={layer.id}
                data-testid="layer-item"
                data-selected={selectedSet.has(layer.id) ? "true" : "false"}
                onClick={(e) => handleLayerClick(e, layer.id)}
                className={`flex items-center gap-2 py-2 cursor-pointer transition-colors border-b border-aura-border/50 ${
                  indented ? "pl-6 pr-3" : "px-3"
                } ${
                  selectedSet.has(layer.id)
                    ? selectedLayerId === layer.id
                      ? "bg-aura-accent/30 ring-1 ring-aura-accent/40"
                      : "bg-aura-accent/15"
                    : "hover:bg-aura-hover"
                }`}
              >
                {/* Visibility toggle */}
                <button
                  onClick={(e) =>
                    handleVisibilityToggle(e, layer.id, !layer.visible)
                  }
                  className={`text-xs w-5 h-5 flex items-center justify-center rounded ${
                    layer.visible ? "text-aura-text" : "text-aura-text-dim"
                  }`}
                  title={layer.visible ? "Hide" : "Show"}
                >
                  {layer.visible ? "\uD83D\uDC41" : "\u2014"}
                </button>

                {/* Layer type icon */}
                <span className="text-xs text-aura-text-dim w-5 text-center">
                  {layer.type === "quad"
                    ? "\u25FB"
                    : layer.type === "triangle"
                      ? "\u25B3"
                      : layer.type === "mesh"
                        ? "\u25A6"
                        : "\u25CB"}
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
                  onClick={(e) =>
                    handleLockToggle(e, layer.id, !layer.locked)
                  }
                  className={`text-xs w-5 h-5 flex items-center justify-center rounded ${
                    layer.locked ? "text-aura-warning" : "text-aura-text-dim"
                  }`}
                  title={layer.locked ? "Unlock" : "Lock"}
                >
                  {layer.locked ? "\uD83D\uDD12" : ""}
                </button>

                {/* Actions */}
                <div className="flex gap-0.5">
                  <button
                    onClick={(e) => handleDuplicate(e, layer.id)}
                    className="text-xs text-aura-text-dim hover:text-aura-text px-1"
                    title="Duplicate"
                  >
                    {"\u29c9"}
                  </button>
                  <button
                    onClick={(e) => handleDelete(e, layer.id)}
                    className="text-xs text-aura-text-dim hover:text-aura-error px-1"
                    title="Delete"
                  >
                    {"\u2715"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default LayerPanel;

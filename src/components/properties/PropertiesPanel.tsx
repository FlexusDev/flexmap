import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/useAppStore";
import type {
  InputTransform,
  LayerGeometry,
  LayerProperties,
  Point2D,
  BlendMode,
} from "../../types";
import { DEFAULT_INPUT_TRANSFORM } from "../../types";
import LayerSection from "./sections/LayerSection";
import EditSection from "./sections/EditSection";
import PixelMapSection from "./sections/PixelMapSection";
import SharedInputSection from "./sections/SharedInputSection";
import { defaultSharedInputForLayers, groupUsesMixedSources } from "../../lib/shared-input";

const EPS = 1e-6;

function geometryCenter(geometry: LayerGeometry): Point2D {
  if (geometry.type === "Circle") {
    return geometry.data.center;
  }

  const points = geometry.type === "Quad"
    ? geometry.data.corners
    : geometry.type === "Triangle"
      ? geometry.data.vertices
      : geometry.data.points;

  if (points.length === 0) {
    return { x: 0.5, y: 0.5 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5 };
}

function geometrySelectionCenter(layers: Array<{ geometry: LayerGeometry }>): Point2D {
  if (layers.length === 0) return { x: 0.5, y: 0.5 };
  let sx = 0;
  let sy = 0;
  for (const layer of layers) {
    const c = geometryCenter(layer.geometry);
    sx += c.x;
    sy += c.y;
  }
  return { x: sx / layers.length, y: sy / layers.length };
}

function PropertiesPanel() {
  const {
    project,
    layers,
    groups,
    selectedLayerId,
    selectedLayerIds,
    updatePropertiesForSelection,
    connectSourceForSelection,
    disconnectSourceForSelection,
    setBlendModeForSelection,
    sources,
    subdivideMesh,
    beginInteraction,
    setLayerInputTransform,
    applyGeometryDeltaToSelection,
    editorSelectionMode,
    selectedPointIndex,
    snapEnabled,
    toggleSnap,
    updateLayerPoint,
    setLayerVisibility,
    setLayerLocked,
    setLayerPixelMap,
    setGroupSharedInput,
  } = useAppStore(useShallow((s) => ({
    project: s.project,
    layers: s.layers,
    groups: s.groups,
    selectedLayerId: s.selectedLayerId,
    selectedLayerIds: s.selectedLayerIds,
    updatePropertiesForSelection: s.updatePropertiesForSelection,
    connectSourceForSelection: s.connectSourceForSelection,
    disconnectSourceForSelection: s.disconnectSourceForSelection,
    setBlendModeForSelection: s.setBlendModeForSelection,
    sources: s.sources,
    subdivideMesh: s.subdivideMesh,
    beginInteraction: s.beginInteraction,
    setLayerInputTransform: s.setLayerInputTransform,
    applyGeometryDeltaToSelection: s.applyGeometryDeltaToSelection,
    editorSelectionMode: s.editorSelectionMode,
    selectedPointIndex: s.selectedPointIndex,
    snapEnabled: s.snapEnabled,
    toggleSnap: s.toggleSnap,
    updateLayerPoint: s.updateLayerPoint,
    setLayerVisibility: s.setLayerVisibility,
    setLayerLocked: s.setLayerLocked,
    setLayerPixelMap: s.setLayerPixelMap,
    setGroupSharedInput: s.setGroupSharedInput,
  })));

  const effectiveSelectedIds = selectedLayerIds.length > 0
    ? selectedLayerIds
    : selectedLayerId
      ? [selectedLayerId]
      : [];
  const selectedSet = useMemo(
    () => new Set(effectiveSelectedIds),
    [effectiveSelectedIds]
  );
  const selectedLayers = useMemo(
    () => layers.filter((l) => selectedSet.has(l.id)),
    [layers, selectedSet]
  );
  const selectedGroup = useMemo(() => {
    if (effectiveSelectedIds.length === 0) return null;
    if (selectedLayers.some((layer) => !layer.groupId)) return null;
    const groupIds = new Set(
      selectedLayers
        .map((layer) => layer.groupId)
        .filter((groupId): groupId is string => !!groupId)
    );
    if (groupIds.size !== 1 || selectedLayers.length !== effectiveSelectedIds.length) {
      return null;
    }
    const [groupId] = [...groupIds];
    return groups.find((group) => group.id === groupId) ?? null;
  }, [effectiveSelectedIds.length, groups, selectedLayers]);
  const selectedGroupLayers = useMemo(
    () => selectedGroup
      ? layers.filter((layer) => selectedGroup.layerIds.includes(layer.id))
      : [],
    [layers, selectedGroup]
  );
  const selectedLayer = selectedLayerId
    ? selectedLayers.find((l) => l.id === selectedLayerId)
    : selectedLayers[0];
  const selectedCount = selectedLayers.length;
  const isMulti = selectedCount > 1;
  const hasSelection = selectedCount > 0;
  const outputWidth = Math.max(1, project?.output.width ?? 1);
  const outputHeight = Math.max(1, project?.output.height ?? 1);

  // --- Input transform local UI state (for throttled dispatch) ---
  const [inputUi, setInputUi] = useState<InputTransform>(DEFAULT_INPUT_TRANSFORM);
  const interactionActiveRef = useRef(false);
  const inputPendingRef = useRef<InputTransform | null>(null);
  const inputRafRef = useRef<number | null>(null);
  const inputInFlightRef = useRef(false);

  useEffect(() => {
    return () => {
      if (inputRafRef.current !== null) {
        cancelAnimationFrame(inputRafRef.current);
      }
    };
  }, []);

  // Reset local state when selection changes
  useEffect(() => {
    if (!selectedLayer) return;
    setInputUi(selectedLayer.input_transform ?? DEFAULT_INPUT_TRANSFORM);
    inputPendingRef.current = null;
    if (inputRafRef.current !== null) {
      cancelAnimationFrame(inputRafRef.current);
      inputRafRef.current = null;
    }
    interactionActiveRef.current = false;
  }, [selectedLayerId, selectedCount]);

  // Sync from store when not actively dragging (handles undo/redo, project load)
  useEffect(() => {
    if (!selectedLayer || interactionActiveRef.current) return;
    setInputUi(selectedLayer.input_transform ?? DEFAULT_INPUT_TRANSFORM);
  }, [selectedLayer?.input_transform]);

  // --- Primary layer alias ---
  const primaryLayer = selectedLayer ?? null;

  // --- Shared property derivation ---
  const props = primaryLayer?.properties ?? {
    brightness: 1.0,
    contrast: 1.0,
    gamma: 1.0,
    opacity: 1.0,
    feather: 0.0,
    beatReactive: false,
    beatAmount: 0.0,
  };

  const selectionMode = isMulti ? "shape" as const : editorSelectionMode;

  const geomCenterNorm = geometrySelectionCenter(selectedLayers);

  // Source derivation
  const sourceSet = new Set(selectedLayers.map((l) => l.source?.source_id ?? "__none__"));
  const sourceMixed = sourceSet.size > 1;
  const sharedSourceId = sourceMixed
    ? "__mixed__"
    : sourceSet.has("__none__")
      ? ""
      : selectedLayers[0]?.source?.source_id ?? "";

  // Blend derivation
  const blendSet = new Set(selectedLayers.map((l) => l.blend_mode ?? "normal"));
  const blendMixed = blendSet.size > 1;
  const sharedBlend: BlendMode | null = blendMixed
    ? null
    : (selectedLayers[0]?.blend_mode ?? "normal");

  // Look mixed keys
  const lookControls = [
    { key: "brightness" as const },
    { key: "contrast" as const },
    { key: "gamma" as const },
    { key: "opacity" as const },
    { key: "feather" as const },
  ];
  const mixedPropKeys = new Set<string>();
  for (const { key } of lookControls) {
    if (selectedLayers.some((layer) => Math.abs(layer.properties[key] - props[key]) > EPS)) {
      mixedPropKeys.add(key);
    }
  }
  const lookMixed = mixedPropKeys.size > 0;

  // Beat
  const beatEligible = selectedLayers.every((layer) => layer.source?.protocol === "shader");
  const sharedInputDefault = useMemo(
    () => defaultSharedInputForLayers(selectedGroupLayers),
    [selectedGroupLayers]
  );
  const sharedInputHasMixedSources = useMemo(
    () => selectedGroup ? groupUsesMixedSources(selectedGroup, layers) : false,
    [layers, selectedGroup]
  );
  // Visibility / Lock mixed
  const visibleMixed = selectedLayers.some((l) => l.visible !== primaryLayer?.visible);
  const lockedMixed = selectedLayers.some((l) => l.locked !== primaryLayer?.locked);

  // --- Sources mapped for SourcePicker ---
  const mappedSources = useMemo(
    () => sources.map((s) => ({
      id: s.id,
      protocol: s.protocol,
      display_name: s.name,
      resolution: s.width != null && s.height != null
        ? { width: s.width, height: s.height }
        : null,
    })),
    [sources]
  );

  // --- Point position derivation ---
  const pointPosition = useMemo(() => {
    if (selectedPointIndex === null || !primaryLayer) return null;
    const g = primaryLayer.geometry;
    let points: Point2D[] = [];
    switch (g.type) {
      case "Quad": points = [...g.data.corners]; break;
      case "Triangle": points = [...g.data.vertices]; break;
      case "Mesh": points = g.data.points; break;
      case "Circle": points = [g.data.center]; break;
    }
    return selectedPointIndex < points.length ? points[selectedPointIndex] : null;
  }, [selectedPointIndex, primaryLayer]);

  const pointCount = useMemo(() => {
    if (!primaryLayer) return 0;
    const g = primaryLayer.geometry;
    switch (g.type) {
      case "Quad": return 4;
      case "Triangle": return 3;
      case "Mesh": return g.data.points.length;
      case "Circle": return 1;
    }
  }, [primaryLayer]);

  // --- Interaction helpers ---
  const beginSliderInteraction = useCallback(() => {
    if (!interactionActiveRef.current) {
      interactionActiveRef.current = true;
      void beginInteraction();
    }
  }, [beginInteraction]);

  const endSliderInteraction = useCallback(() => {
    interactionActiveRef.current = false;
  }, []);

  // --- Input transform dispatch (throttled) ---
  const dispatchInput = useCallback(() => {
    if (inputInFlightRef.current) return;
    const next = inputPendingRef.current;
    if (!next) return;

    inputPendingRef.current = null;
    inputInFlightRef.current = true;
    void Promise.all(
      effectiveSelectedIds.map((id) => setLayerInputTransform(id, next))
    ).finally(() => {
      inputInFlightRef.current = false;
      if (inputPendingRef.current) {
        dispatchInput();
      }
    });
  }, [effectiveSelectedIds, setLayerInputTransform]);

  const scheduleInput = useCallback((next: InputTransform, immediate = false) => {
    inputPendingRef.current = next;
    if (immediate) {
      if (inputRafRef.current !== null) {
        cancelAnimationFrame(inputRafRef.current);
        inputRafRef.current = null;
      }
      dispatchInput();
      return;
    }
    if (inputRafRef.current === null) {
      inputRafRef.current = requestAnimationFrame(() => {
        inputRafRef.current = null;
        dispatchInput();
      });
    }
  }, [dispatchInput]);

  // --- Callbacks ---

  const handleSourceChange = useCallback((sourceId: string) => {
    if (sourceId === "") {
      void disconnectSourceForSelection();
    } else {
      void connectSourceForSelection(sourceId);
    }
  }, [connectSourceForSelection, disconnectSourceForSelection]);

  const handleBlendChange = useCallback((mode: BlendMode) => {
    void setBlendModeForSelection(mode);
  }, [setBlendModeForSelection]);

  const handleOpacityChange = useCallback((v: number) => {
    void updatePropertiesForSelection((current) => ({ ...current, opacity: v }));
  }, [updatePropertiesForSelection]);

  const handleToggleVisible = useCallback(() => {
    if (!primaryLayer) return;
    for (const layer of selectedLayers) {
      void setLayerVisibility(layer.id, !primaryLayer.visible);
    }
  }, [primaryLayer, selectedLayers, setLayerVisibility]);

  const handleToggleLock = useCallback(() => {
    if (!primaryLayer) return;
    for (const layer of selectedLayers) {
      void setLayerLocked(layer.id, !primaryLayer.locked);
    }
  }, [primaryLayer, selectedLayers, setLayerLocked]);

  const handleLookChange = useCallback((key: string, value: number) => {
    void updatePropertiesForSelection((current) => ({ ...current, [key]: value }));
  }, [updatePropertiesForSelection]);

  const handleLookReset = useCallback((key: string) => {
    const defaults: LayerProperties = {
      brightness: 1.0,
      contrast: 1.0,
      gamma: 1.0,
      opacity: 1.0,
      feather: 0.0,
      beatReactive: false,
      beatAmount: 0.0,
    };
    handleLookChange(key, defaults[key as keyof LayerProperties] as number);
  }, [handleLookChange]);

  const handleBeatToggle = useCallback(() => {
    void updatePropertiesForSelection((current) => ({
      ...current,
      beatReactive: !current.beatReactive,
    }));
  }, [updatePropertiesForSelection]);

  const handleBeatAmountChange = useCallback((v: number) => {
    void updatePropertiesForSelection((current) => ({ ...current, beatAmount: v }));
  }, [updatePropertiesForSelection]);

  // --- Center change (pixel coords -> geometry delta) ---
  const handleCenterChange = useCallback((xPx: number, yPx: number) => {
    const currentCenter = geometrySelectionCenter(selectedLayers);
    const dx = (xPx / outputWidth) - currentCenter.x;
    const dy = (yPx / outputHeight) - currentCenter.y;

    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return;

    beginSliderInteraction();
    void applyGeometryDeltaToSelection({
      dx,
      dy,
      dRotation: 0,
      sx: 1,
      sy: 1,
    });
    endSliderInteraction();
  }, [selectedLayers, outputWidth, outputHeight, beginSliderInteraction, endSliderInteraction, applyGeometryDeltaToSelection]);

  // --- Point change ---
  const handlePointChange = useCallback(async (pt: Point2D) => {
    if (selectedPointIndex === null || !primaryLayer) return;
    await updateLayerPoint(primaryLayer.id, selectedPointIndex, pt);
  }, [selectedPointIndex, primaryLayer, updateLayerPoint]);

  // --- Subdivide ---
  const handleSubdivide = useCallback(() => {
    if (!primaryLayer) return;
    void subdivideMesh(primaryLayer.id);
  }, [primaryLayer, subdivideMesh]);

  // --- Input transform change (key-value for EditSection) ---
  const handleInputTransformChange = useCallback((key: string, value: number) => {
    beginSliderInteraction();
    setInputUi((prev) => {
      let next: InputTransform;
      switch (key) {
        case "offsetX":
          next = { ...prev, offset: [value, prev.offset[1]] };
          break;
        case "offsetY":
          next = { ...prev, offset: [prev.offset[0], value] };
          break;
        case "rotation":
          next = { ...prev, rotation: (value * Math.PI) / 180 };
          break;
        case "scaleX":
          next = { ...prev, scale: [value, prev.scale[1]] };
          break;
        case "scaleY":
          next = { ...prev, scale: [prev.scale[0], value] };
          break;
        default:
          next = prev;
      }
      scheduleInput(next, false);
      return next;
    });
  }, [beginSliderInteraction, scheduleInput]);

  const handleInputTransformReset = useCallback(() => {
    beginSliderInteraction();
    setInputUi(DEFAULT_INPUT_TRANSFORM);
    scheduleInput(DEFAULT_INPUT_TRANSFORM, true);
    endSliderInteraction();
  }, [beginSliderInteraction, endSliderInteraction, scheduleInput]);

  // --- Derived values for EditSection ---
  const centerXPx = geomCenterNorm.x * outputWidth;
  const centerYPx = geomCenterNorm.y * outputHeight;

  const inputTransformFlat = useMemo(() => ({
    offsetX: inputUi.offset[0],
    offsetY: inputUi.offset[1],
    rotation: (inputUi.rotation * 180) / Math.PI,
    scaleX: inputUi.scale[0],
    scaleY: inputUi.scale[1],
  }), [inputUi]);

  // --- Render ---
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-aura-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
          Properties
        </span>
        {primaryLayer && (
          <div className="mt-1">
            <span className="text-sm font-medium">{primaryLayer.name}</span>
            <span className="ml-2 text-xs text-aura-text-dim">
              ({primaryLayer.type})
            </span>
            {selectedCount > 1 && (
              <span className="ml-2 text-xs text-aura-text-dim">
                +{selectedCount - 1} selected
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
        {hasSelection && primaryLayer ? (
          <>
            <div className="border-b border-zinc-700">
              <LayerSection
                sourceId={sharedSourceId === "" ? null : sharedSourceId === "__mixed__" ? null : sharedSourceId}
                sources={mappedSources}
                sourceMixed={sourceMixed}
                onSourceChange={handleSourceChange}
                blendMode={sharedBlend}
                blendMixed={blendMixed}
                onBlendChange={handleBlendChange}
                opacity={props.opacity}
                opacityMixed={mixedPropKeys.has("opacity")}
                onOpacityChange={handleOpacityChange}
                visible={primaryLayer.visible}
                locked={primaryLayer.locked}
                visibleMixed={visibleMixed}
                lockedMixed={lockedMixed}
                onToggleVisible={handleToggleVisible}
                onToggleLock={handleToggleLock}
                brightness={props.brightness}
                contrast={props.contrast}
                gamma={props.gamma}
                feather={props.feather}
                beatReactive={props.beatReactive}
                beatAmount={props.beatAmount}
                beatEligible={beatEligible}
                lookMixed={lookMixed}
                onLookChange={handleLookChange}
                onBeatToggle={handleBeatToggle}
                onBeatAmountChange={handleBeatAmountChange}
                onSliderDown={beginSliderInteraction}
                onSliderUp={endSliderInteraction}
                onLookReset={handleLookReset}
              />
            </div>

            <EditSection
              layer={primaryLayer}
              mode={selectionMode}
              selectedPointIndex={selectedPointIndex}
              snapEnabled={snapEnabled}
              onToggleSnap={toggleSnap}
              centerX={centerXPx}
              centerY={centerYPx}
              onCenterChange={handleCenterChange}
              onSubdivide={handleSubdivide}
              pointPosition={pointPosition}
              pointCount={pointCount}
              onPointChange={handlePointChange}
              inputTransform={inputTransformFlat}
              onInputTransformChange={handleInputTransformChange}
              onInputTransformReset={handleInputTransformReset}
              onSliderDown={beginSliderInteraction}
              onSliderUp={endSliderInteraction}
            />

            {/* Pixel Mapping */}
            <div
              className={`border-b border-aura-border ${
                primaryLayer.pixelMap?.enabled
                  ? "border-l-2 border-l-indigo-500"
                  : ""
              }`}
            >
              <PixelMapSection
                pixelMap={primaryLayer.pixelMap}
                onPixelMapChange={(pm) => {
                  for (const id of effectiveSelectedIds) {
                    void setLayerPixelMap(id, pm);
                  }
                }}
                onSliderDown={beginSliderInteraction}
                onSliderUp={endSliderInteraction}
              />
            </div>

            {selectedGroup && (
              <div
                className={`border-b border-aura-border ${
                  selectedGroup.sharedInput?.enabled
                    ? "border-l-2 border-l-cyan-500"
                    : ""
                }`}
              >
                <SharedInputSection
                  sharedInput={selectedGroup.sharedInput}
                  defaultMapping={sharedInputDefault}
                  hasMixedSources={sharedInputHasMixedSources}
                  onSharedInputChange={(mapping) => {
                    void setGroupSharedInput(selectedGroup.id, mapping);
                  }}
                  onSliderDown={beginSliderInteraction}
                  onSliderUp={endSliderInteraction}
                />
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
            No layer selected
          </div>
        )}
      </div>
    </div>
  );
}

export default PropertiesPanel;

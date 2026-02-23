import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import type {
  BlendMode,
  InputTransform,
  LayerGeometry,
  LayerProperties,
  Point2D,
  UvAdjustment,
} from "../../types";
import { BLEND_MODES, DEFAULT_INPUT_TRANSFORM } from "../../types";

const DEFAULT_UV: UvAdjustment = { offset: [0, 0], rotation: 0, scale: [1, 1] };
const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;
const EPS = 1e-6;
const JOYSTICK_DEADZONE = 0.08;
const JOYSTICK_STEP = 0.012;

type GeomUi = {
  dx: number;
  dy: number;
  rotationDeg: number;
  sx: number;
  sy: number;
};

type GeomDelta = {
  dx: number;
  dy: number;
  dRotation: number;
  sx: number;
  sy: number;
};

const DEFAULT_GEOM_UI: GeomUi = {
  dx: 0,
  dy: 0,
  rotationDeg: 0,
  sx: 1,
  sy: 1,
};

function deltaFromUi(prev: GeomUi, next: GeomUi): GeomDelta {
  return {
    dx: next.dx - prev.dx,
    dy: next.dy - prev.dy,
    dRotation: (next.rotationDeg - prev.rotationDeg) * DEG_TO_RAD,
    sx: next.sx / Math.max(prev.sx, EPS),
    sy: next.sy / Math.max(prev.sy, EPS),
  };
}

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

function inputTransformEquals(a: InputTransform, b: InputTransform): boolean {
  return Math.abs(a.offset[0] - b.offset[0]) < EPS
    && Math.abs(a.offset[1] - b.offset[1]) < EPS
    && Math.abs(a.rotation - b.rotation) < EPS
    && Math.abs(a.scale[0] - b.scale[0]) < EPS
    && Math.abs(a.scale[1] - b.scale[1]) < EPS;
}

function PropertiesPanel() {
  const {
    project,
    layers,
    selectedLayerId,
    selectedLayerIds,
    updatePropertiesForSelection,
    connectSourceForSelection,
    disconnectSourceForSelection,
    setBlendModeForSelection,
    sources,
    selectedFaceIndices,
    setFaceUvOverride,
    clearFaceUvOverride,
    subdivideMesh,
    beginInteraction,
    setLayerInputTransform,
    applyGeometryDeltaToSelection,
    editorSelectionMode,
    setEditorSelectionMode,
  } = useAppStore();

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
  const selectedLayer = selectedLayerId
    ? selectedLayers.find((l) => l.id === selectedLayerId)
    : selectedLayers[0];
  const selectedCount = selectedLayers.length;
  const isMulti = selectedCount > 1;
  const outputWidth = Math.max(1, project?.output.width ?? 1);
  const outputHeight = Math.max(1, project?.output.height ?? 1);

  const [inputUi, setInputUi] = useState<InputTransform>(DEFAULT_INPUT_TRANSFORM);
  const [geomUi, setGeomUi] = useState<GeomUi>(DEFAULT_GEOM_UI);
  const [geomAbsUi, setGeomAbsUi] = useState({ xPx: "0", yPx: "0" });

  const interactionActiveRef = useRef(false);
  const geomAbsEditingRef = useRef({ x: false, y: false });
  const joystickRef = useRef<HTMLDivElement | null>(null);
  const joystickPointerIdRef = useRef<number | null>(null);
  const joystickRafRef = useRef<number | null>(null);
  const joystickVectorRef = useRef({ x: 0, y: 0 });

  const inputPendingRef = useRef<InputTransform | null>(null);
  const inputRafRef = useRef<number | null>(null);
  const inputInFlightRef = useRef(false);

  const geomPendingRef = useRef<GeomDelta | null>(null);
  const geomRafRef = useRef<number | null>(null);
  const geomInFlightRef = useRef(false);
  const geomAppliedUiRef = useRef<GeomUi>(DEFAULT_GEOM_UI);

  useEffect(() => {
    return () => {
      if (inputRafRef.current !== null) {
        cancelAnimationFrame(inputRafRef.current);
      }
      if (geomRafRef.current !== null) {
        cancelAnimationFrame(geomRafRef.current);
      }
      if (joystickRafRef.current !== null) {
        cancelAnimationFrame(joystickRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedLayer) return;

    setInputUi(selectedLayer.input_transform ?? DEFAULT_INPUT_TRANSFORM);
    setGeomUi(DEFAULT_GEOM_UI);
    geomAppliedUiRef.current = DEFAULT_GEOM_UI;

    inputPendingRef.current = null;
    geomPendingRef.current = null;

    if (inputRafRef.current !== null) {
      cancelAnimationFrame(inputRafRef.current);
      inputRafRef.current = null;
    }
    if (geomRafRef.current !== null) {
      cancelAnimationFrame(geomRafRef.current);
      geomRafRef.current = null;
    }
    if (joystickRafRef.current !== null) {
      cancelAnimationFrame(joystickRafRef.current);
      joystickRafRef.current = null;
    }
    joystickPointerIdRef.current = null;
    joystickVectorRef.current = { x: 0, y: 0 };

    interactionActiveRef.current = false;
  }, [selectedLayerId, selectedCount]);

  useEffect(() => {
    if (selectedLayers.length === 0) return;
    const center = geometrySelectionCenter(selectedLayers);
    const nextX = (center.x * outputWidth).toFixed(1);
    const nextY = (center.y * outputHeight).toFixed(1);
    setGeomAbsUi((prev) => {
      const xPx = geomAbsEditingRef.current.x ? prev.xPx : nextX;
      const yPx = geomAbsEditingRef.current.y ? prev.yPx : nextY;
      if (xPx === prev.xPx && yPx === prev.yPx) {
        return prev;
      }
      return { xPx, yPx };
    });
  }, [selectedLayers, outputWidth, outputHeight]);

  if (!selectedLayer) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-aura-text-dim p-4">
        Select one or more layers to edit properties
      </div>
    );
  }

  const props = selectedLayer.properties;
  const meshGeom = selectedLayer.geometry.type === "Mesh" ? selectedLayer.geometry : null;
  const isMesh = !!meshGeom;
  const meshData = meshGeom?.data ?? null;
  const selectionMode = isMulti ? "shape" : editorSelectionMode;
  const isUvMode = selectionMode === "uv";
  const secondaryModeLabel = isMesh ? "UV" : "Input";
  const facesSelected = !isMulti && selectedFaceIndices.length > 0;

  const firstFaceIdx = selectedFaceIndices[0] ?? -1;
  const currentUV: UvAdjustment =
    (firstFaceIdx >= 0 && meshData?.uv_overrides?.[firstFaceIdx]) || DEFAULT_UV;
  const uvRotDeg = (currentUV.rotation / TWO_PI) * 360;
  const geomCenterNorm = geometrySelectionCenter(selectedLayers);

  const sourceSet = new Set(selectedLayers.map((l) => l.source?.source_id ?? "__none__"));
  const sourceMixed = sourceSet.size > 1;
  const sharedSourceId = sourceMixed
    ? "__mixed__"
    : sourceSet.has("__none__")
      ? ""
      : selectedLayers[0]?.source?.source_id ?? "";

  const blendSet = new Set(selectedLayers.map((l) => l.blend_mode ?? "normal"));
  const blendMixed = blendSet.size > 1;
  const sharedBlend = blendMixed
    ? "__mixed__"
    : selectedLayers[0]?.blend_mode ?? "normal";
  const inputMixed = selectedLayers.some(
    (layer) => !inputTransformEquals(layer.input_transform ?? DEFAULT_INPUT_TRANSFORM, inputUi)
  );

  const beginSliderInteraction = () => {
    if (!interactionActiveRef.current) {
      interactionActiveRef.current = true;
      void beginInteraction();
    }
  };

  const endSliderInteraction = () => {
    interactionActiveRef.current = false;
  };

  const dispatchInput = () => {
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
  };

  const scheduleInput = (next: InputTransform, immediate = false) => {
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
  };

  const enqueueGeomDelta = (delta: GeomDelta, immediate = false) => {
    if (Math.abs(delta.dx) < EPS
      && Math.abs(delta.dy) < EPS
      && Math.abs(delta.dRotation) < EPS
      && Math.abs(delta.sx - 1) < EPS
      && Math.abs(delta.sy - 1) < EPS) {
      return;
    }

    if (!geomPendingRef.current) {
      geomPendingRef.current = { ...delta };
    } else {
      geomPendingRef.current.dx += delta.dx;
      geomPendingRef.current.dy += delta.dy;
      geomPendingRef.current.dRotation += delta.dRotation;
      geomPendingRef.current.sx *= delta.sx;
      geomPendingRef.current.sy *= delta.sy;
    }

    if (immediate) {
      if (geomRafRef.current !== null) {
        cancelAnimationFrame(geomRafRef.current);
        geomRafRef.current = null;
      }
      dispatchGeom();
      return;
    }

    if (geomRafRef.current === null) {
      geomRafRef.current = requestAnimationFrame(() => {
        geomRafRef.current = null;
        dispatchGeom();
      });
    }
  };

  const dispatchGeom = () => {
    if (geomInFlightRef.current) return;
    const pending = geomPendingRef.current;
    if (!pending) return;

    geomPendingRef.current = null;
    geomInFlightRef.current = true;
    void applyGeometryDeltaToSelection(pending).finally(() => {
      geomInFlightRef.current = false;
      if (geomPendingRef.current) {
        dispatchGeom();
      }
    });
  };

  const handlePropChange = (key: keyof LayerProperties, value: number) => {
    void updatePropertiesForSelection((current) => ({ ...current, [key]: value }));
  };

  const handlePropReset = (key: keyof LayerProperties) => {
    const defaults: LayerProperties = {
      brightness: 1.0,
      contrast: 1.0,
      gamma: 1.0,
      opacity: 1.0,
      feather: 0.0,
    };
    handlePropChange(key, defaults[key]);
  };

  const handleUVChange = (adj: UvAdjustment) => {
    for (const faceIdx of selectedFaceIndices) {
      void setFaceUvOverride(selectedLayer.id, faceIdx, adj);
    }
  };

  const handleUVReset = () => {
    for (const faceIdx of selectedFaceIndices) {
      void clearFaceUvOverride(selectedLayer.id, faceIdx);
    }
  };

  const setInputUiAndSend = (next: InputTransform, immediate = false) => {
    setInputUi(next);
    scheduleInput(next, immediate);
  };

  const handleInputPointerDown = () => {
    beginSliderInteraction();
  };

  const handleInputPointerUp = () => {
    scheduleInput(inputPendingRef.current ?? inputUi, true);
    endSliderInteraction();
  };

  const resetInputTransform = () => {
    beginSliderInteraction();
    setInputUiAndSend(DEFAULT_INPUT_TRANSFORM, true);
    endSliderInteraction();
  };

  const updateGeomUi = (patch: Partial<GeomUi>) => {
    setGeomUi((prev) => {
      const next = { ...prev, ...patch };
      const delta = deltaFromUi(geomAppliedUiRef.current, next);
      geomAppliedUiRef.current = next;
      enqueueGeomDelta(delta, false);
      return next;
    });
  };

  const handleGeomPointerDown = () => {
    beginSliderInteraction();
  };

  const handleGeomPointerUp = () => {
    dispatchGeom();
    setGeomUi(DEFAULT_GEOM_UI);
    geomAppliedUiRef.current = DEFAULT_GEOM_UI;
    endSliderInteraction();
  };

  const applyAbsoluteCenter = () => {
    const currentCenter = geometrySelectionCenter(selectedLayers);
    const parsedX = Number(geomAbsUi.xPx);
    const parsedY = Number(geomAbsUi.yPx);
    const nextXPx = Number.isFinite(parsedX) ? parsedX : currentCenter.x * outputWidth;
    const nextYPx = Number.isFinite(parsedY) ? parsedY : currentCenter.y * outputHeight;
    const dx = (nextXPx / outputWidth) - currentCenter.x;
    const dy = (nextYPx / outputHeight) - currentCenter.y;

    if (!Number.isFinite(parsedX) || !Number.isFinite(parsedY)) {
      setGeomAbsUi({
        xPx: nextXPx.toFixed(1),
        yPx: nextYPx.toFixed(1),
      });
    }

    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) {
      return;
    }

    beginSliderInteraction();
    enqueueGeomDelta({
      dx,
      dy,
      dRotation: 0,
      sx: 1,
      sy: 1,
    }, true);
    endSliderInteraction();
  };

  const setJoystickFromClient = (clientX: number, clientY: number) => {
    const node = joystickRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) * 0.5;
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;

    let nx = (clientX - cx) / Math.max(radius, EPS);
    let ny = (clientY - cy) / Math.max(radius, EPS);
    const mag = Math.hypot(nx, ny);
    if (mag > 1) {
      nx /= mag;
      ny /= mag;
    }
    if (mag < JOYSTICK_DEADZONE) {
      nx = 0;
      ny = 0;
    }

    joystickVectorRef.current = { x: nx, y: ny };
    setGeomUi((prev) => ({ ...prev, dx: nx, dy: ny }));
  };

  const stopJoystick = () => {
    if (joystickRafRef.current !== null) {
      cancelAnimationFrame(joystickRafRef.current);
      joystickRafRef.current = null;
    }
    joystickPointerIdRef.current = null;
    joystickVectorRef.current = { x: 0, y: 0 };
    setGeomUi((prev) => ({ ...prev, dx: 0, dy: 0 }));
    dispatchGeom();
    endSliderInteraction();
  };

  const tickJoystick = () => {
    const vec = joystickVectorRef.current;
    if (Math.abs(vec.x) > EPS || Math.abs(vec.y) > EPS) {
      enqueueGeomDelta(
        {
          dx: vec.x * JOYSTICK_STEP,
          dy: vec.y * JOYSTICK_STEP,
          dRotation: 0,
          sx: 1,
          sy: 1,
        },
        false
      );
    }
    joystickRafRef.current = requestAnimationFrame(tickJoystick);
  };

  const startJoystick = () => {
    if (joystickRafRef.current !== null) return;
    joystickRafRef.current = requestAnimationFrame(tickJoystick);
  };

  const handleJoystickPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    beginSliderInteraction();
    joystickPointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setJoystickFromClient(e.clientX, e.clientY);
    startJoystick();
  };

  const handleJoystickPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (joystickPointerIdRef.current !== e.pointerId) return;
    setJoystickFromClient(e.clientX, e.clientY);
  };

  const handleJoystickPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (joystickPointerIdRef.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    stopJoystick();
  };

  const controls: {
    key: keyof LayerProperties;
    label: string;
    min: number;
    max: number;
    step: number;
  }[] = [
    { key: "brightness", label: "Brightness", min: 0, max: 2, step: 0.01 },
    { key: "contrast", label: "Contrast", min: 0, max: 3, step: 0.01 },
    { key: "gamma", label: "Gamma", min: 0.1, max: 3, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
    { key: "feather", label: "Feather", min: 0, max: 1, step: 0.01 },
  ];
  const mixedPropKeys = new Set<keyof LayerProperties>();
  for (const { key } of controls) {
    if (selectedLayers.some((layer) => Math.abs(layer.properties[key] - props[key]) > EPS)) {
      mixedPropKeys.add(key);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-3 py-2 border-b border-aura-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
          Properties
        </span>
        <div className="mt-1">
          <span className="text-sm font-medium">{selectedLayer.name}</span>
          <span className="ml-2 text-xs text-aura-text-dim">
            ({selectedLayer.type})
          </span>
          {selectedCount > 1 && (
            <span className="ml-2 text-xs text-aura-text-dim">
              +{selectedCount - 1} selected
            </span>
          )}
        </div>
      </div>

      <div className="px-3 py-3 border-b border-aura-border">
        <label className="text-xs text-aura-text-dim block mb-1">Source</label>
        <select
          value={sharedSourceId}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "") {
              void disconnectSourceForSelection();
            } else {
              void connectSourceForSelection(val);
            }
          }}
          className="input w-full text-xs"
        >
          {sourceMixed && <option value="__mixed__" disabled>Mixed</option>}
          <option value="">None</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              [{s.protocol}] {s.name}
              {s.width && s.height ? ` (${s.width}x${s.height})` : ""}
            </option>
          ))}
        </select>
        {selectedLayers.some(
          (layer) => layer.source && !sources.find((s) => s.id === layer.source?.source_id)
        ) && (
            <div className="mt-1 text-xs text-aura-warning">
              One or more selected layers reference missing sources
            </div>
        )}
      </div>

      <div className="px-3 py-3 border-b border-aura-border">
        <label className="text-xs text-aura-text-dim block mb-1">Blend Mode</label>
        <select
          value={sharedBlend}
          onChange={(e) => void setBlendModeForSelection(e.target.value as BlendMode)}
          className="input w-full text-xs"
        >
          {blendMixed && <option value="__mixed__" disabled>Mixed</option>}
          {BLEND_MODES.map((bm) => (
            <option key={bm.value} value={bm.value}>
              {bm.label}
            </option>
          ))}
        </select>
      </div>

      <div className="px-3 py-3 border-b border-aura-border space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
            Input Transform
            {inputMixed && (
              <span className="ml-2 text-[11px] normal-case text-amber-300">Mixed</span>
            )}
          </span>
          <button
            onClick={resetInputTransform}
            className="text-xs text-aura-text-dim hover:text-aura-text"
            title="Reset input transform"
          >
            ↺ Reset
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Position X</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{inputUi.offset[0].toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.001}
            value={inputUi.offset[0]}
            onPointerDown={handleInputPointerDown}
            onPointerUp={handleInputPointerUp}
            onPointerCancel={handleInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                offset: [parseFloat(e.target.value), inputUi.offset[1]],
              };
              setInputUiAndSend(next, false);
            }}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Position Y</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{inputUi.offset[1].toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.001}
            value={inputUi.offset[1]}
            onPointerDown={handleInputPointerDown}
            onPointerUp={handleInputPointerUp}
            onPointerCancel={handleInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                offset: [inputUi.offset[0], parseFloat(e.target.value)],
              };
              setInputUiAndSend(next, false);
            }}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Rotation</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{(inputUi.rotation / TWO_PI * 360).toFixed(1)}°</span>
          </div>
          <input
            type="range"
            min={-180}
            max={180}
            step={0.1}
            value={(inputUi.rotation / TWO_PI) * 360}
            onPointerDown={handleInputPointerDown}
            onPointerUp={handleInputPointerUp}
            onPointerCancel={handleInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                rotation: parseFloat(e.target.value) * DEG_TO_RAD,
              };
              setInputUiAndSend(next, false);
            }}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Scale X</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{inputUi.scale[0].toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.001}
            value={inputUi.scale[0]}
            onPointerDown={handleInputPointerDown}
            onPointerUp={handleInputPointerUp}
            onPointerCancel={handleInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                scale: [parseFloat(e.target.value), inputUi.scale[1]],
              };
              setInputUiAndSend(next, false);
            }}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Scale Y</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{inputUi.scale[1].toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.001}
            value={inputUi.scale[1]}
            onPointerDown={handleInputPointerDown}
            onPointerUp={handleInputPointerUp}
            onPointerCancel={handleInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                scale: [inputUi.scale[0], parseFloat(e.target.value)],
              };
              setInputUiAndSend(next, false);
            }}
            className="slider"
          />
        </div>
      </div>

      <div className="px-3 py-3 border-b border-aura-border space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">Geometry Transform</span>
          <span className="text-[11px] text-aura-text-dim">Joystick + Absolute</span>
        </div>

        <div className="rounded-md border border-aura-border/70 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-aura-text-dim">Absolute Center (canvas px)</span>
            <button
              onClick={applyAbsoluteCenter}
              className="text-xs text-aura-text-dim hover:text-aura-text"
              title="Apply absolute center position"
            >
              Apply
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-aura-text-dim block mb-1">X</label>
              <input
                type="number"
                step={0.1}
                value={geomAbsUi.xPx}
                onFocus={() => {
                  geomAbsEditingRef.current.x = true;
                }}
                onBlur={() => {
                  geomAbsEditingRef.current.x = false;
                  applyAbsoluteCenter();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    setGeomAbsUi({
                      xPx: (geomCenterNorm.x * outputWidth).toFixed(1),
                      yPx: (geomCenterNorm.y * outputHeight).toFixed(1),
                    });
                    e.currentTarget.blur();
                  }
                }}
                onChange={(e) => setGeomAbsUi((prev) => ({ ...prev, xPx: e.target.value }))}
                className="input w-full text-xs py-1"
              />
            </div>
            <div>
              <label className="text-[11px] text-aura-text-dim block mb-1">Y</label>
              <input
                type="number"
                step={0.1}
                value={geomAbsUi.yPx}
                onFocus={() => {
                  geomAbsEditingRef.current.y = true;
                }}
                onBlur={() => {
                  geomAbsEditingRef.current.y = false;
                  applyAbsoluteCenter();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    setGeomAbsUi({
                      xPx: (geomCenterNorm.x * outputWidth).toFixed(1),
                      yPx: (geomCenterNorm.y * outputHeight).toFixed(1),
                    });
                    e.currentTarget.blur();
                  }
                }}
                onChange={(e) => setGeomAbsUi((prev) => ({ ...prev, yPx: e.target.value }))}
                className="input w-full text-xs py-1"
              />
            </div>
          </div>
          <div className="text-[11px] text-aura-text-dim">
            Canvas {outputWidth}x{outputHeight} | Normalized center {geomCenterNorm.x.toFixed(4)}, {geomCenterNorm.y.toFixed(4)}
          </div>
        </div>

        <div className="rounded-md border border-aura-border/70 p-2">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-aura-text-dim">Position Joystick</label>
            <span className="text-xs font-mono text-aura-text">
              {geomUi.dx.toFixed(2)}, {geomUi.dy.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-center">
            <div
              ref={joystickRef}
              onPointerDown={handleJoystickPointerDown}
              onPointerMove={handleJoystickPointerMove}
              onPointerUp={handleJoystickPointerUp}
              onPointerCancel={handleJoystickPointerUp}
              onLostPointerCapture={stopJoystick}
              className="relative w-24 h-24 rounded-full border border-aura-border bg-aura-hover/40 touch-none select-none cursor-grab active:cursor-grabbing"
            >
              <div className="absolute inset-1 rounded-full border border-aura-border/50" />
              <div
                className="absolute left-1/2 top-1/2 w-8 h-8 -ml-4 -mt-4 rounded-full border border-aura-border bg-aura-surface shadow"
                style={{
                  transform: `translate(${geomUi.dx * 28}px, ${geomUi.dy * 28}px)`,
                }}
              />
            </div>
          </div>
          <div className="mt-2 text-[11px] text-aura-text-dim text-center">
            Hold and drag. Release springs back to center.
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Rotation</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{geomUi.rotationDeg.toFixed(1)}°</span>
          </div>
          <input
            type="range"
            min={-180}
            max={180}
            step={0.1}
            value={geomUi.rotationDeg}
            onPointerDown={handleGeomPointerDown}
            onPointerUp={handleGeomPointerUp}
            onPointerCancel={handleGeomPointerUp}
            onChange={(e) => updateGeomUi({ rotationDeg: parseFloat(e.target.value) })}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Scale X</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{geomUi.sx.toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.001}
            value={geomUi.sx}
            onPointerDown={handleGeomPointerDown}
            onPointerUp={handleGeomPointerUp}
            onPointerCancel={handleGeomPointerUp}
            onChange={(e) => updateGeomUi({ sx: parseFloat(e.target.value) })}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Scale Y</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{geomUi.sy.toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.001}
            value={geomUi.sy}
            onPointerDown={handleGeomPointerDown}
            onPointerUp={handleGeomPointerUp}
            onPointerCancel={handleGeomPointerUp}
            onChange={(e) => updateGeomUi({ sy: parseFloat(e.target.value) })}
            className="slider"
          />
        </div>
      </div>

      <div className="px-3 py-3 space-y-4 border-b border-aura-border">
        {controls.map(({ key, label, min, max, step }) => (
          <div key={key}>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-aura-text-dim">{label}</label>
              <div className="flex items-center gap-1">
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {mixedPropKeys.has(key) ? "Mixed" : props[key].toFixed(2)}
                </span>
                <button
                  onClick={() => handlePropReset(key)}
                  className="text-xs text-aura-text-dim hover:text-aura-text px-1"
                  title="Reset to default"
                >
                  ↺
                </button>
              </div>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={props[key]}
              onChange={(e) => handlePropChange(key, parseFloat(e.target.value))}
              className="slider"
            />
          </div>
        ))}
      </div>

      <div className="px-3 py-3 border-b border-aura-border">
        <span className="text-xs text-aura-text-dim">Geometry</span>
        <div className="mt-1 text-xs font-mono text-aura-text-dim">
          {isMulti && `${selectedCount} layers selected (primary shown below)`}
          {isMulti && <br />}
          {selectedLayer.geometry.type === "Quad" && "4-point warp"}
          {selectedLayer.geometry.type === "Triangle" && "3-point warp"}
          {selectedLayer.geometry.type === "Mesh"
            && `Grid ${selectedLayer.geometry.data.cols}×${selectedLayer.geometry.data.rows}`}
          {selectedLayer.geometry.type === "Circle" && "Ellipse mask"}
        </div>
      </div>

      <div className="px-3 py-3 border-b border-aura-border">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
            Selection Mode
          </span>
          <span className="text-[11px] text-aura-text-dim">Tab</span>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => setEditorSelectionMode("shape")}
            className={`btn text-xs py-1 ${
              selectionMode === "shape"
                ? "bg-indigo-600 text-white"
                : "bg-aura-hover text-aura-text-dim"
            }`}
          >
            Shape
          </button>
          <button
            onClick={() => setEditorSelectionMode("uv")}
            disabled={isMulti}
            className={`btn text-xs py-1 ${
              selectionMode === "uv"
                ? (isMesh ? "bg-amber-600 text-white" : "bg-cyan-600 text-white")
                : "bg-aura-hover text-aura-text-dim"
            } ${isMulti ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            {secondaryModeLabel}
          </button>
        </div>
        <div className="mt-2 text-[11px] text-aura-text-dim">
          {isMulti
            ? "Multi-selection: Shape mode only"
            : !isUvMode
            ? "Point/shape controls active"
            : isMesh
              ? "Face selection and UV controls active"
              : "Input pan mode active (drag layer in preview)"}
        </div>
      </div>

      {!isMulti && isMesh && meshData && (
        <div className="px-3 py-3 border-b border-aura-border">
          <div className="flex items-center justify-between">
            <span className="text-xs text-aura-text-dim">Subdivide</span>
            <span className="text-xs font-mono text-aura-text-dim">
              {meshData.cols}×{meshData.rows} → {meshData.cols * 2}×{meshData.rows * 2}
            </span>
          </div>
          <button
            onClick={() => void subdivideMesh(selectedLayer.id)}
            className="btn text-xs mt-2 w-full py-1"
          >
            Subdivide Mesh
          </button>
        </div>
      )}

      {isMesh && isUvMode && facesSelected && (
        <div className="px-3 py-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
              Face UV
              {selectedFaceIndices.length > 1 && (
                <span className="ml-1 normal-case font-normal text-aura-text-dim">
                  ({selectedFaceIndices.length} faces)
                </span>
              )}
            </span>
            <button
              onClick={handleUVReset}
              className="text-xs text-aura-text-dim hover:text-aura-text"
              title="Reset UV to default"
            >
              ↺ Reset
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Offset X</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {currentUV.offset[0].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={currentUV.offset[0]}
                onMouseDown={() => void beginInteraction()}
                onChange={(e) => handleUVChange({
                  ...currentUV,
                  offset: [parseFloat(e.target.value), currentUV.offset[1]],
                })}
                className="slider"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Offset Y</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {currentUV.offset[1].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={currentUV.offset[1]}
                onMouseDown={() => void beginInteraction()}
                onChange={(e) => handleUVChange({
                  ...currentUV,
                  offset: [currentUV.offset[0], parseFloat(e.target.value)],
                })}
                className="slider"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Rotation</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {uvRotDeg.toFixed(0)}°
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={uvRotDeg}
                onMouseDown={() => void beginInteraction()}
                onChange={(e) => handleUVChange({
                  ...currentUV,
                  rotation: (parseFloat(e.target.value) / 360) * TWO_PI,
                })}
                className="slider"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Scale X</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {currentUV.scale[0].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.01}
                value={currentUV.scale[0]}
                onMouseDown={() => void beginInteraction()}
                onChange={(e) => handleUVChange({
                  ...currentUV,
                  scale: [parseFloat(e.target.value), currentUV.scale[1]],
                })}
                className="slider"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-aura-text-dim">Scale Y</label>
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {currentUV.scale[1].toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.01}
                value={currentUV.scale[1]}
                onMouseDown={() => void beginInteraction()}
                onChange={(e) => handleUVChange({
                  ...currentUV,
                  scale: [currentUV.scale[0], parseFloat(e.target.value)],
                })}
                className="slider"
              />
            </div>
          </div>
        </div>
      )}

      {isMesh && isUvMode && !facesSelected && (
        <div className="px-3 py-3 text-xs text-aura-text-dim">
          Click one or more mesh faces in the canvas to edit UV.
        </div>
      )}
    </div>
  );
}

export default PropertiesPanel;

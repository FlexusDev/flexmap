import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import type {
  BlendMode,
  InputTransform,
  LayerProperties,
  UvAdjustment,
} from "../../types";
import { BLEND_MODES, DEFAULT_INPUT_TRANSFORM } from "../../types";

const DEFAULT_UV: UvAdjustment = { offset: [0, 0], rotation: 0, scale: [1, 1] };
const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;
const EPS = 1e-6;

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

function PropertiesPanel() {
  const {
    layers,
    selectedLayerId,
    updateProperties,
    connectSource,
    disconnectSource,
    setBlendMode,
    sources,
    selectedFaceIndices,
    setFaceUvOverride,
    clearFaceUvOverride,
    subdivideMesh,
    beginInteraction,
    setLayerInputTransform,
    applyGeometryTransformDelta,
    editorSelectionMode,
    setEditorSelectionMode,
  } = useAppStore();

  const selectedLayer = layers.find((l) => l.id === selectedLayerId);

  const [inputUi, setInputUi] = useState<InputTransform>(DEFAULT_INPUT_TRANSFORM);
  const [geomUi, setGeomUi] = useState<GeomUi>(DEFAULT_GEOM_UI);

  const interactionActiveRef = useRef(false);

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

    interactionActiveRef.current = false;
  }, [selectedLayer]);

  if (!selectedLayer) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-aura-text-dim p-4">
        Select a layer to edit its properties
      </div>
    );
  }

  const props = selectedLayer.properties;
  const meshGeom = selectedLayer.geometry.type === "Mesh" ? selectedLayer.geometry : null;
  const isMesh = !!meshGeom;
  const meshData = meshGeom?.data ?? null;
  const selectionMode = editorSelectionMode;
  const isUvMode = selectionMode === "uv";
  const secondaryModeLabel = isMesh ? "UV" : "Input";
  const facesSelected = selectedFaceIndices.length > 0;

  const firstFaceIdx = selectedFaceIndices[0] ?? -1;
  const currentUV: UvAdjustment =
    (firstFaceIdx >= 0 && meshData?.uv_overrides?.[firstFaceIdx]) || DEFAULT_UV;
  const uvRotDeg = (currentUV.rotation / TWO_PI) * 360;

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
    void setLayerInputTransform(selectedLayer.id, next).finally(() => {
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
    void applyGeometryTransformDelta(selectedLayer.id, pending).finally(() => {
      geomInFlightRef.current = false;
      if (geomPendingRef.current) {
        dispatchGeom();
      }
    });
  };

  const handlePropChange = (key: keyof LayerProperties, value: number) => {
    void updateProperties(selectedLayer.id, { ...props, [key]: value });
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
        </div>
      </div>

      <div className="px-3 py-3 border-b border-aura-border">
        <label className="text-xs text-aura-text-dim block mb-1">Source</label>
        <select
          value={selectedLayer.source?.source_id ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "") {
              void disconnectSource(selectedLayer.id);
            } else {
              void connectSource(selectedLayer.id, val);
            }
          }}
          className="input w-full text-xs"
        >
          <option value="">None</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              [{s.protocol}] {s.name}
              {s.width && s.height ? ` (${s.width}x${s.height})` : ""}
            </option>
          ))}
        </select>
        {selectedLayer.source
          && !sources.find((s) => s.id === selectedLayer.source?.source_id) && (
            <div className="mt-1 text-xs text-aura-warning">
              Source missing: {selectedLayer.source.display_name}
            </div>
        )}
      </div>

      <div className="px-3 py-3 border-b border-aura-border">
        <label className="text-xs text-aura-text-dim block mb-1">Blend Mode</label>
        <select
          value={selectedLayer.blend_mode ?? "normal"}
          onChange={(e) => void setBlendMode(selectedLayer.id, e.target.value as BlendMode)}
          className="input w-full text-xs"
        >
          {BLEND_MODES.map((bm) => (
            <option key={bm.value} value={bm.value}>
              {bm.label}
            </option>
          ))}
        </select>
      </div>

      <div className="px-3 py-3 border-b border-aura-border space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">Input Transform</span>
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
          <span className="text-[11px] text-aura-text-dim">Incremental (auto-reset)</span>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Position X</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{geomUi.dx.toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={-0.5}
            max={0.5}
            step={0.001}
            value={geomUi.dx}
            onPointerDown={handleGeomPointerDown}
            onPointerUp={handleGeomPointerUp}
            onPointerCancel={handleGeomPointerUp}
            onChange={(e) => updateGeomUi({ dx: parseFloat(e.target.value) })}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Position Y</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{geomUi.dy.toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={-0.5}
            max={0.5}
            step={0.001}
            value={geomUi.dy}
            onPointerDown={handleGeomPointerDown}
            onPointerUp={handleGeomPointerUp}
            onPointerCancel={handleGeomPointerUp}
            onChange={(e) => updateGeomUi({ dy: parseFloat(e.target.value) })}
            className="slider"
          />
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
                  {props[key].toFixed(2)}
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
            className={`btn text-xs py-1 ${
              selectionMode === "uv"
                ? (isMesh ? "bg-amber-600 text-white" : "bg-cyan-600 text-white")
                : "bg-aura-hover text-aura-text-dim"
            }`}
          >
            {secondaryModeLabel}
          </button>
        </div>
        <div className="mt-2 text-[11px] text-aura-text-dim">
          {!isUvMode
            ? "Point/shape controls active"
            : isMesh
              ? "Face selection and UV controls active"
              : "Input pan mode active (drag layer in preview)"}
        </div>
      </div>

      {isMesh && meshData && (
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

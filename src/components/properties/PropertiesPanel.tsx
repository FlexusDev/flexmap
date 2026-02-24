import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
} from "react-resizable-panels";
import type { Layout, PanelSize } from "react-resizable-panels";
import { useAppStore } from "../../store/useAppStore";
import type {
  InputTransform,
  LayerGeometry,
  LayerProperties,
  Point2D,
  UvAdjustment,
} from "../../types";
import { DEFAULT_INPUT_TRANSFORM } from "../../types";
import InspectorPane from "./InspectorPane";
import AssignmentPane from "./panes/AssignmentPane";
import TransformPane from "./panes/TransformPane";
import LookPane, { type LookControl, type LookNumericKey } from "./panes/LookPane";
import GeometryUvPane from "./panes/GeometryUvPane";

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

type PropertiesSectionId = "assignment" | "transform" | "look" | "geometryUv";

const DEFAULT_GEOM_UI: GeomUi = {
  dx: 0,
  dy: 0,
  rotationDeg: 0,
  sx: 1,
  sy: 1,
};

const PROPERTIES_PANEL_IDS: Record<PropertiesSectionId, string> = {
  assignment: "properties-assignment",
  transform: "properties-transform",
  look: "properties-look",
  geometryUv: "properties-geometry-uv",
};

const PROPERTIES_SECTIONS: PropertiesSectionId[] = [
  "assignment",
  "transform",
  "look",
  "geometryUv",
];

const PROPERTIES_SECTION_DEFAULT_PX: Record<PropertiesSectionId, number> = {
  assignment: 180,
  transform: 320,
  look: 220,
  geometryUv: 260,
};

const PROPERTIES_SECTION_MIN_PX = 96;
const PROPERTIES_SECTION_COLLAPSED_PX = 40;

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

  const assignmentPanelRef = usePanelRef();
  const transformPanelRef = usePanelRef();
  const lookPanelRef = usePanelRef();
  const geometryUvPanelRef = usePanelRef();

  const [collapsedSections, setCollapsedSections] = useState<Record<PropertiesSectionId, boolean>>({
    assignment: false,
    transform: false,
    look: false,
    geometryUv: false,
  });
  const [activeSection, setActiveSection] = useState<PropertiesSectionId>("transform");

  const fallbackInspectorLayout = useMemo<Layout>(() => {
    const total = Object.values(PROPERTIES_SECTION_DEFAULT_PX).reduce((sum, value) => sum + value, 0);
    return {
      [PROPERTIES_PANEL_IDS.assignment]:
        (PROPERTIES_SECTION_DEFAULT_PX.assignment / total) * 100,
      [PROPERTIES_PANEL_IDS.transform]:
        (PROPERTIES_SECTION_DEFAULT_PX.transform / total) * 100,
      [PROPERTIES_PANEL_IDS.look]:
        (PROPERTIES_SECTION_DEFAULT_PX.look / total) * 100,
      [PROPERTIES_PANEL_IDS.geometryUv]:
        (PROPERTIES_SECTION_DEFAULT_PX.geometryUv / total) * 100,
    };
  }, []);

  const { defaultLayout: persistedInspectorLayout, onLayoutChanged: onInspectorLayoutChanged } =
    useDefaultLayout({
      id: "flexmap-properties-v2",
      panelIds: PROPERTIES_SECTIONS.map((sectionId) => PROPERTIES_PANEL_IDS[sectionId]),
      storage: localStorage,
    });

  const inspectorLayout = persistedInspectorLayout ?? fallbackInspectorLayout;

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
    const raf = requestAnimationFrame(() => {
      setCollapsedSections({
        assignment: assignmentPanelRef.current?.isCollapsed() ?? false,
        transform: transformPanelRef.current?.isCollapsed() ?? false,
        look: lookPanelRef.current?.isCollapsed() ?? false,
        geometryUv: geometryUvPanelRef.current?.isCollapsed() ?? false,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [inspectorLayout, assignmentPanelRef, transformPanelRef, lookPanelRef, geometryUvPanelRef]);

  useEffect(() => {
    if (!collapsedSections[activeSection]) return;
    const fallback = PROPERTIES_SECTIONS.find((sectionId) => !collapsedSections[sectionId]);
    if (fallback) {
      setActiveSection(fallback);
    }
  }, [activeSection, collapsedSections]);

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

  const handlePropChange = (key: LookNumericKey, value: number) => {
    void updatePropertiesForSelection((current) => ({ ...current, [key]: value }));
  };

  const handlePropReset = (key: LookNumericKey) => {
    const defaults: LayerProperties = {
      brightness: 1.0,
      contrast: 1.0,
      gamma: 1.0,
      opacity: 1.0,
      feather: 0.0,
      beatReactive: false,
      beatAmount: 0.0,
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

  const handleJoystickPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    beginSliderInteraction();
    joystickPointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setJoystickFromClient(e.clientX, e.clientY);
    startJoystick();
  };

  const handleJoystickPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (joystickPointerIdRef.current !== e.pointerId) return;
    setJoystickFromClient(e.clientX, e.clientY);
  };

  const handleJoystickPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (joystickPointerIdRef.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    stopJoystick();
  };

  const controls: LookControl[] = [
    { key: "brightness", label: "Brightness", min: 0, max: 2, step: 0.01 },
    { key: "contrast", label: "Contrast", min: 0, max: 3, step: 0.01 },
    { key: "gamma", label: "Gamma", min: 0.1, max: 3, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
    { key: "feather", label: "Feather", min: 0, max: 1, step: 0.01 },
  ];
  const mixedPropKeys = new Set<LookNumericKey>();
  for (const { key } of controls) {
    if (selectedLayers.some((layer) => Math.abs(layer.properties[key] - props[key]) > EPS)) {
      mixedPropKeys.add(key);
    }
  }
  const beatEligible = selectedLayers.every((layer) => layer.source?.protocol === "shader");
  const beatReactiveMixed = selectedLayers.some(
    (layer) => layer.properties.beatReactive !== props.beatReactive
  );
  const beatAmountMixed = selectedLayers.some(
    (layer) => Math.abs(layer.properties.beatAmount - props.beatAmount) > EPS
  );

  const hasMissingSource = selectedLayers.some(
    (layer) => layer.source && !sources.find((source) => source.id === layer.source?.source_id)
  );

  const geometrySummaryLines: string[] = [];
  if (isMulti) {
    geometrySummaryLines.push(`${selectedCount} layers selected (primary shown below)`);
  }
  if (selectedLayer.geometry.type === "Quad") {
    geometrySummaryLines.push("4-point warp");
  } else if (selectedLayer.geometry.type === "Triangle") {
    geometrySummaryLines.push("3-point warp");
  } else if (selectedLayer.geometry.type === "Mesh") {
    geometrySummaryLines.push(`Grid ${selectedLayer.geometry.data.cols}×${selectedLayer.geometry.data.rows}`);
  } else {
    geometrySummaryLines.push("Ellipse mask");
  }

  const assignmentStatus = selectedCount > 1
    ? `${selectedCount} layers selected`
    : selectedLayer.type;
  const transformStatus = inputMixed ? "Mixed input values" : "Input + Geometry";
  const lookStatus = mixedPropKeys.size > 0
    ? "Mixed values"
    : beatEligible
      ? "Color + Beat"
      : "Color + Opacity";
  const geometryUvStatus = isMesh
    ? (isUvMode ? "Mesh UV mode" : "Mesh shape mode")
    : "Non-mesh layer";

  const getPanelHandle = (sectionId: PropertiesSectionId) => {
    if (sectionId === "assignment") return assignmentPanelRef.current;
    if (sectionId === "transform") return transformPanelRef.current;
    if (sectionId === "look") return lookPanelRef.current;
    return geometryUvPanelRef.current;
  };

  const updateSectionCollapsed = (sectionId: PropertiesSectionId, collapsed: boolean) => {
    setCollapsedSections((prev) => {
      if (prev[sectionId] === collapsed) return prev;
      return { ...prev, [sectionId]: collapsed };
    });
  };

  const setSectionCollapsed = (sectionId: PropertiesSectionId, collapsed: boolean) => {
    const handle = getPanelHandle(sectionId);
    if (!handle) return;
    if (collapsed) {
      if (!handle.isCollapsed()) {
        handle.collapse();
      }
      updateSectionCollapsed(sectionId, true);
      return;
    }
    if (handle.isCollapsed()) {
      handle.expand();
    }
    updateSectionCollapsed(sectionId, false);
  };

  const focusSection = (sectionId: PropertiesSectionId) => {
    PROPERTIES_SECTIONS.forEach((id) => {
      setSectionCollapsed(id, id !== sectionId);
    });
    setActiveSection(sectionId);
    requestAnimationFrame(() => {
      getPanelHandle(sectionId)?.resize("100%");
    });
  };

  const handleSectionResize = (sectionId: PropertiesSectionId, panelSize: PanelSize) => {
    const collapsed = panelSize.inPixels <= PROPERTIES_SECTION_COLLAPSED_PX + 1;
    updateSectionCollapsed(sectionId, collapsed);
  };

  const toggleSectionCollapsed = (sectionId: PropertiesSectionId) => {
    const isCollapsed = collapsedSections[sectionId];
    setSectionCollapsed(sectionId, !isCollapsed);
    if (!isCollapsed) {
      const nextActive = PROPERTIES_SECTIONS.find(
        (id) => id !== sectionId && !collapsedSections[id]
      );
      if (nextActive) {
        setActiveSection(nextActive);
      }
      return;
    }
    setActiveSection(sectionId);
  };

  const handleSectionHeaderClick = (sectionId: PropertiesSectionId) => {
    if (collapsedSections[sectionId]) {
      focusSection(sectionId);
      return;
    }
    setActiveSection(sectionId);
  };

  const handleSourceChange = (sourceId: string) => {
    if (sourceId === "") {
      void disconnectSourceForSelection();
    } else {
      void connectSourceForSelection(sourceId);
    }
  };

  const handleSelectionModeChange = (mode: "shape" | "uv") => {
    if (mode === "uv" && isMulti) return;
    setEditorSelectionMode(mode);
  };

  const handleGeomAbsFocus = (axis: "x" | "y") => {
    geomAbsEditingRef.current[axis] = true;
  };

  const handleGeomAbsBlur = (axis: "x" | "y") => {
    geomAbsEditingRef.current[axis] = false;
    applyAbsoluteCenter();
  };

  const handleGeomAbsKeyDown = (
    _axis: "x" | "y",
    event: KeyboardEvent<HTMLInputElement>
  ) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      setGeomAbsUi({
        xPx: (geomCenterNorm.x * outputWidth).toFixed(1),
        yPx: (geomCenterNorm.y * outputHeight).toFixed(1),
      });
      event.currentTarget.blur();
    }
  };

  const handleGeomAbsChange = (axis: "x" | "y", value: string) => {
    setGeomAbsUi((prev) => (
      axis === "x"
        ? { ...prev, xPx: value }
        : { ...prev, yPx: value }
    ));
  };

  const beginUvInteraction = () => {
    void beginInteraction();
  };

  const renderSectionPanel = (sectionId: PropertiesSectionId) => {
    if (sectionId === "assignment") {
      return (
        <Panel
          id={PROPERTIES_PANEL_IDS.assignment}
          panelRef={assignmentPanelRef}
          defaultSize={PROPERTIES_SECTION_DEFAULT_PX.assignment}
          minSize={PROPERTIES_SECTION_MIN_PX}
          collapsible
          collapsedSize={PROPERTIES_SECTION_COLLAPSED_PX}
          onResize={(panelSize) => handleSectionResize("assignment", panelSize)}
          className="min-h-0"
        >
          <InspectorPane
            title="Assignment"
            status={assignmentStatus}
            active={activeSection === "assignment"}
            collapsed={collapsedSections.assignment}
            onHeaderClick={() => handleSectionHeaderClick("assignment")}
            onToggleCollapsed={() => toggleSectionCollapsed("assignment")}
          >
            <div className="px-3 py-3">
              <AssignmentPane
                sharedSourceId={sharedSourceId}
                sourceMixed={sourceMixed}
                sources={sources}
                hasMissingSource={hasMissingSource}
                onSourceChange={handleSourceChange}
                sharedBlend={sharedBlend}
                blendMixed={blendMixed}
                onBlendChange={(blendMode) => void setBlendModeForSelection(blendMode)}
                selectionMode={selectionMode}
                isMulti={isMulti}
                isMesh={isMesh}
                secondaryModeLabel={secondaryModeLabel}
                onSelectionModeChange={handleSelectionModeChange}
              />
            </div>
          </InspectorPane>
        </Panel>
      );
    }

    if (sectionId === "transform") {
      return (
        <Panel
          id={PROPERTIES_PANEL_IDS.transform}
          panelRef={transformPanelRef}
          defaultSize={PROPERTIES_SECTION_DEFAULT_PX.transform}
          minSize={PROPERTIES_SECTION_MIN_PX}
          collapsible
          collapsedSize={PROPERTIES_SECTION_COLLAPSED_PX}
          onResize={(panelSize) => handleSectionResize("transform", panelSize)}
          className="min-h-0"
        >
          <InspectorPane
            title="Transform"
            status={transformStatus}
            active={activeSection === "transform"}
            collapsed={collapsedSections.transform}
            onHeaderClick={() => handleSectionHeaderClick("transform")}
            onToggleCollapsed={() => toggleSectionCollapsed("transform")}
          >
            <div className="px-3 py-3">
              <TransformPane
                inputMixed={inputMixed}
                inputUi={inputUi}
                onResetInputTransform={resetInputTransform}
                onInputPointerDown={handleInputPointerDown}
                onInputPointerUp={handleInputPointerUp}
                onInputChange={(next) => setInputUiAndSend(next, false)}
                geomAbsUi={geomAbsUi}
                onGeomAbsFocus={handleGeomAbsFocus}
                onGeomAbsBlur={handleGeomAbsBlur}
                onGeomAbsKeyDown={handleGeomAbsKeyDown}
                onGeomAbsChange={handleGeomAbsChange}
                onApplyAbsoluteCenter={applyAbsoluteCenter}
                geomCenterNorm={geomCenterNorm}
                outputWidth={outputWidth}
                outputHeight={outputHeight}
                geomUi={geomUi}
                onGeomUiChange={updateGeomUi}
                onGeomPointerDown={handleGeomPointerDown}
                onGeomPointerUp={handleGeomPointerUp}
                joystickRef={joystickRef}
                onJoystickPointerDown={handleJoystickPointerDown}
                onJoystickPointerMove={handleJoystickPointerMove}
                onJoystickPointerUp={handleJoystickPointerUp}
                onJoystickLostPointerCapture={stopJoystick}
              />
            </div>
          </InspectorPane>
        </Panel>
      );
    }

    if (sectionId === "look") {
      return (
        <Panel
          id={PROPERTIES_PANEL_IDS.look}
          panelRef={lookPanelRef}
          defaultSize={PROPERTIES_SECTION_DEFAULT_PX.look}
          minSize={PROPERTIES_SECTION_MIN_PX}
          collapsible
          collapsedSize={PROPERTIES_SECTION_COLLAPSED_PX}
          onResize={(panelSize) => handleSectionResize("look", panelSize)}
          className="min-h-0"
        >
          <InspectorPane
            title="Look"
            status={lookStatus}
            active={activeSection === "look"}
            collapsed={collapsedSections.look}
            onHeaderClick={() => handleSectionHeaderClick("look")}
            onToggleCollapsed={() => toggleSectionCollapsed("look")}
          >
            <div className="px-3 py-3">
              <LookPane
                controls={controls}
                properties={props}
                mixedPropKeys={mixedPropKeys}
                onPropChange={handlePropChange}
                onPropReset={handlePropReset}
                beatEligible={beatEligible}
                beatReactive={props.beatReactive}
                beatAmount={props.beatAmount}
                beatReactiveMixed={beatReactiveMixed}
                beatAmountMixed={beatAmountMixed}
                onBeatReactiveChange={(value) =>
                  void updatePropertiesForSelection((current) => ({
                    ...current,
                    beatReactive: value,
                  }))
                }
                onBeatAmountChange={(value) =>
                  void updatePropertiesForSelection((current) => ({
                    ...current,
                    beatAmount: value,
                  }))
                }
              />
            </div>
          </InspectorPane>
        </Panel>
      );
    }

    return (
      <Panel
        id={PROPERTIES_PANEL_IDS.geometryUv}
        panelRef={geometryUvPanelRef}
        defaultSize={PROPERTIES_SECTION_DEFAULT_PX.geometryUv}
        minSize={PROPERTIES_SECTION_MIN_PX}
        collapsible
        collapsedSize={PROPERTIES_SECTION_COLLAPSED_PX}
        onResize={(panelSize) => handleSectionResize("geometryUv", panelSize)}
        className="min-h-0"
      >
        <InspectorPane
          title="Geometry & UV"
          status={geometryUvStatus}
          active={activeSection === "geometryUv"}
          collapsed={collapsedSections.geometryUv}
          onHeaderClick={() => handleSectionHeaderClick("geometryUv")}
          onToggleCollapsed={() => toggleSectionCollapsed("geometryUv")}
        >
          <div className="px-3 py-3">
            <GeometryUvPane
              geometrySummaryLines={geometrySummaryLines}
              isMesh={isMesh}
              meshDims={meshData ? { cols: meshData.cols, rows: meshData.rows } : null}
              canSubdivide={!isMulti && isMesh && !!meshData}
              onSubdivide={() => void subdivideMesh(selectedLayer.id)}
              isUvMode={isUvMode}
              facesSelected={facesSelected}
              selectedFaceIndices={selectedFaceIndices}
              currentUV={currentUV}
              uvRotDeg={uvRotDeg}
              onUVReset={handleUVReset}
              onUVChange={handleUVChange}
              onBeginInteraction={beginUvInteraction}
            />
          </div>
        </InspectorPane>
      </Panel>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
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

      <Group
        orientation="vertical"
        className="properties-inspector-group flex-1 min-h-0"
        defaultLayout={inspectorLayout}
        onLayoutChanged={onInspectorLayoutChanged}
      >
        {renderSectionPanel("assignment")}
        <Separator />
        {renderSectionPanel("transform")}
        <Separator />
        {renderSectionPanel("look")}
        <Separator />
        {renderSectionPanel("geometryUv")}
      </Group>
    </div>
  );
}

export default PropertiesPanel;

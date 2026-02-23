import { create } from "zustand";
import { tauriInvoke } from "../lib/tauri-bridge";
import type {
  Layer,
  LayerGeometry,
  LayerProperties,
  SourceAssignment,
  ProjectFile,
  CalibrationPattern,
  CalibrationTarget,
  MonitorInfo,
  SourceInfo,
  UndoRedoResult,
  OutputConfig,
  BlendMode,
  FramePacingMode,
  UvAdjustment,
  InputTransform,
  Point2D,
  EditorSelectionMode,
} from "../types";

export interface Toast {
  id: string;
  message: string;
  type: "error" | "warning" | "info";
  timestamp: number;
}

let toastCounter = 0;

export interface PerfStats {
  fps: number;
  frametime: number;
  pollMs: number;
  decodeMs: number;
  drawMs: number;
  frameCount: number;
  totalBytes: number;
}

export const EMPTY_PERF: PerfStats = {
  fps: 0, frametime: 0, pollMs: 0, decodeMs: 0, drawMs: 0, frameCount: 0, totalBytes: 0,
};

function normalizeEditorSelectionMode(
  mode: EditorSelectionMode,
  layer: Layer | null | undefined
): EditorSelectionMode {
  return layer ? mode : "shape";
}

interface AppState {
  // Project
  project: ProjectFile | null;
  projectPath: string | null;
  isDirty: boolean;

  // Layers
  layers: Layer[];
  selectedLayerId: string | null;
  selectedFaceIndices: number[];
  editorSelectionMode: EditorSelectionMode;

  // Calibration
  calibrationEnabled: boolean;
  calibrationPattern: CalibrationPattern;

  // Sources
  sources: SourceInfo[];
  _sourcesRefreshing: boolean;

  // Monitors
  monitors: MonitorInfo[];

  // UI state
  projectorWindowOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;

  // Toasts
  toasts: Toast[];
  addToast: (message: string, type: Toast["type"]) => void;
  dismissToast: (id: string) => void;

  // Snap-to-grid
  snapEnabled: boolean;
  toggleSnap: () => void;

  // Performance metrics
  editorPerf: PerfStats;
  projectorPerf: PerfStats;
  setEditorPerf: (stats: PerfStats) => void;
  setProjectorPerf: (stats: PerfStats) => void;

  // Actions
  loadProject: () => Promise<void>;
  fetchLayers: () => Promise<void>;
  addLayer: (name: string, type: string) => Promise<void>;
  removeLayer: (id: string) => Promise<void>;
  duplicateLayer: (id: string) => Promise<void>;
  renameLayer: (id: string, name: string) => Promise<void>;
  selectLayer: (id: string | null) => void;
  setEditorSelectionMode: (mode: EditorSelectionMode) => void;
  toggleEditorSelectionMode: () => void;
  setSelectedFaces: (indices: number[]) => void;
  toggleFaceSelection: (index: number) => void;
  clearFaceSelection: () => void;
  setLayerVisibility: (id: string, visible: boolean) => Promise<void>;
  setLayerLocked: (id: string, locked: boolean) => Promise<void>;
  reorderLayers: (ids: string[]) => Promise<void>;
  updateGeometry: (id: string, geometry: LayerGeometry) => Promise<void>;
  updateLayerPoint: (id: string, pointIndex: number, point: Point2D) => Promise<void>;
  applyGeometryTransformDelta: (
    id: string,
    delta: { dx: number; dy: number; dRotation: number; sx: number; sy: number }
  ) => Promise<void>;
  updateProperties: (id: string, properties: LayerProperties) => Promise<void>;
  setLayerInputTransform: (id: string, inputTransform: InputTransform) => Promise<void>;
  setLayerSource: (
    id: string,
    source: SourceAssignment | null
  ) => Promise<void>;

  // Blend mode
  setBlendMode: (id: string, blendMode: BlendMode) => Promise<void>;

  // Calibration
  toggleCalibration: () => Promise<void>;
  setCalibrationPattern: (pattern: CalibrationPattern) => Promise<void>;

  // Projector
  openProjector: () => Promise<void>;
  closeProjector: () => Promise<void>;

  // Monitors
  refreshMonitors: () => Promise<void>;

  // Sources
  refreshSources: () => Promise<void>;
  addMediaFile: (path: string) => Promise<SourceInfo | null>;
  removeMediaFile: (sourceId: string) => Promise<void>;
  connectSource: (layerId: string, sourceId: string) => Promise<void>;
  disconnectSource: (layerId: string) => Promise<void>;

  // Persistence
  saveProject: (path?: string) => Promise<void>;
  loadProjectFile: (path: string) => Promise<void>;
  newProject: () => Promise<void>;

  // Interaction (undo snapshot before drag)
  beginInteraction: () => Promise<void>;

  // Undo/Redo
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  // Face operations
  toggleFaceMask: (layerId: string, faceIndices: number[], masked: boolean) => Promise<void>;
  createFaceGroup: (layerId: string, name: string, faceIndices: number[], color: string) => Promise<void>;
  removeFaceGroup: (layerId: string, groupIndex: number) => Promise<void>;
  renameFaceGroup: (layerId: string, groupIndex: number, name: string) => Promise<void>;
  setCalibrationTarget: (target: CalibrationTarget | null) => Promise<void>;
  setFaceUvOverride: (layerId: string, faceIndex: number, adjustment: UvAdjustment) => Promise<void>;
  clearFaceUvOverride: (layerId: string, faceIndex: number) => Promise<void>;
  subdivideMesh: (layerId: string) => Promise<void>;

  // Output
  setOutputConfig: (config: OutputConfig) => Promise<void>;

  // Frame pacing
  framePacingMode: FramePacingMode;
  setFramePacing: (mode: FramePacingMode) => Promise<void>;

  // Performance panel
  performancePanelOpen: boolean;
  togglePerformancePanel: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  project: null,
  projectPath: null,
  isDirty: false,
  layers: [],
  selectedLayerId: null,
  selectedFaceIndices: [],
  editorSelectionMode: "shape",
  calibrationEnabled: false,
  calibrationPattern: "grid",
  sources: [],
  _sourcesRefreshing: false,
  monitors: [],
  projectorWindowOpen: false,
  canUndo: false,
  canRedo: false,

  toasts: [],
  addToast: (message, type) => {
    const id = `toast-${++toastCounter}`;
    const toast: Toast = { id, message, type, timestamp: Date.now() };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 5000);
  },
  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  snapEnabled: false,
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),

  editorPerf: { ...EMPTY_PERF },
  projectorPerf: { ...EMPTY_PERF },
  setEditorPerf: (stats) => set({ editorPerf: stats }),
  setProjectorPerf: (stats) => set({ projectorPerf: stats }),

  loadProject: async () => {
    try {
      const project = await tauriInvoke<ProjectFile>("get_project");
      set({
        project,
        layers: project.layers,
        selectedLayerId: null,
        selectedFaceIndices: [],
        editorSelectionMode: "shape",
        calibrationEnabled: project.calibration.enabled,
        calibrationPattern: project.calibration.pattern,
      });
    } catch (e) {
      console.error("Failed to load project:", e);
      get().addToast("Failed to load project", "error");
}
  },

  fetchLayers: async () => {
    try {
      const layers = await tauriInvoke<Layer[]>("get_layers");
      set((s) => {
        const selectedLayer = s.selectedLayerId
          ? layers.find((l) => l.id === s.selectedLayerId)
          : null;
        const selectedLayerId = selectedLayer ? s.selectedLayerId : null;
        return {
          layers,
          selectedLayerId,
          selectedFaceIndices: selectedLayerId ? s.selectedFaceIndices : [],
          editorSelectionMode: normalizeEditorSelectionMode(s.editorSelectionMode, selectedLayer),
        };
      });
    } catch (e) {
      console.error("Failed to fetch layers:", e);
    }
  },

  addLayer: async (name: string, layerType: string) => {
    try {
      const layer = await tauriInvoke<Layer>("add_layer", {
        params: { name, type: layerType },
      });
      set((s) => ({
        layers: [...s.layers, layer],
        selectedLayerId: layer.id,
        selectedFaceIndices: [],
        editorSelectionMode: normalizeEditorSelectionMode(s.editorSelectionMode, layer),
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to add layer:", e);
      get().addToast("Failed to add layer", "error");
    }
  },

  removeLayer: async (id: string) => {
    try {
      await tauriInvoke<boolean>("remove_layer", { layerId: id });
      set((s) => ({
        layers: s.layers.filter((l) => l.id !== id),
        selectedLayerId: s.selectedLayerId === id ? null : s.selectedLayerId,
        selectedFaceIndices: s.selectedLayerId === id ? [] : s.selectedFaceIndices,
        editorSelectionMode: s.selectedLayerId === id ? "shape" : s.editorSelectionMode,
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to remove layer:", e);
      get().addToast("Failed to remove layer", "error");
    }
  },

  duplicateLayer: async (id: string) => {
    try {
      const layer = await tauriInvoke<Layer | null>("duplicate_layer", {
        layerId: id,
      });
      if (layer) {
        set((s) => ({
          layers: [...s.layers, layer],
          selectedLayerId: layer.id,
          selectedFaceIndices: [],
          editorSelectionMode: normalizeEditorSelectionMode(s.editorSelectionMode, layer),
          isDirty: true,
          canUndo: true,
        }));
      }
    } catch (e) {
      console.error("Failed to duplicate layer:", e);
    }
  },

  renameLayer: async (id: string, name: string) => {
    try {
      await tauriInvoke<boolean>("rename_layer", { layerId: id, name });
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, name } : l)),
        isDirty: true,
      }));
    } catch (e) {
      console.error("Failed to rename layer:", e);
    }
  },

  selectLayer: (id) =>
    set((s) => {
      const nextLayer = id ? s.layers.find((l) => l.id === id) : null;
      return {
        selectedLayerId: id,
        selectedFaceIndices: [],
        editorSelectionMode: normalizeEditorSelectionMode(s.editorSelectionMode, nextLayer),
      };
    }),
  setEditorSelectionMode: (mode) =>
    set((s) => {
      return mode === s.editorSelectionMode ? s : { editorSelectionMode: mode };
    }),
  toggleEditorSelectionMode: () =>
    set((s) => {
      return { editorSelectionMode: s.editorSelectionMode === "shape" ? "uv" : "shape" };
    }),
  setSelectedFaces: (indices) => set({ selectedFaceIndices: indices }),
  toggleFaceSelection: (index) =>
    set((s) => ({
      selectedFaceIndices: s.selectedFaceIndices.includes(index)
        ? s.selectedFaceIndices.filter((i) => i !== index)
        : [...s.selectedFaceIndices, index],
    })),
  clearFaceSelection: () => set({ selectedFaceIndices: [] }),

  setLayerVisibility: async (id, visible) => {
    try {
      await tauriInvoke<boolean>("set_layer_visibility", { layerId: id, visible });
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, visible } : l)),
        isDirty: true,
      }));
    } catch (e) {
      console.error("Failed to set visibility:", e);
    }
  },

  setLayerLocked: async (id, locked) => {
    try {
      await tauriInvoke<boolean>("set_layer_locked", { layerId: id, locked });
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, locked } : l)),
        isDirty: true,
      }));
    } catch (e) {
      console.error("Failed to set locked:", e);
    }
  },

  reorderLayers: async (ids) => {
    try {
      await tauriInvoke<boolean>("reorder_layers", { layerIds: ids });
      await get().fetchLayers();
      set({ isDirty: true, canUndo: true });
    } catch (e) {
      console.error("Failed to reorder layers:", e);
    }
  },

  updateGeometry: async (id, geometry) => {
    try {
      await tauriInvoke<boolean>("update_layer_geometry", { layerId: id, geometry });
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, geometry } : l)),
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to update geometry:", e);
    }
  },

  updateLayerPoint: async (id, pointIndex, point) => {
    try {
      const geometry = await tauriInvoke<LayerGeometry | null>("update_layer_point", {
        layerId: id,
        pointIndex,
        point,
      });
      if (!geometry) return;
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, geometry } : l)),
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to update layer point:", e);
    }
  },

  applyGeometryTransformDelta: async (id, delta) => {
    try {
      const geometry = await tauriInvoke<LayerGeometry | null>("apply_layer_geometry_transform_delta", {
        layerId: id,
        dx: delta.dx,
        dy: delta.dy,
        dRotation: delta.dRotation,
        sx: delta.sx,
        sy: delta.sy,
      });
      if (!geometry) return;
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, geometry } : l)),
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to apply geometry transform delta:", e);
    }
  },

  updateProperties: async (id, properties) => {
    try {
      await tauriInvoke<boolean>("update_layer_properties", {
        layerId: id,
        properties,
      });
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id === id ? { ...l, properties } : l
        ),
        isDirty: true,
      }));
    } catch (e) {
      console.error("Failed to update properties:", e);
    }
  },

  setLayerInputTransform: async (id, inputTransform) => {
    try {
      await tauriInvoke<boolean>("set_layer_input_transform", { layerId: id, inputTransform });
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id === id ? { ...l, input_transform: inputTransform } : l
        ),
        isDirty: true,
      }));
    } catch (e) {
      console.error("Failed to set layer input transform:", e);
    }
  },

  setLayerSource: async (id, source) => {
    try {
      await tauriInvoke<boolean>("set_layer_source", { layerId: id, source });
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, source } : l)),
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to set source:", e);
    }
  },

  setBlendMode: async (id, blendMode) => {
    try {
      await tauriInvoke<boolean>("set_layer_blend_mode", { layerId: id, blendMode });
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id === id ? { ...l, blend_mode: blendMode } : l
        ),
        isDirty: true,
      }));
    } catch (e) {
      console.error("Failed to set blend mode:", e);
    }
  },

  toggleCalibration: async () => {
    const enabled = !get().calibrationEnabled;
    try {
      await tauriInvoke<void>("set_calibration_enabled", { enabled });
      set({ calibrationEnabled: enabled, isDirty: true });
    } catch (e) {
      console.error("Failed to toggle calibration:", e);
    }
  },

  setCalibrationPattern: async (pattern) => {
    try {
      await tauriInvoke<void>("set_calibration_pattern", { pattern });
      set({ calibrationPattern: pattern, isDirty: true });
    } catch (e) {
      console.error("Failed to set calibration pattern:", e);
    }
  },

  openProjector: async () => {
    try {
      await tauriInvoke<void>("open_projector_window");
      set({ projectorWindowOpen: true });
    } catch (e) {
      console.error("Failed to open projector:", e);
      get().addToast("Failed to open projector", "error");
    }
  },

  closeProjector: async () => {
    try {
      await tauriInvoke<void>("close_projector_window");
      set({ projectorWindowOpen: false });
    } catch (e) {
      console.error("Failed to close projector:", e);
    }
  },

  refreshMonitors: async () => {
    try {
      const monitors = await tauriInvoke<MonitorInfo[]>("list_monitors");
      set({ monitors });
    } catch (e) {
      console.error("Failed to list monitors:", e);
    }
  },

  refreshSources: async () => {
    if (get()._sourcesRefreshing) return;
    set({ _sourcesRefreshing: true });
    try {
      const sources = await tauriInvoke<SourceInfo[]>("refresh_sources");
      set({ sources });
    } catch (e) {
      console.error("Failed to refresh sources:", e);
    } finally {
      set({ _sourcesRefreshing: false });
    }
  },

  addMediaFile: async (path: string) => {
    try {
      const info = await tauriInvoke<SourceInfo>("add_media_file", { path });
      // Refresh sources to include the new media file
      const sources = await tauriInvoke<SourceInfo[]>("list_sources");
      set({ sources });
      return info;
    } catch (e) {
      console.error("Failed to add media file:", e);
      get().addToast("Failed to add media file", "error");
      return null;
    }
  },

  removeMediaFile: async (sourceId: string) => {
    try {
      await tauriInvoke<boolean>("remove_media_file", { sourceId });
      const sources = await tauriInvoke<SourceInfo[]>("list_sources");
      set({ sources });
    } catch (e) {
      console.error("Failed to remove media file:", e);
    }
  },

  connectSource: async (layerId: string, sourceId: string) => {
    try {
      await tauriInvoke<boolean>("connect_source", { layerId, sourceId });
      // Refresh the layer list to pick up the source assignment
      const sources = await tauriInvoke<SourceInfo[]>("list_sources");
      const source = sources.find((s) => s.id === sourceId);
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id === layerId
            ? {
                ...l,
                source: source
                  ? { protocol: source.protocol, source_id: source.id, display_name: source.name }
                  : l.source,
              }
            : l
        ),
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to connect source:", e);
      get().addToast("Failed to connect source", "error");
    }
  },

  disconnectSource: async (layerId: string) => {
    try {
      await tauriInvoke<boolean>("disconnect_source", { layerId });
      set((s) => ({
        layers: s.layers.map((l) =>
          l.id === layerId ? { ...l, source: null } : l
        ),
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to disconnect source:", e);
    }
  },

  saveProject: async (path?: string) => {
    try {
      const savedPath = await tauriInvoke<string>("save_project", { path });
      set({ projectPath: savedPath, isDirty: false });
    } catch (e) {
      console.error("Failed to save project:", e);
      get().addToast("Failed to save project", "error");
    }
  },

  loadProjectFile: async (path: string) => {
    try {
      const project = await tauriInvoke<ProjectFile>("load_project", { path });
      set({
        project,
        projectPath: path,
        layers: project.layers,
        calibrationEnabled: project.calibration.enabled,
        calibrationPattern: project.calibration.pattern,
        isDirty: false,
        selectedLayerId: null,
        selectedFaceIndices: [],
        editorSelectionMode: "shape",
        canUndo: false,
        canRedo: false,
      });
    } catch (e) {
      console.error("Failed to load project:", e);
      get().addToast("Failed to load project", "error");
}
  },

  newProject: async () => {
    try {
      const project = await tauriInvoke<ProjectFile>("new_project");
      set({
        project,
        projectPath: null,
        layers: [],
        selectedLayerId: null,
        selectedFaceIndices: [],
        editorSelectionMode: "shape",
        calibrationEnabled: false,
        calibrationPattern: "grid",
        isDirty: false,
        canUndo: false,
        canRedo: false,
      });
    } catch (e) {
      console.error("Failed to create project:", e);
    }
  },

  beginInteraction: async () => {
    try {
      await tauriInvoke<void>("begin_interaction");
      set({ canUndo: true });
    } catch (e) {
      console.error("Failed to begin interaction:", e);
    }
  },

  undo: async () => {
    try {
      const result = await tauriInvoke<UndoRedoResult | null>("undo");
      if (result) {
        set({
          layers: result.layers,
          canUndo: result.can_undo,
          canRedo: result.can_redo,
          isDirty: true,
        });
      }
    } catch (e) {
      console.error("Failed to undo:", e);
    }
  },

  redo: async () => {
    try {
      const result = await tauriInvoke<UndoRedoResult | null>("redo");
      if (result) {
        set({
          layers: result.layers,
          canUndo: result.can_undo,
          canRedo: result.can_redo,
          isDirty: true,
        });
      }
    } catch (e) {
      console.error("Failed to redo:", e);
    }
  },

  toggleFaceMask: async (layerId, faceIndices, masked) => {
    try {
      await tauriInvoke<boolean>("toggle_face_mask", { layerId, faceIndices, masked });
      const layers = await tauriInvoke<Layer[]>("get_layers");
      set({ layers, isDirty: true, canUndo: true });
    } catch (e) {
      console.error("Failed to toggle face mask:", e);
    }
  },

  createFaceGroup: async (layerId, name, faceIndices, color) => {
    try {
      await tauriInvoke<boolean>("create_face_group", { layerId, name, faceIndices, color });
      const layers = await tauriInvoke<Layer[]>("get_layers");
      set({ layers, isDirty: true, canUndo: true });
    } catch (e) {
      console.error("Failed to create face group:", e);
    }
  },

  removeFaceGroup: async (layerId, groupIndex) => {
    try {
      await tauriInvoke<boolean>("remove_face_group", { layerId, groupIndex });
      const layers = await tauriInvoke<Layer[]>("get_layers");
      set({ layers, isDirty: true, canUndo: true });
    } catch (e) {
      console.error("Failed to remove face group:", e);
    }
  },

  renameFaceGroup: async (layerId, groupIndex, name) => {
    try {
      await tauriInvoke<boolean>("rename_face_group", { layerId, groupIndex, name });
      const layers = await tauriInvoke<Layer[]>("get_layers");
      set({ layers, isDirty: true, canUndo: true });
    } catch (e) {
      console.error("Failed to rename face group:", e);
    }
  },

  setCalibrationTarget: async (target) => {
    try {
      await tauriInvoke<void>("set_calibration_target", { target });
      set((s) => ({
        project: s.project
          ? { ...s.project, calibration: { ...s.project.calibration, target_layer: target } }
          : null,
        isDirty: true,
      }));
    } catch (e) {
      console.error("Failed to set calibration target:", e);
    }
  },

  setFaceUvOverride: async (layerId, faceIndex, adjustment) => {
    try {
      await tauriInvoke<boolean>("set_face_uv_override", { layerId, faceIndex, adjustment });
      const layers = await tauriInvoke<Layer[]>("get_layers");
      set({ layers, isDirty: true });
    } catch (e) {
      console.error("Failed to set face UV override:", e);
    }
  },

  clearFaceUvOverride: async (layerId, faceIndex) => {
    try {
      await tauriInvoke<boolean>("clear_face_uv_override", { layerId, faceIndex });
      const layers = await tauriInvoke<Layer[]>("get_layers");
      set({ layers, isDirty: true, canUndo: true });
    } catch (e) {
      console.error("Failed to clear face UV override:", e);
    }
  },

  subdivideMesh: async (layerId) => {
    try {
      const newGeometry = await tauriInvoke<LayerGeometry | null>("subdivide_mesh", { layerId });
      if (newGeometry) {
        set((s) => ({
          layers: s.layers.map((l) => l.id === layerId ? { ...l, geometry: newGeometry } : l),
          selectedFaceIndices: [],
          isDirty: true,
          canUndo: true,
        }));
      }
    } catch (e) {
      console.error("Failed to subdivide mesh:", e);
    }
  },

  setOutputConfig: async (config: OutputConfig) => {
    try {
      await tauriInvoke<void>("set_output_config", { config });
      set((s) => ({
        project: s.project ? { ...s.project, output: config } : null,
        isDirty: true,
      }));
    } catch (e) {
      console.error("Failed to set output config:", e);
    }
  },

  framePacingMode: "show" as FramePacingMode,
  setFramePacing: async (mode: FramePacingMode) => {
    try {
      await tauriInvoke<void>("set_frame_pacing", { mode });
      set({ framePacingMode: mode });
    } catch (e) {
      console.error("Failed to set frame pacing:", e);
      get().addToast("Failed to set frame pacing", "error");
    }
  },

  performancePanelOpen: false,
  togglePerformancePanel: () => set((s) => ({ performancePanelOpen: !s.performancePanelOpen })),
}));

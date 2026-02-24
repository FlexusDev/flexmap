import { create } from "zustand";
import { tauriInvoke } from "../lib/tauri-bridge";
import { getInstalledShaderDescriptors } from "../lib/shader-library";
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
  InstalledShaderSourceDescriptor,
  PerformanceProfile,
  ProjectorWindowState,
  AudioInputDevice,
  BpmConfig,
  BpmState,
} from "../types";

export interface Toast {
  id: string;
  message: string;
  type: "error" | "warning" | "info";
  timestamp: number;
}

let toastCounter = 0;
let installedShaderSyncFingerprint = "";
const PERFORMANCE_PROFILE_KEY = "auramap:performance_profile";
const BPM_CONFIG_KEY = "auramap:bpm_config";
const BPM_DEVICE_KEY = "auramap:bpm_device";

const DEFAULT_BPM_CONFIG: BpmConfig = {
  enabled: false,
  sensitivity: 1.0,
  gate: 0.28,
  smoothing: 0.82,
  attack: 0.85,
  decay: 0.75,
  manualBpm: 120,
};

const DEFAULT_BPM_STATE: BpmState = {
  bpm: 120,
  beat: 0,
  level: 0,
  phase: 0,
  running: false,
  selectedDeviceId: null,
  selectedDeviceName: null,
  lastBeatMs: 0,
};

function readPerformanceProfile(): PerformanceProfile {
  if (typeof window === "undefined") return "max_fps";
  const raw = window.localStorage.getItem(PERFORMANCE_PROFILE_KEY);
  return raw === "balanced" ? "balanced" : "max_fps";
}

function persistPerformanceProfile(profile: PerformanceProfile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERFORMANCE_PROFILE_KEY, profile);
  } catch {
    // ignore persistence errors
  }
}

function readBpmConfig(): BpmConfig {
  if (typeof window === "undefined") return { ...DEFAULT_BPM_CONFIG };
  try {
    const raw = window.localStorage.getItem(BPM_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_BPM_CONFIG };
    const parsed = JSON.parse(raw) as Partial<BpmConfig>;
    return { ...DEFAULT_BPM_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_BPM_CONFIG };
  }
}

function persistBpmConfig(config: BpmConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BPM_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore persistence errors
  }
}

function readSelectedAudioDeviceId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(BPM_DEVICE_KEY);
}

function persistSelectedAudioDeviceId(deviceId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!deviceId) {
      window.localStorage.removeItem(BPM_DEVICE_KEY);
    } else {
      window.localStorage.setItem(BPM_DEVICE_KEY, deviceId);
    }
  } catch {
    // ignore persistence errors
  }
}

function fingerprintInstalledShaders(sources: InstalledShaderSourceDescriptor[]): string {
  return sources
    .map((source) => `${source.id}:${source.seed}:${source.sourceHash ?? ""}`)
    .sort()
    .join("|");
}

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

type GeomDelta = {
  dx: number;
  dy: number;
  dRotation: number;
  sx: number;
  sy: number;
};

function dedupeSelectionIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeSelectionIds(ids: string[], layers: Layer[]): string[] {
  const existing = new Set(layers.map((l) => l.id));
  return dedupeSelectionIds(ids).filter((id) => existing.has(id));
}

function getEffectiveSelectionIds(state: Pick<AppState, "selectedLayerIds" | "selectedLayerId" | "layers">): string[] {
  const base = state.selectedLayerIds.length > 0
    ? state.selectedLayerIds
    : state.selectedLayerId
      ? [state.selectedLayerId]
      : [];
  return normalizeSelectionIds(base, state.layers);
}

function normalizePrimaryId(
  ids: string[],
  preferredPrimary: string | null
): string | null {
  if (ids.length === 0) return null;
  if (preferredPrimary && ids.includes(preferredPrimary)) {
    return preferredPrimary;
  }
  return ids[ids.length - 1] ?? null;
}

interface AppState {
  // Project
  project: ProjectFile | null;
  projectPath: string | null;
  isDirty: boolean;

  // Layers
  layers: Layer[];
  selectedLayerId: string | null;
  selectedLayerIds: string[];
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
  projectorGpuNative: boolean;
  canUndo: boolean;
  canRedo: boolean;
  audioInputDevices: AudioInputDevice[];
  selectedAudioInputId: string | null;
  bpmConfig: BpmConfig;
  bpmState: BpmState;

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
  setLayerSelection: (ids: string[], primaryId?: string | null) => void;
  toggleLayerSelection: (id: string) => void;
  clearLayerSelection: () => void;
  removeSelectedLayers: () => Promise<void>;
  duplicateSelectedLayers: () => Promise<void>;
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
    delta: GeomDelta
  ) => Promise<void>;
  applyGeometryDeltaToSelection: (delta: GeomDelta) => Promise<void>;
  updateProperties: (id: string, properties: LayerProperties) => Promise<void>;
  updatePropertiesForSelection: (
    patch:
      | Partial<LayerProperties>
      | ((current: LayerProperties) => LayerProperties)
  ) => Promise<void>;
  setLayerInputTransform: (id: string, inputTransform: InputTransform) => Promise<void>;
  setLayerSource: (
    id: string,
    source: SourceAssignment | null
  ) => Promise<void>;
  connectSourceForSelection: (sourceId: string) => Promise<void>;
  disconnectSourceForSelection: () => Promise<void>;

  // Blend mode
  setBlendMode: (id: string, blendMode: BlendMode) => Promise<void>;
  setBlendModeForSelection: (blendMode: BlendMode) => Promise<void>;

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
  setProjectUiState: (uiState: unknown) => Promise<void>;

  // Frame pacing
  framePacingMode: FramePacingMode;
  setFramePacing: (mode: FramePacingMode) => Promise<void>;
  performanceProfile: PerformanceProfile;
  setPerformanceProfile: (profile: PerformanceProfile) => void;

  // Projector state sync
  applyProjectorWindowState: (state: ProjectorWindowState) => void;
  syncProjectorWindowState: () => Promise<void>;

  // Audio / BPM
  refreshAudioInputs: () => Promise<void>;
  setAudioInputDevice: (deviceId: string | null) => Promise<void>;
  setBpmConfig: (patch: Partial<BpmConfig>) => Promise<void>;
  refreshBpmState: () => Promise<void>;
  tapTempo: () => Promise<void>;

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
  selectedLayerIds: [],
  selectedFaceIndices: [],
  editorSelectionMode: "shape",
  calibrationEnabled: false,
  calibrationPattern: "grid",
  sources: [],
  _sourcesRefreshing: false,
  monitors: [],
  projectorWindowOpen: false,
  projectorGpuNative: false,
  canUndo: false,
  canRedo: false,
  audioInputDevices: [],
  selectedAudioInputId: readSelectedAudioDeviceId(),
  bpmConfig: readBpmConfig(),
  bpmState: { ...DEFAULT_BPM_STATE },

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
  performanceProfile: readPerformanceProfile(),
  setPerformanceProfile: (profile) => {
    persistPerformanceProfile(profile);
    set({ performanceProfile: profile });
  },
  applyProjectorWindowState: (state) => {
    set({
      projectorWindowOpen: state.open,
      projectorGpuNative: state.gpu_native,
    });
  },
  syncProjectorWindowState: async () => {
    try {
      const state = await tauriInvoke<ProjectorWindowState>("get_projector_window_state");
      get().applyProjectorWindowState(state);
    } catch {
      // Keep local state when command unavailable (older backends/browser)
    }
  },
  refreshAudioInputs: async () => {
    try {
      const devices = await tauriInvoke<AudioInputDevice[]>("list_audio_input_devices");
      set({ audioInputDevices: devices });

      const selectedId = get().selectedAudioInputId;
      const hasSelected = selectedId && devices.some((device) => device.id === selectedId);

      if (hasSelected) {
        // Restore previously-chosen device
        return;
      }

      // Only auto-select a device if there was a stored preference that
      // has become stale (device unplugged); never auto-activate on first
      // launch when no preference was stored.
      if (selectedId) {
        const fallbackId = devices.find((device) => device.isDefault)?.id ?? devices[0]?.id ?? null;
        if (fallbackId) {
          await get().setAudioInputDevice(fallbackId);
        }
      }
    } catch (e) {
      console.error("Failed to list audio input devices:", e);
    }
  },
  setAudioInputDevice: async (deviceId) => {
    if (!deviceId) {
      set({ selectedAudioInputId: null });
      persistSelectedAudioDeviceId(null);
      return;
    }

    try {
      const bpmState = await tauriInvoke<BpmState>("set_audio_input_device", { deviceId });
      set({
        selectedAudioInputId: deviceId,
        bpmState,
      });
      persistSelectedAudioDeviceId(deviceId);
    } catch (e) {
      console.error("Failed to set audio input device:", e);
      get().addToast("Failed to switch audio input", "error");
    }
  },
  setBpmConfig: async (patch) => {
    const nextConfig: BpmConfig = { ...get().bpmConfig, ...patch };
    try {
      const bpmState = await tauriInvoke<BpmState>("set_bpm_config", { config: nextConfig });
      set({
        bpmConfig: nextConfig,
        bpmState,
      });
      persistBpmConfig(nextConfig);
    } catch (e) {
      console.error("Failed to set BPM config:", e);
      get().addToast("Failed to apply BPM settings", "error");
    }
  },
  refreshBpmState: async () => {
    try {
      const bpmState = await tauriInvoke<BpmState>("get_bpm_state");
      set({ bpmState });
    } catch (e) {
      console.error("Failed to fetch BPM state:", e);
    }
  },
  tapTempo: async () => {
    try {
      const bpmState = await tauriInvoke<BpmState>("tap_tempo");
      set((s) => ({
        bpmState,
        bpmConfig: { ...s.bpmConfig, manualBpm: bpmState.bpm },
      }));
      persistBpmConfig({ ...get().bpmConfig, manualBpm: bpmState.bpm });
    } catch (e) {
      console.error("Failed to tap tempo:", e);
    }
  },

  loadProject: async () => {
    try {
      const project = await tauriInvoke<ProjectFile>("get_project");
      set({
        project,
        layers: project.layers,
        selectedLayerId: null,
        selectedLayerIds: [],
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
        const selectedLayerIds = normalizeSelectionIds(getEffectiveSelectionIds(s), layers);
        const selectedLayerId = normalizePrimaryId(selectedLayerIds, s.selectedLayerId);
        const singleSelected = selectedLayerIds.length === 1;
        const selectedLayer = singleSelected && selectedLayerId
          ? layers.find((l) => l.id === selectedLayerId)
          : null;
        return {
          layers,
          selectedLayerIds,
          selectedLayerId,
          selectedFaceIndices:
            singleSelected && selectedLayerId === s.selectedLayerId
              ? s.selectedFaceIndices
              : [],
          editorSelectionMode: singleSelected
            ? normalizeEditorSelectionMode(s.editorSelectionMode, selectedLayer)
            : "shape",
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
        selectedLayerIds: [layer.id],
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
      set((s) => {
        const layers = s.layers.filter((l) => l.id !== id);
        const selectedLayerIds = normalizeSelectionIds(
          getEffectiveSelectionIds(s).filter((sid) => sid !== id),
          layers
        );
        const selectedLayerId = normalizePrimaryId(
          selectedLayerIds,
          s.selectedLayerId === id ? null : s.selectedLayerId
        );
        const singleSelected = selectedLayerIds.length === 1;
        const selectedLayer = singleSelected && selectedLayerId
          ? layers.find((l) => l.id === selectedLayerId)
          : null;
        return {
          layers,
          selectedLayerIds,
          selectedLayerId,
          selectedFaceIndices:
            singleSelected && selectedLayerId === s.selectedLayerId
              ? s.selectedFaceIndices
              : [],
          editorSelectionMode: singleSelected
            ? normalizeEditorSelectionMode(s.editorSelectionMode, selectedLayer)
            : "shape",
          isDirty: true,
          canUndo: true,
        };
      });
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
          selectedLayerIds: [layer.id],
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
        selectedLayerIds: id ? [id] : [],
        selectedFaceIndices: [],
        editorSelectionMode: normalizeEditorSelectionMode(s.editorSelectionMode, nextLayer),
      };
    }),
  setLayerSelection: (ids, primaryId) =>
    set((s) => {
      const selectedLayerIds = normalizeSelectionIds(ids, s.layers);
      const selectedLayerId = normalizePrimaryId(
        selectedLayerIds,
        primaryId ?? s.selectedLayerId
      );
      const singleSelected = selectedLayerIds.length === 1;
      const selectedLayer = singleSelected && selectedLayerId
        ? s.layers.find((l) => l.id === selectedLayerId)
        : null;
      return {
        selectedLayerIds,
        selectedLayerId,
        selectedFaceIndices:
          singleSelected && selectedLayerId === s.selectedLayerId
            ? s.selectedFaceIndices
            : [],
        editorSelectionMode: singleSelected
          ? normalizeEditorSelectionMode(s.editorSelectionMode, selectedLayer)
          : "shape",
      };
    }),
  toggleLayerSelection: (id) =>
    set((s) => {
      const current = getEffectiveSelectionIds(s);
      const includes = current.includes(id);
      const nextIds = includes
        ? current.filter((sid) => sid !== id)
        : [...current, id];
      const selectedLayerIds = normalizeSelectionIds(nextIds, s.layers);
      const selectedLayerId = normalizePrimaryId(
        selectedLayerIds,
        includes
          ? (s.selectedLayerId === id ? null : s.selectedLayerId)
          : id
      );
      const singleSelected = selectedLayerIds.length === 1;
      const selectedLayer = singleSelected && selectedLayerId
        ? s.layers.find((l) => l.id === selectedLayerId)
        : null;
      return {
        selectedLayerIds,
        selectedLayerId,
        selectedFaceIndices:
          singleSelected && selectedLayerId === s.selectedLayerId
            ? s.selectedFaceIndices
            : [],
        editorSelectionMode: singleSelected
          ? normalizeEditorSelectionMode(s.editorSelectionMode, selectedLayer)
          : "shape",
      };
    }),
  clearLayerSelection: () =>
    set({
      selectedLayerId: null,
      selectedLayerIds: [],
      selectedFaceIndices: [],
      editorSelectionMode: "shape",
    }),
  removeSelectedLayers: async () => {
    const state = get();
    const ids = getEffectiveSelectionIds(state);
    if (ids.length === 0) return;
    if (ids.length === 1) {
      await get().removeLayer(ids[0]);
      return;
    }
    try {
      const removed = await tauriInvoke<boolean>("remove_layers", { layerIds: ids });
      if (!removed) return;
      set((s) => ({
        layers: s.layers.filter((l) => !ids.includes(l.id)),
        selectedLayerId: null,
        selectedLayerIds: [],
        selectedFaceIndices: [],
        editorSelectionMode: "shape",
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to remove selected layers:", e);
      get().addToast("Failed to remove selected layers", "error");
    }
  },
  duplicateSelectedLayers: async () => {
    const state = get();
    const ids = getEffectiveSelectionIds(state);
    if (ids.length === 0) return;
    if (ids.length === 1) {
      await get().duplicateLayer(ids[0]);
      return;
    }
    try {
      const duplicated = await tauriInvoke<Layer[]>("duplicate_layers", { layerIds: ids });
      if (duplicated.length === 0) return;
      const nextSelectedLayerIds = duplicated.map((l) => l.id);
      const preferredPrimaryIndex = state.selectedLayerId ? ids.indexOf(state.selectedLayerId) : -1;
      const selectedLayerId = preferredPrimaryIndex >= 0
        ? duplicated[preferredPrimaryIndex]?.id ?? nextSelectedLayerIds[nextSelectedLayerIds.length - 1]
        : nextSelectedLayerIds[nextSelectedLayerIds.length - 1];
      set((s) => ({
        layers: [...s.layers, ...duplicated],
        selectedLayerId,
        selectedLayerIds: nextSelectedLayerIds,
        selectedFaceIndices: [],
        editorSelectionMode: "shape",
        isDirty: true,
        canUndo: true,
      }));
    } catch (e) {
      console.error("Failed to duplicate selected layers:", e);
      get().addToast("Failed to duplicate selected layers", "error");
    }
  },
  setEditorSelectionMode: (mode) =>
    set((s) => {
      const ids = getEffectiveSelectionIds(s);
      if (ids.length !== 1) {
        return s.editorSelectionMode === "shape"
          ? { selectedFaceIndices: [] }
          : { editorSelectionMode: "shape", selectedFaceIndices: [] };
      }
      return mode === s.editorSelectionMode ? s : { editorSelectionMode: mode };
    }),
  toggleEditorSelectionMode: () =>
    set((s) => {
      const ids = getEffectiveSelectionIds(s);
      if (ids.length !== 1) {
        return s.editorSelectionMode === "shape"
          ? { selectedFaceIndices: [] }
          : { editorSelectionMode: "shape", selectedFaceIndices: [] };
      }
      return { editorSelectionMode: s.editorSelectionMode === "shape" ? "uv" : "shape" };
    }),
  setSelectedFaces: (indices) =>
    set((s) => ({
      selectedFaceIndices: getEffectiveSelectionIds(s).length === 1 ? indices : [],
    })),
  toggleFaceSelection: (index) =>
    set((s) => ({
      selectedFaceIndices: getEffectiveSelectionIds(s).length !== 1
        ? []
        : s.selectedFaceIndices.includes(index)
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
  applyGeometryDeltaToSelection: async (delta) => {
    const ids = getEffectiveSelectionIds(get());
    if (ids.length === 0) return;
    for (const id of ids) {
      await get().applyGeometryTransformDelta(id, delta);
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
  updatePropertiesForSelection: async (patch) => {
    const state = get();
    const ids = getEffectiveSelectionIds(state);
    if (ids.length === 0) return;

    for (const id of ids) {
      const layer = get().layers.find((l) => l.id === id);
      if (!layer) continue;
      const next = typeof patch === "function"
        ? patch(layer.properties)
        : { ...layer.properties, ...patch };
      await get().updateProperties(id, next);
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
  connectSourceForSelection: async (sourceId) => {
    const ids = getEffectiveSelectionIds(get());
    if (ids.length === 0) return;
    for (const id of ids) {
      await get().connectSource(id, sourceId);
    }
  },
  disconnectSourceForSelection: async () => {
    const ids = getEffectiveSelectionIds(get());
    if (ids.length === 0) return;
    for (const id of ids) {
      await get().disconnectSource(id);
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
  setBlendModeForSelection: async (blendMode) => {
    const ids = getEffectiveSelectionIds(get());
    if (ids.length === 0) return;
    for (const id of ids) {
      await get().setBlendMode(id, blendMode);
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
      await get().syncProjectorWindowState();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("already exists")) {
        // Treat duplicate-label errors as non-fatal; projector is effectively open.
        await get().syncProjectorWindowState();
        return;
      }
      console.error("Failed to open projector:", e);
      get().addToast("Failed to open projector", "error");
    }
  },

  closeProjector: async () => {
    try {
      await tauriInvoke<void>("close_projector_window");
      await get().syncProjectorWindowState();
    } catch (e) {
      console.error("Failed to close projector:", e);
      // Best effort fallback
      set({ projectorWindowOpen: false, projectorGpuNative: false });
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
      const installedShaderSources = getInstalledShaderDescriptors();
      const nextFingerprint = fingerprintInstalledShaders(installedShaderSources);
      if (nextFingerprint !== installedShaderSyncFingerprint) {
        try {
          await tauriInvoke<number>("set_installed_shader_sources", {
            sources: installedShaderSources,
          });
          installedShaderSyncFingerprint = nextFingerprint;
        } catch (syncErr) {
          console.error("Failed to sync installed shader sources:", syncErr);
        }
      }
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
      console.info("[Sources] connect_source request", { layerId, sourceId });
      await tauriInvoke<boolean>("connect_source", { layerId, sourceId });
      const source = get().sources.find((s) => s.id === sourceId);
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
      if (!source) {
        void get().refreshSources();
      }
    } catch (e) {
      console.error("Failed to connect source:", { layerId, sourceId, error: e });
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
        selectedLayerIds: [],
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
        selectedLayerIds: [],
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
        set((s) => {
          const selectedLayerIds = normalizeSelectionIds(getEffectiveSelectionIds({
            ...s,
            layers: result.layers,
          }), result.layers);
          const selectedLayerId = normalizePrimaryId(selectedLayerIds, s.selectedLayerId);
          const singleSelected = selectedLayerIds.length === 1;
          const selectedLayer = singleSelected && selectedLayerId
            ? result.layers.find((l) => l.id === selectedLayerId)
            : null;
          return {
            layers: result.layers,
            selectedLayerIds,
            selectedLayerId,
            selectedFaceIndices:
              singleSelected && selectedLayerId === s.selectedLayerId
                ? s.selectedFaceIndices
                : [],
            editorSelectionMode: singleSelected
              ? normalizeEditorSelectionMode(s.editorSelectionMode, selectedLayer)
              : "shape",
            canUndo: result.can_undo,
            canRedo: result.can_redo,
            isDirty: true,
          };
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
        set((s) => {
          const selectedLayerIds = normalizeSelectionIds(getEffectiveSelectionIds({
            ...s,
            layers: result.layers,
          }), result.layers);
          const selectedLayerId = normalizePrimaryId(selectedLayerIds, s.selectedLayerId);
          const singleSelected = selectedLayerIds.length === 1;
          const selectedLayer = singleSelected && selectedLayerId
            ? result.layers.find((l) => l.id === selectedLayerId)
            : null;
          return {
            layers: result.layers,
            selectedLayerIds,
            selectedLayerId,
            selectedFaceIndices:
              singleSelected && selectedLayerId === s.selectedLayerId
                ? s.selectedFaceIndices
                : [],
            editorSelectionMode: singleSelected
              ? normalizeEditorSelectionMode(s.editorSelectionMode, selectedLayer)
              : "shape",
            canUndo: result.can_undo,
            canRedo: result.can_redo,
            isDirty: true,
          };
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

  setProjectUiState: async (uiState) => {
    try {
      await tauriInvoke<void>("set_project_ui_state", { uiState });
      set((s) => ({
        project: s.project ? { ...s.project, uiState } : null,
        isDirty: true,
      }));
    } catch (e) {
      console.error("Failed to set project UI state:", e);
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

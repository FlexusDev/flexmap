/**
 * Tauri IPC bridge with browser fallback.
 *
 * When running inside `cargo tauri dev`, real Tauri APIs are available.
 * When running in a browser via `npm run dev`, we provide mock implementations
 * so the UI is fully functional for development/preview.
 */

import type {
  Layer,
  ProjectFile,
  MonitorInfo,
  SourceInfo,
  CalibrationPattern,
  CalibrationTarget,
  OutputConfig,
  LayerGeometry,
  LayerProperties,
  SourceAssignment,
  InputTransform,
  InstalledShaderSourceDescriptor,
  FrameSnapshot,
  PreviewConsumers,
  PreviewDelta,
  ProjectSnapshotWithRevision,
  ProjectorWindowState,
  AudioInputDevice,
  BpmConfig,
  BpmState,
  PixelMapEffect,
  LayerGroup,
} from "../types";
import { DEFAULT_INPUT_TRANSFORM } from "../types";

// Detect if we're running inside Tauri
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const isTauri = !!(window as any).__TAURI_INTERNALS__;

let nextZIndex = 0;

function makeId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function newProject(name: string): ProjectFile {
  return {
    schemaVersion: 2,
    projectName: name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    output: { width: 3840, height: 2160, framerate: 60, monitor_preference: null },
    calibration: { enabled: false, pattern: "grid" },
    layers: [],
    uiState: null,
  };
}

// In-memory mock state for browser mode
let mockProject: ProjectFile = newProject("Untitled Project");
let mockMainFullscreen = false;
let mockProjectorOpen = false;
let mockProjectorFullscreen = false;
let mockProjectRevision = 1;
let mockPreviewCursor = 1;
let mockPreviewConsumers: PreviewConsumers = {
  editor: false,
  projector_fallback: false,
};
let mockBpmConfig: BpmConfig = {
  enabled: false,
  sensitivity: 1.0,
  gate: 0.28,
  smoothing: 0.82,
  attack: 0.85,
  decay: 0.75,
  manualBpm: 120,
};
let mockBpmState: BpmState = {
  bpm: 120,
  beat: 0,
  level: 0,
  phase: 0,
  running: false,
  selectedDeviceId: null,
  selectedDeviceName: null,
  lastBeatMs: 0,
};
const mockAudioDevices: AudioInputDevice[] = [
  {
    id: "builtin-mic",
    name: "Built-in Microphone",
    channels: 1,
    sampleRate: 48000,
    isDefault: true,
  },
  {
    id: "usb-interface",
    name: "USB Audio Interface",
    channels: 2,
    sampleRate: 44100,
    isDefault: false,
  },
];
let mockGroups: LayerGroup[] = [];
let mockPreviewLayerIds = new Set<string>();
const mockPendingRemovedLayerIds = new Set<string>();
const mockFrameSnapshotCache = new Map<string, FrameSnapshot>();

const MOCK_TEST_SOURCES: SourceInfo[] = [
  { id: "test:color_bars", name: "Test: Color Bars", protocol: "test", width: 640, height: 480, fps: 30 },
  { id: "test:gradient", name: "Test: Gradient Sweep", protocol: "test", width: 640, height: 480, fps: 30 },
  { id: "test:checkerboard", name: "Test: Checkerboard", protocol: "test", width: 640, height: 480, fps: 30 },
  { id: "test:solid", name: "Test: Solid Color Cycle", protocol: "test", width: 640, height: 480, fps: 30 },
];

const MOCK_SHADER_SOURCES: SourceInfo[] = [
  { id: "shader:plasma_flow", name: "Shader: Plasma Flow", protocol: "shader", width: 160, height: 120, fps: 30 },
  { id: "shader:kaleido_spin", name: "Shader: Kaleido Spin", protocol: "shader", width: 160, height: 120, fps: 30 },
  { id: "shader:tunnel_pulse", name: "Shader: Tunnel Pulse", protocol: "shader", width: 160, height: 120, fps: 30 },
];

let mockInstalledShaderSources: SourceInfo[] = [];

function getMockSources(): SourceInfo[] {
  return [...MOCK_TEST_SOURCES, ...MOCK_SHADER_SOURCES, ...mockInstalledShaderSources];
}

function createMockFrameSnapshot(sourceId: string): FrameSnapshot {
  const cached = mockFrameSnapshotCache.get(sourceId);
  if (cached) return cached;

  const width = 48;
  const height = 48;
  const bytes = new Uint8Array(width * height * 4);
  let hash = 0;
  for (let i = 0; i < sourceId.length; i++) {
    hash = ((hash << 5) - hash + sourceId.charCodeAt(i)) | 0;
  }
  const hue = ((hash >>> 0) % 360) / 360;
  const toChannel = (offset: number) => {
    const v = 0.5 + 0.5 * Math.sin((hue + offset) * Math.PI * 2);
    return Math.round(v * 255);
  };
  const r = toChannel(0);
  const g = toChannel(1 / 3);
  const b = toChannel(2 / 3);
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = r;
    bytes[i + 1] = g;
    bytes[i + 2] = b;
    bytes[i + 3] = 255;
  }
  const binary = String.fromCharCode(...bytes);
  const snapshot: FrameSnapshot = {
    width,
    height,
    data_b64: btoa(binary),
  };
  mockFrameSnapshotCache.set(sourceId, snapshot);
  return snapshot;
}

function computeMockPreviewFrames(): Record<string, FrameSnapshot> {
  const frames: Record<string, FrameSnapshot> = {};
  for (const layer of mockProject.layers) {
    const sourceId = layer.source?.source_id;
    if (!sourceId) continue;
    frames[layer.id] = createMockFrameSnapshot(sourceId);
  }
  return frames;
}

function markMockPreviewTopologyChanged(): void {
  const currentLayerIds = new Set(
    mockProject.layers
      .filter((layer) => !!layer.source?.source_id)
      .map((layer) => layer.id)
  );
  for (const prevId of mockPreviewLayerIds) {
    if (!currentLayerIds.has(prevId)) {
      mockPendingRemovedLayerIds.add(prevId);
    }
  }
  mockPreviewLayerIds = currentLayerIds;
  mockPreviewCursor += 1;
}

function touchMockProject(options?: { previewChanged?: boolean }): void {
  mockProjectRevision += 1;
  if (options?.previewChanged) {
    markMockPreviewTopologyChanged();
  }
}

function defaultGeometry(type: string, cols?: number, rows?: number): LayerGeometry {
  switch (type) {
    case "quad": {
      // Quad corners as 1x1 mesh: TL, TR, BL, BR (row-major: row0=[TL,TR], row1=[BL,BR])
      return {
        type: "Mesh",
        data: {
          cols: 1,
          rows: 1,
          points: [
            { x: 0.1, y: 0.1 }, // TL
            { x: 0.9, y: 0.1 }, // TR
            { x: 0.1, y: 0.9 }, // BL
            { x: 0.9, y: 0.9 }, // BR
          ],
        },
      };
    }
    case "triangle":
      return {
        type: "Triangle",
        data: {
          vertices: [
            { x: 0.5, y: 0.1 },
            { x: 0.9, y: 0.9 },
            { x: 0.1, y: 0.9 },
          ],
        },
      };
    case "mesh": {
      const c = cols ?? 4;
      const r = rows ?? 4;
      const points = [];
      for (let ri = 0; ri <= r; ri++) {
        for (let ci = 0; ci <= c; ci++) {
          points.push({
            x: 0.1 + 0.8 * (ci / c),
            y: 0.1 + 0.8 * (ri / r),
          });
        }
      }
      return { type: "Mesh", data: { cols: c, rows: r, points } };
    }
    case "circle": {
      // Circle as 1x1 mesh: 4 corners of the bounding box (center 0.5,0.5, radius 0.3)
      return {
        type: "Mesh",
        data: {
          cols: 1,
          rows: 1,
          points: [
            { x: 0.2, y: 0.2 }, // TL
            { x: 0.8, y: 0.2 }, // TR
            { x: 0.2, y: 0.8 }, // BL
            { x: 0.8, y: 0.8 }, // BR
          ],
        },
      };
    }
    default:
      return defaultGeometry("quad");
  }
}

function geometryCenter(geom: LayerGeometry): { x: number; y: number } {
  if (geom.type === "Circle") return geom.data.center;
  const points =
    geom.type === "Quad"
      ? geom.data.corners
      : geom.type === "Triangle"
        ? geom.data.vertices
        : geom.data.points;
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  return { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5 };
}

function transformPoint(
  p: { x: number; y: number },
  pivot: { x: number; y: number },
  dx: number,
  dy: number,
  rotation: number,
  sx: number,
  sy: number
): { x: number; y: number } {
  const px = p.x - pivot.x;
  const py = p.y - pivot.y;
  const sxp = px * sx;
  const syp = py * sy;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return {
    x: pivot.x + (sxp * c - syp * s) + dx,
    y: pivot.y + (sxp * s + syp * c) + dy,
  };
}

function applyGeometryDelta(
  geom: LayerGeometry,
  dx: number,
  dy: number,
  dRotation: number,
  sx: number,
  sy: number
): LayerGeometry {
  const pivot = geometryCenter(geom);
  if (geom.type === "Quad") {
    const c = geom.data.corners;
    const corners: [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number }
    ] = [
      transformPoint(c[0], pivot, dx, dy, dRotation, sx, sy),
      transformPoint(c[1], pivot, dx, dy, dRotation, sx, sy),
      transformPoint(c[2], pivot, dx, dy, dRotation, sx, sy),
      transformPoint(c[3], pivot, dx, dy, dRotation, sx, sy),
    ];
    return {
      type: "Quad",
      data: { corners },
    };
  }
  if (geom.type === "Triangle") {
    const v = geom.data.vertices;
    const vertices: [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number }
    ] = [
      transformPoint(v[0], pivot, dx, dy, dRotation, sx, sy),
      transformPoint(v[1], pivot, dx, dy, dRotation, sx, sy),
      transformPoint(v[2], pivot, dx, dy, dRotation, sx, sy),
    ];
    return {
      type: "Triangle",
      data: { vertices },
    };
  }
  if (geom.type === "Mesh") {
    return {
      type: "Mesh",
      data: {
        ...geom.data,
        points: geom.data.points.map((p) =>
          transformPoint(p, pivot, dx, dy, dRotation, sx, sy)
        ),
      },
    };
  }
  const center = transformPoint(
    geom.data.center,
    pivot,
    dx,
    dy,
    dRotation,
    sx,
    sy
  );
  return {
    type: "Circle",
    data: {
      center,
      radius_x: Math.max(0.0001, Math.abs(geom.data.radius_x * sx)),
      radius_y: Math.max(0.0001, Math.abs(geom.data.radius_y * sy)),
      rotation: geom.data.rotation + dRotation,
    },
  };
}

function updateGeometryPoint(
  geom: LayerGeometry,
  pointIndex: number,
  point: { x: number; y: number }
): LayerGeometry | null {
  if (geom.type === "Quad") {
    if (pointIndex < 0 || pointIndex > 3) return null;
    const corners = [...geom.data.corners] as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number }
    ];
    corners[pointIndex] = point;
    return { type: "Quad", data: { corners } };
  }
  if (geom.type === "Triangle") {
    if (pointIndex < 0 || pointIndex > 2) return null;
    const vertices = [...geom.data.vertices] as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number }
    ];
    vertices[pointIndex] = point;
    return { type: "Triangle", data: { vertices } };
  }
  if (geom.type === "Mesh") {
    if (pointIndex < 0 || pointIndex >= geom.data.points.length) return null;
    const points = [...geom.data.points];
    points[pointIndex] = point;
    return { type: "Mesh", data: { ...geom.data, points } };
  }
  if (geom.type === "Circle") {
    if (pointIndex !== 0) return null;
    return { type: "Circle", data: { ...geom.data, center: point } };
  }
  return null;
}

// Mock command handler for browser mode
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCommands: Record<string, (args: any) => any> = {
  get_project: () => mockProject,
  get_layers: () => mockProject.layers,

  add_layer: (args: { params: { name: string; type: string; cols?: number; rows?: number } }) => {
    const { name, type, cols, rows } = args.params;
    const layer: Layer = {
      id: makeId(),
      name,
      type,
      visible: true,
      locked: false,
      zIndex: nextZIndex++,
      source: null,
      geometry: defaultGeometry(type, cols, rows),
      input_transform: { ...DEFAULT_INPUT_TRANSFORM },
      properties: {
        brightness: 1,
        contrast: 1,
        gamma: 1,
        opacity: 1,
        feather: 0,
        beatReactive: false,
        beatAmount: 0,
      },
      blend_mode: "normal",
      pixelMap: null,
      groupId: null,
    };
    mockProject.layers.push(layer);
    touchMockProject({ previewChanged: true });
    return layer;
  },

  remove_layer: (args: { layerId: string }) => {
    const before = mockProject.layers.length;
    mockProject.layers = mockProject.layers.filter((l) => l.id !== args.layerId);
    if (mockProject.layers.length !== before) {
      touchMockProject({ previewChanged: true });
    }
    return true;
  },

  remove_layers: (args: { layerIds: string[] }) => {
    const idSet = new Set(args.layerIds);
    const before = mockProject.layers.length;
    mockProject.layers = mockProject.layers.filter((l) => !idSet.has(l.id));
    if (mockProject.layers.length !== before) {
      touchMockProject({ previewChanged: true });
    }
    return mockProject.layers.length !== before;
  },

  duplicate_layer: (args: { layerId: string }) => {
    const orig = mockProject.layers.find((l) => l.id === args.layerId);
    if (!orig) return null;
    const dup: Layer = {
      ...structuredClone(orig),
      id: makeId(),
      name: `${orig.name} (copy)`,
      zIndex: nextZIndex++,
    };
    mockProject.layers.push(dup);
    touchMockProject({ previewChanged: !!dup.source?.source_id });
    return dup;
  },

  duplicate_layers: (args: { layerIds: string[] }) => {
    const seen = new Set<string>();
    let z = Math.max(...mockProject.layers.map((l) => l.zIndex), -1) + 1;
    const duplicates: Layer[] = [];
    for (const id of args.layerIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const orig = mockProject.layers.find((l) => l.id === id);
      if (!orig) continue;
      const dup: Layer = {
        ...structuredClone(orig),
        id: makeId(),
        name: `${orig.name} (copy)`,
        zIndex: z++,
      };
      mockProject.layers.push(dup);
      duplicates.push(dup);
    }
    if (duplicates.length > 0) {
      touchMockProject({
        previewChanged: duplicates.some((layer) => !!layer.source?.source_id),
      });
    }
    return duplicates;
  },

  rename_layer: (args: { layerId: string; name: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      layer.name = args.name;
      touchMockProject();
    }
    return !!layer;
  },

  set_layer_visibility: (args: { layerId: string; visible: boolean }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      layer.visible = args.visible;
      touchMockProject();
    }
    return !!layer;
  },

  set_layer_locked: (args: { layerId: string; locked: boolean }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      layer.locked = args.locked;
      touchMockProject();
    }
    return !!layer;
  },

  reorder_layers: (args: { layerIds: string[] }) => {
    args.layerIds.forEach((id, idx) => {
      const layer = mockProject.layers.find((l) => l.id === id);
      if (layer) layer.zIndex = idx;
    });
    touchMockProject();
    return true;
  },

  begin_interaction: () => {
    // Mock: no-op, undo tracking handled by real backend
  },

  update_layer_geometry: (args: { layerId: string; geometry: LayerGeometry }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      layer.geometry = args.geometry;
      touchMockProject();
    }
    return !!layer;
  },

  update_layer_properties: (args: { layerId: string; properties: LayerProperties }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      layer.properties = args.properties;
      touchMockProject();
    }
    return !!layer;
  },

  set_layer_source: (args: { layerId: string; source: SourceAssignment | null }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      layer.source = args.source;
      touchMockProject({ previewChanged: true });
    }
    return !!layer;
  },

  set_layer_input_transform: (args: { layerId: string; inputTransform: InputTransform }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      layer.input_transform = args.inputTransform;
      touchMockProject();
    }
    return !!layer;
  },

  apply_layer_geometry_transform_delta: (args: {
    layerId: string;
    dx: number;
    dy: number;
    dRotation: number;
    sx: number;
    sy: number;
  }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (!layer) return null;
    layer.geometry = applyGeometryDelta(
      layer.geometry,
      args.dx,
      args.dy,
      args.dRotation,
      args.sx,
      args.sy
    );
    touchMockProject();
    return layer.geometry;
  },

  update_layer_point: (args: {
    layerId: string;
    pointIndex: number;
    point: { x: number; y: number };
  }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (!layer) return null;
    const next = updateGeometryPoint(layer.geometry, args.pointIndex, args.point);
    if (!next) return null;
    layer.geometry = next;
    touchMockProject();
    return next;
  },

  set_calibration_enabled: (args: { enabled: boolean }) => {
    mockProject.calibration.enabled = args.enabled;
    touchMockProject();
  },

  set_calibration_pattern: (args: { pattern: CalibrationPattern }) => {
    mockProject.calibration.pattern = args.pattern;
    touchMockProject();
  },

  set_output_config: (args: { config: OutputConfig }) => {
    mockProject.output = args.config;
    touchMockProject();
  },

  set_project_ui_state: (args: { uiState: unknown }) => {
    mockProject.uiState = args.uiState;
    touchMockProject();
  },

  set_main_window_fullscreen: (args: { fullscreen: boolean }) => {
    mockMainFullscreen = args.fullscreen;
  },
  get_main_window_fullscreen: () => mockMainFullscreen,
  sync_main_window_aspect: () => {},

  list_monitors: (): MonitorInfo[] => [
    { name: "Built-in Display", width: 2560, height: 1600, x: 0, y: 0, scale_factor: 2.0 },
    { name: "Projector (HDMI)", width: 1920, height: 1080, x: 2560, y: 0, scale_factor: 1.0 },
  ],

  refresh_sources: (): SourceInfo[] => getMockSources(),
  list_sources: (): SourceInfo[] => getMockSources(),
  set_installed_shader_sources: (args: { sources: InstalledShaderSourceDescriptor[] }): number => {
    mockInstalledShaderSources = args.sources.map((source) => ({
      id: source.id,
      name: source.name,
      protocol: "shader",
      width: 160,
      height: 120,
      fps: 30,
    }));
    markMockPreviewTopologyChanged();
    return mockInstalledShaderSources.length;
  },

  list_audio_input_devices: (): AudioInputDevice[] => mockAudioDevices,
  set_audio_input_device: (args: { deviceId: string }): BpmState => {
    const device = mockAudioDevices.find((candidate) => candidate.id === args.deviceId) ?? null;
    mockBpmState.selectedDeviceId = device?.id ?? null;
    mockBpmState.selectedDeviceName = device?.name ?? null;
    mockBpmState.running = !!device && mockBpmConfig.enabled;
    return { ...mockBpmState };
  },
  set_bpm_config: (args: { config: BpmConfig }): BpmState => {
    mockBpmConfig = { ...mockBpmConfig, ...args.config };
    mockBpmState.bpm = mockBpmConfig.manualBpm > 0 ? mockBpmConfig.manualBpm : mockBpmState.bpm;
    mockBpmState.running = mockBpmConfig.enabled && !!mockBpmState.selectedDeviceId;
    return { ...mockBpmState };
  },
  get_bpm_state: (): BpmState => {
    if (!mockBpmConfig.enabled) {
      mockBpmState.beat = 0;
      mockBpmState.level = 0;
      mockBpmState.phase = 0;
      mockBpmState.running = false;
      return { ...mockBpmState };
    }
    const now = Date.now();
    const t = now / 1000;
    const bpm = Math.max(1, mockBpmState.bpm || mockBpmConfig.manualBpm || 120);
    const phase = ((t * bpm) / 60) % 1;
    const beat = phase < 0.12 ? 1 : 0;
    mockBpmState.phase = phase;
    mockBpmState.beat = beat;
    mockBpmState.level = beat ? 0.9 : 0.24;
    mockBpmState.lastBeatMs = beat ? now : mockBpmState.lastBeatMs;
    mockBpmState.running = !!mockBpmState.selectedDeviceId;
    return { ...mockBpmState };
  },
  tap_tempo: (): BpmState => {
    mockBpmState.lastBeatMs = Date.now();
    mockBpmState.beat = 1;
    mockBpmState.level = 1;
    return { ...mockBpmState };
  },

  add_media_file: (args: { path: string }): SourceInfo => {
    const name = args.path.split("/").pop() ?? "unknown.png";
    return { id: `media:${name}`, name, protocol: "media", width: 1920, height: 1080, fps: null };
  },

  remove_media_file: (_args: { sourceId: string }) => {
    return true;
  },

  connect_source: (args: { layerId: string; sourceId: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    const source = getMockSources().find((s) => s.id === args.sourceId);
    if (layer) {
      layer.source = {
        protocol: source?.protocol ?? "test",
        source_id: args.sourceId,
        display_name: source?.name ?? args.sourceId,
      };
      touchMockProject({ previewChanged: true });
    }
    return true;
  },

  disconnect_source: (args: { layerId: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      layer.source = null;
      touchMockProject({ previewChanged: true });
    }
    return true;
  },

  set_layer_blend_mode: (args: { layerId: string; blendMode: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      (layer as Layer).blend_mode = args.blendMode as Layer["blend_mode"];
      touchMockProject();
    }
    return !!layer;
  },

  poll_layer_frame: () => null,
  poll_all_frames: () => computeMockPreviewFrames(),
  poll_all_frames_delta: (args: { cursor: number }): PreviewDelta => {
    if ((args.cursor ?? 0) >= mockPreviewCursor) {
      return {
        cursor: mockPreviewCursor,
        removed_layer_ids: [],
        changed: {},
      };
    }
    const removed_layer_ids = Array.from(mockPendingRemovedLayerIds);
    mockPendingRemovedLayerIds.clear();
    return {
      cursor: mockPreviewCursor,
      removed_layer_ids,
      changed: computeMockPreviewFrames(),
    };
  },
  set_preview_consumers: (args: {
    editor?: boolean;
    projector_fallback?: boolean;
    projectorFallback?: boolean;
  }): PreviewConsumers => {
    if (typeof args.editor === "boolean") {
      mockPreviewConsumers.editor = args.editor;
    }
    const projectorFlag = typeof args.projector_fallback === "boolean"
      ? args.projector_fallback
      : args.projectorFallback;
    if (typeof projectorFlag === "boolean") {
      mockPreviewConsumers.projector_fallback = projectorFlag;
    }
    return { ...mockPreviewConsumers };
  },
  get_project_if_changed: (args: { revision: number }): ProjectSnapshotWithRevision | null => {
    if ((args.revision ?? 0) >= mockProjectRevision) return null;
    return {
      revision: mockProjectRevision,
      project: mockProject,
    };
  },

  open_projector_window: () => {
    mockProjectorOpen = true;
  },
  close_projector_window: () => {
    mockProjectorOpen = false;
    mockProjectorFullscreen = false;
  },
  set_projector_fullscreen: (args: { fullscreen: boolean }) => {
    if (mockProjectorOpen) {
      mockProjectorFullscreen = args.fullscreen;
    }
  },
  get_projector_fullscreen: () => (mockProjectorOpen ? mockProjectorFullscreen : false),
  get_projector_window_state: (): ProjectorWindowState => ({
    open: mockProjectorOpen,
    gpu_native: false,
  }),
  retarget_projector: () => {},

  save_project: (args: { path?: string }) => {
    return args.path ?? "mock://project.flexmap";
  },

  load_project: () => {
    touchMockProject({ previewChanged: true });
    return mockProject;
  },

  new_project: () => {
    mockProject = newProject("Untitled Project");
    nextZIndex = 0;
    touchMockProject({ previewChanged: true });
    return mockProject;
  },

  is_dirty: () => false,
  has_recovery: () => false,
  load_recovery: () => mockProject,

  undo: () => null,
  redo: () => null,
  get_render_stats: () => ({
    gpu_name: "Mock GPU (Apple M1 Pro)", gpu_ready: true,
    gpu_backend: "Metal", gpu_driver: "Apple", gpu_device_type: "IntegratedGpu",
    frame_pacing: "Show (VSync)", texture_count: 2,
    buffer_cache_hits: 1200, buffer_cache_misses: 4,
  }),
  get_source_diagnostics: () => [
    ...getMockSources().map((source) => ({
      source_id: source.id,
      name: source.name,
      protocol: source.protocol,
      width: source.width,
      height: source.height,
      fps: source.fps,
      layers_using: [] as string[],
    })),
  ],
  set_frame_pacing: () => {},
  get_projector_stats: () => ({ gpu_native: false, fps: 0, frametime_ms: 0 }),
  get_system_stats: () => ({
    process_cpu: 12.5, process_mem: 128 * 1024 * 1024,
    total_mem: 16 * 1024 * 1024 * 1024, used_mem: 8 * 1024 * 1024 * 1024,
    system_cpu: 25.0, cpu_count: 8, cpu_name: "Mock CPU",
  }),

  set_calibration_target: (args: { target: CalibrationTarget | null }) => {
    mockProject.calibration.target_layer = args.target;
    touchMockProject();
  },

  subdivide_mesh: (args: { layerId: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (!layer || layer.geometry.type !== "Mesh") return null;
    const d = layer.geometry.data;
    const newCols = d.cols * 2;
    const newRows = d.rows * 2;
    const newPoints = [];
    for (let ri = 0; ri <= newRows; ri++) {
      for (let ci = 0; ci <= newCols; ci++) {
        const origR = ri / 2;
        const origC = ci / 2;
        const r0 = Math.floor(origR), c0 = Math.floor(origC);
        const r1 = Math.min(r0 + (ri % 2), d.rows), c1 = Math.min(c0 + (ci % 2), d.cols);
        const p00 = d.points[r0 * (d.cols + 1) + c0];
        const p01 = d.points[r0 * (d.cols + 1) + c1];
        const p10 = d.points[r1 * (d.cols + 1) + c0];
        const p11 = d.points[r1 * (d.cols + 1) + c1];
        newPoints.push({ x: (p00.x + p01.x + p10.x + p11.x) / 4, y: (p00.y + p01.y + p10.y + p11.y) / 4 });
      }
    }
    const newGeometry: LayerGeometry = { type: "Mesh", data: { cols: newCols, rows: newRows, points: newPoints } };
    layer.geometry = newGeometry;
    touchMockProject();
    return newGeometry;
  },

  check_syphon_status: () => ({
    bridge_compiled: true,
    bridge_available: true,
    search_paths: [
      ["(app bundle)/Contents/Frameworks/Syphon.framework", true],
    ],
    message: "Syphon is ready. Syphon servers should appear automatically.",
  }),

  install_syphon_framework: () => "Syphon.framework loaded successfully. Refresh sources to see Syphon servers.",

  // Pixel mapping & layer group mocks
  set_layer_pixel_map: (_args: { layerId: string; pixelMap: PixelMapEffect | null }) => {
    const layer = mockProject.layers.find((l) => l.id === _args.layerId);
    if (layer) {
      layer.pixelMap = _args.pixelMap;
      touchMockProject();
    }
    return true;
  },

  create_layer_group: (args: { name: string; layerIds: string[] }): LayerGroup => {
    const group: LayerGroup = {
      id: makeId(),
      name: args.name,
      layerIds: [...args.layerIds],
      visible: true,
      locked: false,
      pixelMap: null,
    };
    mockGroups.push(group);
    for (const lid of args.layerIds) {
      const layer = mockProject.layers.find((l) => l.id === lid);
      if (layer) layer.groupId = group.id;
    }
    touchMockProject();
    return group;
  },

  delete_layer_group: (args: { groupId: string }) => {
    const group = mockGroups.find((g) => g.id === args.groupId);
    if (group) {
      for (const lid of group.layerIds) {
        const layer = mockProject.layers.find((l) => l.id === lid);
        if (layer) layer.groupId = null;
      }
      mockGroups = mockGroups.filter((g) => g.id !== args.groupId);
      touchMockProject();
    }
    return true;
  },

  set_group_pixel_map: (args: { groupId: string; pixelMap: PixelMapEffect | null }) => {
    const group = mockGroups.find((g) => g.id === args.groupId);
    if (group) {
      group.pixelMap = args.pixelMap;
      touchMockProject();
    }
    return true;
  },

  get_groups: (): LayerGroup[] => [...mockGroups],

  set_bpm_multiplier: (_args: { multiplier: number }) => null,
  set_bpm_source: (_args: { source: string }) => null,
  tap_bpm: (): BpmState => ({ ...mockBpmState }),

  set_preview_quality: (_args: { quality: number }) => null,
  get_composited_preview: (_args: { cursor: number }) => null, // No composited preview in browser mode
};

/**
 * Invoke a Tauri command. Falls back to mock implementation in browser.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tauriInvoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }

  // Browser mock
  const handler = mockCommands[cmd];
  if (!handler) {
    console.warn(`[mock] Unknown command: ${cmd}`, args);
    return undefined as T;
  }

  // Simulate async
  await new Promise((r) => setTimeout(r, 5));
  return handler(args ?? {}) as T;
}

/**
 * Open a file dialog. Returns a path string or null.
 */
export async function tauriOpenDialog(options?: {
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ filters: options?.filters });
    return typeof result === "string" ? result : null;
  }

  // Browser fallback — prompt
  return window.prompt("Enter project file path to open:") ?? null;
}

/**
 * Save file dialog. Returns a path string or null.
 */
export async function tauriSaveDialog(options?: {
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
}): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const result = await save({
      filters: options?.filters,
      defaultPath: options?.defaultPath,
    });
    return result ?? null;
  }

  // Browser fallback — prompt
  return window.prompt("Save project as:", options?.defaultPath ?? "project.flexmap") ?? null;
}

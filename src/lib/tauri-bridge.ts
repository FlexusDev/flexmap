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
  UvAdjustment,
  InputTransform,
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
          face_groups: [],
          masked_faces: [],
          uv_overrides: {},
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
      return { type: "Mesh", data: { cols: c, rows: r, points, face_groups: [], masked_faces: [], uv_overrides: {} } };
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
          face_groups: [],
          masked_faces: [],
          uv_overrides: {},
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
      properties: { brightness: 1, contrast: 1, gamma: 1, opacity: 1, feather: 0 },
      blend_mode: "normal",
    };
    mockProject.layers.push(layer);
    return layer;
  },

  remove_layer: (args: { layerId: string }) => {
    mockProject.layers = mockProject.layers.filter((l) => l.id !== args.layerId);
    return true;
  },

  remove_layers: (args: { layerIds: string[] }) => {
    const idSet = new Set(args.layerIds);
    const before = mockProject.layers.length;
    mockProject.layers = mockProject.layers.filter((l) => !idSet.has(l.id));
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
    return duplicates;
  },

  rename_layer: (args: { layerId: string; name: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) layer.name = args.name;
    return !!layer;
  },

  set_layer_visibility: (args: { layerId: string; visible: boolean }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) layer.visible = args.visible;
    return !!layer;
  },

  set_layer_locked: (args: { layerId: string; locked: boolean }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) layer.locked = args.locked;
    return !!layer;
  },

  reorder_layers: (args: { layerIds: string[] }) => {
    args.layerIds.forEach((id, idx) => {
      const layer = mockProject.layers.find((l) => l.id === id);
      if (layer) layer.zIndex = idx;
    });
    return true;
  },

  begin_interaction: () => {
    // Mock: no-op, undo tracking handled by real backend
  },

  update_layer_geometry: (args: { layerId: string; geometry: LayerGeometry }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) layer.geometry = args.geometry;
    return !!layer;
  },

  update_layer_properties: (args: { layerId: string; properties: LayerProperties }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) layer.properties = args.properties;
    return !!layer;
  },

  set_layer_source: (args: { layerId: string; source: SourceAssignment | null }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) layer.source = args.source;
    return !!layer;
  },

  set_layer_input_transform: (args: { layerId: string; inputTransform: InputTransform }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) layer.input_transform = args.inputTransform;
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
    return next;
  },

  set_calibration_enabled: (args: { enabled: boolean }) => {
    mockProject.calibration.enabled = args.enabled;
  },

  set_calibration_pattern: (args: { pattern: CalibrationPattern }) => {
    mockProject.calibration.pattern = args.pattern;
  },

  set_output_config: (args: { config: OutputConfig }) => {
    mockProject.output = args.config;
  },

  set_project_ui_state: (args: { uiState: unknown }) => {
    mockProject.uiState = args.uiState;
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

  refresh_sources: (): SourceInfo[] => [
    { id: "test:color_bars", name: "Test: Color Bars", protocol: "test", width: 640, height: 480, fps: 30 },
    { id: "test:gradient", name: "Test: Gradient Sweep", protocol: "test", width: 640, height: 480, fps: 30 },
    { id: "test:checkerboard", name: "Test: Checkerboard", protocol: "test", width: 640, height: 480, fps: 30 },
    { id: "test:solid", name: "Test: Solid Color Cycle", protocol: "test", width: 640, height: 480, fps: 30 },
  ],
  list_sources: (): SourceInfo[] => [
    { id: "test:color_bars", name: "Test: Color Bars", protocol: "test", width: 640, height: 480, fps: 30 },
    { id: "test:gradient", name: "Test: Gradient Sweep", protocol: "test", width: 640, height: 480, fps: 30 },
    { id: "test:checkerboard", name: "Test: Checkerboard", protocol: "test", width: 640, height: 480, fps: 30 },
    { id: "test:solid", name: "Test: Solid Color Cycle", protocol: "test", width: 640, height: 480, fps: 30 },
  ],

  add_media_file: (args: { path: string }): SourceInfo => {
    const name = args.path.split("/").pop() ?? "unknown.png";
    return { id: `media:${name}`, name, protocol: "media", width: 1920, height: 1080, fps: null };
  },

  remove_media_file: (args: { sourceId: string }) => {
    console.log("[mock] Remove media file:", args.sourceId);
    return true;
  },

  connect_source: (args: { layerId: string; sourceId: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) {
      layer.source = { protocol: "test", source_id: args.sourceId, display_name: args.sourceId };
    }
    return true;
  },

  disconnect_source: (args: { layerId: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) layer.source = null;
    return true;
  },

  set_layer_blend_mode: (args: { layerId: string; blendMode: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (layer) (layer as Layer).blend_mode = args.blendMode as Layer["blend_mode"];
    return !!layer;
  },

  poll_layer_frame: () => null,
  poll_all_frames: () => ({}),

  open_projector_window: () => {
    mockProjectorOpen = true;
    console.log("[mock] Projector window opened");
  },
  close_projector_window: () => {
    mockProjectorOpen = false;
    mockProjectorFullscreen = false;
    console.log("[mock] Projector window closed");
  },
  set_projector_fullscreen: (args: { fullscreen: boolean }) => {
    if (mockProjectorOpen) {
      mockProjectorFullscreen = args.fullscreen;
    }
  },
  get_projector_fullscreen: () => (mockProjectorOpen ? mockProjectorFullscreen : false),
  retarget_projector: () => {},

  save_project: (args: { path?: string }) => {
    const path = args.path ?? "mock://project.flexmap";
    console.log("[mock] Project saved to", path);
    return path;
  },

  load_project: () => mockProject,

  new_project: () => {
    mockProject = newProject("Untitled Project");
    nextZIndex = 0;
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
    { source_id: "test:color_bars", name: "Test: Color Bars", protocol: "test", width: 640, height: 480, fps: 30, layers_using: [] },
    { source_id: "test:gradient", name: "Test: Gradient Sweep", protocol: "test", width: 640, height: 480, fps: 30, layers_using: [] },
  ],
  set_frame_pacing: () => {},
  get_projector_stats: () => ({ gpu_native: false, fps: 0, frametime_ms: 0 }),
  get_system_stats: () => ({
    process_cpu: 12.5, process_mem: 128 * 1024 * 1024,
    total_mem: 16 * 1024 * 1024 * 1024, used_mem: 8 * 1024 * 1024 * 1024,
    system_cpu: 25.0, cpu_count: 8, cpu_name: "Mock CPU",
  }),

  toggle_face_mask: (args: { layerId: string; faceIndices: number[]; masked: boolean }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (!layer || layer.geometry.type !== "Mesh") return false;
    const data = layer.geometry.data as { masked_faces?: number[] };
    data.masked_faces = data.masked_faces ?? [];
    if (args.masked) {
      for (const idx of args.faceIndices) {
        if (!data.masked_faces.includes(idx)) data.masked_faces.push(idx);
      }
    } else {
      data.masked_faces = data.masked_faces.filter((f) => !args.faceIndices.includes(f));
    }
    return true;
  },

  create_face_group: (args: { layerId: string; name: string; faceIndices: number[]; color: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (!layer || layer.geometry.type !== "Mesh") return false;
    const data = layer.geometry.data as { face_groups?: { name: string; face_indices: number[]; color: string }[] };
    data.face_groups = data.face_groups ?? [];
    data.face_groups.push({ name: args.name, face_indices: args.faceIndices, color: args.color });
    return true;
  },

  remove_face_group: (args: { layerId: string; groupIndex: number }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (!layer || layer.geometry.type !== "Mesh") return false;
    const data = layer.geometry.data as { face_groups?: unknown[] };
    data.face_groups = data.face_groups ?? [];
    if (args.groupIndex < data.face_groups.length) {
      data.face_groups.splice(args.groupIndex, 1);
      return true;
    }
    return false;
  },

  rename_face_group: (args: { layerId: string; groupIndex: number; name: string }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (!layer || layer.geometry.type !== "Mesh") return false;
    const data = layer.geometry.data as { face_groups?: { name: string }[] };
    data.face_groups = data.face_groups ?? [];
    if (args.groupIndex < data.face_groups.length) {
      data.face_groups[args.groupIndex].name = args.name;
      return true;
    }
    return false;
  },

  set_calibration_target: (args: { target: CalibrationTarget | null }) => {
    mockProject.calibration.target_layer = args.target;
  },

  set_face_uv_override: (args: { layerId: string; faceIndex: number; adjustment: UvAdjustment }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (!layer || layer.geometry.type !== "Mesh") return false;
    const data = layer.geometry.data as { uv_overrides?: Record<number, UvAdjustment> };
    data.uv_overrides = data.uv_overrides ?? {};
    data.uv_overrides[args.faceIndex] = args.adjustment;
    return true;
  },

  clear_face_uv_override: (args: { layerId: string; faceIndex: number }) => {
    const layer = mockProject.layers.find((l) => l.id === args.layerId);
    if (!layer || layer.geometry.type !== "Mesh") return false;
    const data = layer.geometry.data as { uv_overrides?: Record<number, UvAdjustment> };
    if (data.uv_overrides && args.faceIndex in data.uv_overrides) {
      delete data.uv_overrides[args.faceIndex];
      return true;
    }
    return false;
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
    const newGeometry: LayerGeometry = { type: "Mesh", data: { cols: newCols, rows: newRows, points: newPoints, face_groups: [], masked_faces: [], uv_overrides: {} } };
    layer.geometry = newGeometry;
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

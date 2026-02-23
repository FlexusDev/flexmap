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
  OutputConfig,
  LayerGeometry,
  LayerProperties,
  SourceAssignment,
} from "../types";

// Detect if we're running inside Tauri
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const isTauri = !!(window as any).__TAURI_INTERNALS__;

let nextZIndex = 0;

function makeId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function newProject(name: string): ProjectFile {
  return {
    schemaVersion: 1,
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

function defaultGeometry(type: string, cols?: number, rows?: number): LayerGeometry {
  switch (type) {
    case "quad":
      return {
        type: "Quad",
        data: {
          corners: [
            { x: 0.1, y: 0.1 },
            { x: 0.9, y: 0.1 },
            { x: 0.9, y: 0.9 },
            { x: 0.1, y: 0.9 },
          ],
        },
      };
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
    case "circle":
      return {
        type: "Circle",
        data: {
          center: { x: 0.5, y: 0.5 },
          radius: 0.3,
          bounds: [
            { x: 0.2, y: 0.2 },
            { x: 0.8, y: 0.2 },
            { x: 0.8, y: 0.8 },
            { x: 0.2, y: 0.8 },
          ],
        },
      };
    default:
      return defaultGeometry("quad");
  }
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

  set_calibration_enabled: (args: { enabled: boolean }) => {
    mockProject.calibration.enabled = args.enabled;
  },

  set_calibration_pattern: (args: { pattern: CalibrationPattern }) => {
    mockProject.calibration.pattern = args.pattern;
  },

  set_output_config: (args: { config: OutputConfig }) => {
    mockProject.output = args.config;
  },

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
    console.log("[mock] Projector window opened");
  },
  close_projector_window: () => {
    console.log("[mock] Projector window closed");
  },
  retarget_projector: () => {},

  save_project: (args: { path?: string }) => {
    const path = args.path ?? "mock://project.auramap";
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
  return window.prompt("Save project as:", options?.defaultPath ?? "project.auramap") ?? null;
}

// Core types mirroring the Rust backend models.
//
// Naming convention: interfaces for persisted scene structs (Layer, OutputConfig,
// CalibrationConfig, etc.) use snake_case field names matching their Rust definitions
// because they're serialized to .flexmap project files. IPC-only structs (RenderStats,
// SystemStats, MonitorInfo, PreviewDelta, etc.) also currently use snake_case for
// consistency with the Rust side. Audio/BPM structs use camelCase because their Rust
// counterparts have #[serde(rename_all = "camelCase")].
// TODO: add rename_all = "camelCase" to all IPC-only Rust structs and update TS types.

export interface Point2D {
  x: number;
  y: number;
}

export interface InputTransform {
  offset: [number, number];
  rotation: number;
  scale: [number, number];
}

export interface CalibrationTarget {
  layer_id: string;
  // face_indices removed — calibration targets the whole layer
}

export type LayerGeometry =
  | { type: "Quad"; data: { corners: [Point2D, Point2D, Point2D, Point2D] } }
  | { type: "Triangle"; data: { vertices: [Point2D, Point2D, Point2D] } }
  | {
      type: "Mesh";
      data: {
        cols: number;
        rows: number;
        points: Point2D[];
      };
    }
  | {
      type: "Circle";
      data: {
        center: Point2D;
        radius_x: number;
        radius_y: number;
        rotation: number;
      };
    };

export interface LayerProperties {
  brightness: number;
  contrast: number;
  gamma: number;
  opacity: number;
  feather: number;
  beatReactive: boolean;
  beatAmount: number;
}

export interface SourceAssignment {
  protocol: string;
  source_id: string;
  display_name: string;
}

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "colorDodge"
  | "colorBurn"
  | "softLight"
  | "hardLight"
  | "difference"
  | "exclusion"
  | "additive";

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "colorDodge", label: "Color Dodge" },
  { value: "colorBurn", label: "Color Burn" },
  { value: "softLight", label: "Soft Light" },
  { value: "hardLight", label: "Hard Light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
  { value: "additive", label: "Additive" },
];

export type PixelMapPattern = "chase" | "stripes" | "gradient" | "wave" | "strobe" | "radial";

export const PIXEL_MAP_PATTERNS: { value: PixelMapPattern; label: string }[] = [
  { value: "chase", label: "Chase" },
  { value: "stripes", label: "Stripes" },
  { value: "gradient", label: "Gradient" },
  { value: "wave", label: "Wave" },
  { value: "strobe", label: "Strobe" },
  { value: "radial", label: "Radial" },
];

export type PatternCoordMode = "perShape" | "worldSpace";

export interface PixelMapEffect {
  enabled: boolean;
  pattern: PixelMapPattern;
  coordMode: PatternCoordMode;
  speed: number;
  width: number;
  intensity: number;
  direction: number;
  invert: boolean;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  worldBox: [number, number, number, number];
}

export const DEFAULT_PIXEL_MAP_EFFECT: PixelMapEffect = {
  enabled: true,
  pattern: "chase",
  coordMode: "perShape",
  speed: 1.0,
  width: 0.5,
  intensity: 1.0,
  direction: 0,
  invert: false,
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
  worldBox: [0, 0, 1, 1],
};

export interface LayerGroup {
  id: string;
  name: string;
  layerIds: string[];
  visible: boolean;
  locked: boolean;
  pixelMap: PixelMapEffect | null;
}

export interface Layer {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  zIndex: number;
  source: SourceAssignment | null;
  geometry: LayerGeometry;
  input_transform: InputTransform;
  properties: LayerProperties;
  blend_mode: BlendMode;
  pixelMap: PixelMapEffect | null;
  groupId: string | null;
}

export interface OutputConfig {
  width: number;
  height: number;
  framerate: number;
  monitor_preference: string | null;
}

export type AspectRatioId =
  | "1:1"
  | "4:3"
  | "5:4"
  | "3:2"
  | "16:10"
  | "16:9"
  | "17:9"
  | "21:9"
  | "32:9"
  | "9:16"
  | "3:4";

export interface AspectRatioUiState {
  lockEnabled: boolean;
  ratioId: AspectRatioId;
}

export interface ProjectUiState {
  aspectRatio?: Partial<AspectRatioUiState>;
  [key: string]: unknown;
}

export type CalibrationPattern =
  | "grid"
  | "crosshair"
  | "checkerboard"
  | "fullWhite"
  | "colorBars"
  | "black";

export interface CalibrationConfig {
  enabled: boolean;
  pattern: CalibrationPattern;
  target_layer?: CalibrationTarget | null;
}

export interface ProjectFile {
  schemaVersion: number;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  output: OutputConfig;
  calibration: CalibrationConfig;
  layers: Layer[];
  uiState: unknown;
}

export interface MonitorInfo {
  name: string | null;
  width: number;
  height: number;
  x: number;
  y: number;
  scale_factor: number;
}

export interface SourceInfo {
  id: string;
  name: string;
  protocol: string;
  width: number | null;
  height: number | null;
  fps: number | null;
}

export interface ShaderLibraryEntry {
  id: string;
  name: string;
  author: string;
  tags: string[];
  categories?: string[];
  description?: string;
  thumbnailUrl: string;
  sourceId?: string;
  downloadUrl?: string;
  isBundled: boolean;
  isInstalled?: boolean;
  installedAt?: string;
  previewFragment?: string;
  sourceCode?: string;
  license: string;
  sourceUrl: string;
}

export interface InstalledShaderSourceDescriptor {
  id: string;
  name: string;
  seed: number;
  sourceHash?: string;
  installedAt?: string;
  sourceCode?: string;
}

export interface UndoRedoResult {
  layers: Layer[];
  can_undo: boolean;
  can_redo: boolean;
}

export type FramePacingMode = "show" | "lowLatency" | "benchmark";
export type EditorSelectionMode = "shape" | "input";
export type PerformanceProfile = "max_fps" | "balanced";

export interface RenderStats {
  gpu_name: string;
  gpu_ready: boolean;
  gpu_backend: string;
  gpu_driver: string;
  gpu_device_type: string;
  frame_pacing: string;
  texture_count: number;
  buffer_cache_hits: number;
  buffer_cache_misses: number;
}

export interface SourceDiagnostics {
  source_id: string;
  name: string;
  protocol: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  layers_using: string[];
}

export interface SystemStats {
  process_cpu: number;
  process_mem: number;
  total_mem: number;
  used_mem: number;
  system_cpu: number;
  cpu_count: number;
  cpu_name: string;
}

export interface ProjectorStats {
  gpu_native: boolean;
  fps: number;
  frametime_ms: number;
}

export interface ProjectorWindowState {
  open: boolean;
  gpu_native: boolean;
}

export interface AudioInputDevice {
  id: string;
  name: string;
  channels: number;
  sampleRate: number;
  isDefault: boolean;
}

export interface BpmConfig {
  enabled: boolean;
  sensitivity: number;
  gate: number;
  smoothing: number;
  attack: number;
  decay: number;
  manualBpm: number;
}

export interface BpmState {
  bpm: number;
  beat: number;
  level: number;
  phase: number;
  running: boolean;
  selectedDeviceId: string | null;
  selectedDeviceName: string | null;
  lastBeatMs: number;
}

export interface FrameSnapshot {
  width: number;
  height: number;
  data_b64: string;
}

export interface PreviewDelta {
  cursor: number;
  removed_layer_ids: string[];
  changed: Record<string, FrameSnapshot>;
}

export interface PreviewConsumers {
  editor: boolean;
  projector_fallback: boolean;
}

export interface ProjectSnapshotWithRevision {
  revision: number;
  project: ProjectFile;
}

export const DEFAULT_LAYER_PROPERTIES: LayerProperties = {
  brightness: 1.0,
  contrast: 1.0,
  gamma: 1.0,
  opacity: 1.0,
  feather: 0.0,
  beatReactive: false,
  beatAmount: 0.0,
};

export const DEFAULT_INPUT_TRANSFORM: InputTransform = {
  offset: [0, 0],
  rotation: 0,
  scale: [1, 1],
};

// Core types mirroring the Rust backend models

export interface Point2D {
  x: number;
  y: number;
}

export type LayerGeometry =
  | { type: "Quad"; data: { corners: [Point2D, Point2D, Point2D, Point2D] } }
  | { type: "Triangle"; data: { vertices: [Point2D, Point2D, Point2D] } }
  | { type: "Mesh"; data: { cols: number; rows: number; points: Point2D[] } }
  | {
      type: "Circle";
      data: {
        center: Point2D;
        radius: number;
        bounds: [Point2D, Point2D, Point2D, Point2D];
      };
    };

export interface LayerProperties {
  brightness: number;
  contrast: number;
  gamma: number;
  opacity: number;
  feather: number;
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

export interface Layer {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  zIndex: number;
  source: SourceAssignment | null;
  geometry: LayerGeometry;
  properties: LayerProperties;
  blend_mode: BlendMode;
}

export interface OutputConfig {
  width: number;
  height: number;
  framerate: number;
  monitor_preference: string | null;
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

export interface UndoRedoResult {
  layers: Layer[];
  can_undo: boolean;
  can_redo: boolean;
}

export interface RenderStats {
  gpu_name: string;
  gpu_ready: boolean;
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

export interface FrameSnapshot {
  width: number;
  height: number;
  data_b64: string;
}

export const DEFAULT_LAYER_PROPERTIES: LayerProperties = {
  brightness: 1.0,
  contrast: 1.0,
  gamma: 1.0,
  opacity: 1.0,
  feather: 0.0,
};

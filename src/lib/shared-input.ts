import type {
  InputTransform,
  Layer,
  LayerGeometry,
  LayerGroup,
  SharedInputMapping,
} from "../types";
import { DEFAULT_SHARED_INPUT_MAPPING } from "../types";

export interface NormalizedUv {
  u: number;
  v: number;
}

export function applyInputTransformToUv(
  uv: NormalizedUv,
  t: InputTransform
): NormalizedUv {
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const du = (uv.u - 0.5) * t.scale[0];
  const dv = (uv.v - 0.5) * t.scale[1];
  return {
    u: du * c - dv * s + 0.5 + t.offset[0],
    v: du * s + dv * c + 0.5 + t.offset[1],
  };
}

export function applySharedInputMapping(
  worldUv: NormalizedUv,
  mapping: SharedInputMapping
): NormalizedUv {
  const boxW = Math.max(Math.abs(mapping.box[2]), 0.0001);
  const boxH = Math.max(Math.abs(mapping.box[3]), 0.0001);
  const local = {
    u: (worldUv.u - mapping.box[0]) / boxW,
    v: (worldUv.v - mapping.box[1]) / boxH,
  };
  const c = Math.cos(mapping.rotation);
  const s = Math.sin(mapping.rotation);
  const du = (local.u - 0.5) * mapping.scaleX;
  const dv = (local.v - 0.5) * mapping.scaleY;
  return {
    u: du * c - dv * s + 0.5 + mapping.offsetX,
    v: du * s + dv * c + 0.5 + mapping.offsetY,
  };
}

export function resolveLayerSharedInput(
  layer: Layer,
  groups: LayerGroup[]
): SharedInputMapping | null {
  if (!layer.groupId) return null;
  const group = groups.find((candidate) => candidate.id === layer.groupId);
  if (!group?.sharedInput?.enabled) return null;
  return group.sharedInput;
}

export function getGeometryBounds(geometry: LayerGeometry): [number, number, number, number] {
  if (geometry.type === "Circle") {
    return [
      geometry.data.center.x - geometry.data.radius_x,
      geometry.data.center.y - geometry.data.radius_y,
      geometry.data.radius_x * 2,
      geometry.data.radius_y * 2,
    ];
  }

  const points =
    geometry.type === "Quad"
      ? geometry.data.corners
      : geometry.type === "Triangle"
        ? geometry.data.vertices
        : geometry.data.points;

  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));
  return [minX, minY, maxX - minX, maxY - minY];
}

export function defaultSharedInputForLayers(layers: Layer[]): SharedInputMapping {
  if (layers.length === 0) {
    return { ...DEFAULT_SHARED_INPUT_MAPPING };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const layer of layers) {
    const [x, y, w, h] = getGeometryBounds(layer.geometry);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  return {
    ...DEFAULT_SHARED_INPUT_MAPPING,
    box: [minX, minY, Math.max(0.01, maxX - minX), Math.max(0.01, maxY - minY)],
  };
}

export function groupUsesMixedSources(group: LayerGroup, layers: Layer[]): boolean {
  const sourceIds = new Set<string>();
  for (const layer of layers) {
    if (!group.layerIds.includes(layer.id)) continue;
    sourceIds.add(layer.source?.source_id ?? "__none__");
  }
  return sourceIds.size > 1;
}

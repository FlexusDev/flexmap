import type {
  DimmerCurve,
  DimmerEffect,
  Layer,
  LayerGroup,
} from "../types";

function fract(value: number): number {
  return ((value % 1) + 1) % 1;
}

function currentDimmerTimeSeconds(): number {
  return Date.now() / 1000;
}

function sortLayersByVisualOrder(layers: Layer[]): Layer[] {
  return [...layers].sort((a, b) => {
    if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
    return layers.indexOf(a) - layers.indexOf(b);
  });
}

function resolveGroupForLayer(layer: Layer, groups: LayerGroup[]): LayerGroup | null {
  if (!layer.groupId) return null;
  return groups.find((group) => group.id === layer.groupId) ?? null;
}

export function isDutyCurve(curve: DimmerCurve): boolean {
  return curve === "square" || curve === "pulse";
}

export function evaluateDimmerCurve(
  curve: DimmerCurve,
  phase: number,
  dutyCycle: number
): number {
  const wrapped = fract(phase);
  const duty = Math.min(0.99, Math.max(0.01, dutyCycle));
  switch (curve) {
    case "sine":
      return Math.sin(wrapped * Math.PI * 2) * 0.5 + 0.5;
    case "triangle":
      return 1 - Math.abs(wrapped * 2 - 1);
    case "rampUp":
      return wrapped;
    case "rampDown":
      return 1 - wrapped;
    case "square":
      return wrapped < duty ? 1 : 0;
    case "pulse":
      return wrapped < duty ? 1 - wrapped / duty : 0;
  }
}

function computeGroupPhaseOffset(
  layer: Layer,
  layers: Layer[],
  group: LayerGroup,
  effect: DimmerEffect
): number {
  if (Math.abs(effect.phaseSpread) < 1e-6) return 0;
  const members = sortLayersByVisualOrder(
    layers.filter((candidate) => candidate.groupId === group.id)
  );
  const memberIndex = members.findIndex((candidate) => candidate.id === layer.id);
  if (memberIndex < 0 || members.length <= 1) return 0;
  const normalizedIndex = memberIndex / Math.max(1, members.length - 1);
  const phasedIndex = effect.phaseDirection === "reverse"
    ? 1 - normalizedIndex
    : normalizedIndex;
  return effect.phaseSpread * phasedIndex;
}

export function resolveEffectiveDimmerFx(
  layer: Layer,
  layers: Layer[],
  groups: LayerGroup[]
): {
  effect: DimmerEffect | null;
  group: LayerGroup | null;
  overriddenByGroup: boolean;
  phaseOffset: number;
} {
  const group = resolveGroupForLayer(layer, groups);
  const groupEffect = group?.dimmerFx?.enabled ? group.dimmerFx : null;
  if (group && groupEffect) {
    return {
      effect: groupEffect,
      group,
      overriddenByGroup: true,
      phaseOffset: computeGroupPhaseOffset(layer, layers, group, groupEffect),
    };
  }

  const layerEffect = layer.dimmerFx?.enabled ? layer.dimmerFx : null;
  return {
    effect: layerEffect,
    group,
    overriddenByGroup: false,
    phaseOffset: 0,
  };
}

export function computeDimmerMultiplier(
  effect: DimmerEffect | null,
  _bpmPhase: number,
  _bpmMultiplier: number,
  phaseOffset = 0,
  timeSeconds = currentDimmerTimeSeconds()
): number {
  if (!effect?.enabled) return 1;
  const phase = fract(
    timeSeconds * effect.speed
      + effect.phaseOffset
      + phaseOffset
  );
  const sample = evaluateDimmerCurve(effect.curve, phase, effect.dutyCycle);
  const depth = Math.min(1, Math.max(0, effect.depth));
  return Math.min(1, Math.max(0, 1 - depth + depth * sample));
}

export function computeLayerOpacity(
  layer: Layer,
  layers: Layer[],
  groups: LayerGroup[],
  bpmPhase: number,
  bpmMultiplier: number,
  timeSeconds = currentDimmerTimeSeconds()
): number {
  const { effect, phaseOffset } = resolveEffectiveDimmerFx(layer, layers, groups);
  return Math.min(1, Math.max(0, layer.properties.opacity))
    * computeDimmerMultiplier(effect, bpmPhase, bpmMultiplier, phaseOffset, timeSeconds);
}

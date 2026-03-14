import { describe, expect, it } from "vitest";
import {
  computeDimmerPhase,
  computeGroupPhaseOffset,
  computeLayerOpacity,
  evaluateDimmerCurve,
} from "./dimmer-fx";
import type { Layer, LayerGroup } from "../types";

function makeLayer(id: string, zIndex: number): Layer {
  return {
    id,
    name: id,
    type: "quad",
    visible: true,
    locked: false,
    zIndex,
    source: null,
    geometry: {
      type: "Mesh",
      data: {
        cols: 1,
        rows: 1,
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.1, y: 0.9 },
          { x: 0.9, y: 0.9 },
        ],
      },
    },
    input_transform: { offset: [0, 0], rotation: 0, scale: [1, 1] },
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
    dimmerFx: null,
    groupId: null,
  };
}

describe("evaluateDimmerCurve", () => {
  it("respects duty cycle for square curves", () => {
    expect(evaluateDimmerCurve("square", 0.2, 0.3)).toBe(1);
    expect(evaluateDimmerCurve("square", 0.4, 0.3)).toBe(0);
  });
});

describe("computeLayerOpacity", () => {
  it("uses group dimmer effect instead of layer dimmer effect when both are active", () => {
    const layerA = makeLayer("a", 0);
    layerA.groupId = "group-1";
    layerA.dimmerFx = {
      enabled: true,
      curve: "square",
      depth: 1,
      speed: 1,
      phaseOffset: 0,
      dutyCycle: 0.8,
      phaseSpread: 1,
      phaseDirection: "forward",
    };
    const layerB = makeLayer("b", 1);
    layerB.groupId = "group-1";

    const group: LayerGroup = {
      id: "group-1",
      name: "Group",
      layerIds: ["a", "b"],
      visible: true,
      locked: false,
      pixelMap: null,
      dimmerFx: {
        enabled: true,
        curve: "square",
        depth: 1,
        speed: 1,
        phaseOffset: 0,
        dutyCycle: 0.5,
        phaseSpread: 1,
        phaseDirection: "forward",
      },
      sharedInput: null,
    };

    expect(
      computeLayerOpacity(
        layerA,
        [layerA, layerB],
        [group],
        { bpm: 120, multiplier: 1, phaseOriginMs: 100 },
        450
      )
    ).toBe(0);
  });
});

describe("computeDimmerPhase", () => {
  const effect = {
    enabled: true,
    curve: "sine" as const,
    depth: 1,
    speed: 1,
    phaseOffset: 0,
    dutyCycle: 0.5,
    phaseSpread: 0,
    phaseDirection: "forward" as const,
  };

  it("completes one cycle per beat when speed is 1", () => {
    expect(
      computeDimmerPhase(effect, { bpm: 120, multiplier: 1, phaseOriginMs: 1000 }, 0, 1500)
    ).toBeCloseTo(0);
  });

  it("spans multiple beats when speed is greater than 1", () => {
    expect(
      computeDimmerPhase({ ...effect, speed: 4 }, { bpm: 120, multiplier: 1, phaseOriginMs: 1000 }, 0, 1500)
    ).toBeCloseTo(0.25);
    expect(
      computeDimmerPhase({ ...effect, speed: 8 }, { bpm: 120, multiplier: 1, phaseOriginMs: 1000 }, 0, 2000)
    ).toBeCloseTo(0.25);
  });

  it("applies the BPM multiplier to synced timing", () => {
    expect(
      computeDimmerPhase(effect, { bpm: 120, multiplier: 2, phaseOriginMs: 1000 }, 0, 1250)
    ).toBeCloseTo(0);
  });
});

describe("computeGroupPhaseOffset", () => {
  it("returns zero when spread is zero", () => {
    const layerA = makeLayer("a", 0);
    layerA.groupId = "group-1";
    const layerB = makeLayer("b", 1);
    layerB.groupId = "group-1";
    const group: LayerGroup = {
      id: "group-1",
      name: "Group",
      layerIds: ["a", "b"],
      visible: true,
      locked: false,
      pixelMap: null,
      dimmerFx: null,
      sharedInput: null,
    };

    expect(
      computeGroupPhaseOffset(layerA, [layerA, layerB], group, {
        enabled: true,
        curve: "sine",
        depth: 1,
        speed: 1,
        phaseOffset: 0,
        dutyCycle: 0.5,
        phaseSpread: 0,
        phaseDirection: "forward",
      })
    ).toBe(0);
  });

  it("distributes members without duplicating endpoints", () => {
    const layers = ["a", "b", "c", "d"].map((id, index) => {
      const layer = makeLayer(id, index);
      layer.groupId = "group-1";
      return layer;
    });
    const group: LayerGroup = {
      id: "group-1",
      name: "Group",
      layerIds: layers.map((layer) => layer.id),
      visible: true,
      locked: false,
      pixelMap: null,
      dimmerFx: null,
      sharedInput: null,
    };

    const forward = layers.map((layer) => computeGroupPhaseOffset(layer, layers, group, {
      enabled: true,
      curve: "sine",
      depth: 1,
      speed: 1,
      phaseOffset: 0,
      dutyCycle: 0.5,
      phaseSpread: 1,
      phaseDirection: "forward",
    }));
    const center = layers.map((layer) => computeGroupPhaseOffset(layer, layers, group, {
      enabled: true,
      curve: "sine",
      depth: 1,
      speed: 1,
      phaseOffset: 0,
      dutyCycle: 0.5,
      phaseSpread: 1,
      phaseDirection: "center",
    }));
    const reverse = layers.map((layer) => computeGroupPhaseOffset(layer, layers, group, {
      enabled: true,
      curve: "sine",
      depth: 1,
      speed: 1,
      phaseOffset: 0,
      dutyCycle: 0.5,
      phaseSpread: 1,
      phaseDirection: "reverse",
    }));

    expect(forward).toEqual([0, 0.25, 0.5, 0.75]);
    expect(center).toEqual([-0.375, -0.125, 0.125, 0.375]);
    expect(reverse).toEqual([0.75, 0.5, 0.25, 0]);
  });
});

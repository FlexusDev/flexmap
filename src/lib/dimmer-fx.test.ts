import { describe, expect, it } from "vitest";
import { computeLayerOpacity, evaluateDimmerCurve } from "./dimmer-fx";
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

    expect(computeLayerOpacity(layerA, [layerA, layerB], [group], 0, 1, 0.6)).toBe(0);
  });
});

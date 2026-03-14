import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DimmerFxSection from "./DimmerFxSection";
import { useAppStore } from "../../../store/useAppStore";
import type { Layer, LayerGroup } from "../../../types";

function makeLayer(id: string, zIndex: number, groupId: string | null = null): Layer {
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
    groupId,
  };
}

function makeGroup(id: string, layers: Layer[]): LayerGroup {
  return {
    id,
    name: id,
    layerIds: layers.map((layer) => layer.id),
    visible: true,
    locked: false,
    pixelMap: null,
    dimmerFx: null,
    sharedInput: null,
  };
}

describe("DimmerFxSection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState((s) => ({
      ...s,
      bpmState: {
        bpm: 120,
        beat: 0,
        level: 0,
        phase: 0,
        running: false,
        selectedDeviceId: null,
        selectedDeviceName: null,
        lastBeatMs: 0,
        phaseOriginMs: 1_000,
        multiplier: 1,
        source: "manual",
      },
      refreshBpmState: vi.fn().mockResolvedValue(undefined),
    }));
    vi.setSystemTime(new Date(2_000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a realtime graph for layer dimmer FX and keeps override note visible", () => {
    const layer = makeLayer("layer-a", 0);
    render(
      <DimmerFxSection
        title="Dimmer FX"
        dimmerFx={{
          enabled: true,
          curve: "sine",
          depth: 1,
          speed: 4,
          phaseOffset: 0,
          dutyCycle: 0.5,
          phaseSpread: 0,
          phaseDirection: "forward",
        }}
        overrideNote="Group Dimmer FX is active."
        graphContext={{
          kind: "layer",
          layer,
          layers: [layer],
          groups: [],
        }}
        onDimmerFxChange={vi.fn()}
        onSliderDown={vi.fn()}
        onSliderUp={vi.fn()}
      />
    );

    expect(screen.getByText("Group Dimmer FX is active.")).toBeDefined();
    expect(screen.getByTestId("dimmer-fx-graph")).toBeDefined();
    expect(screen.getByTestId("dimmer-fx-playhead")).toBeDefined();
  });

  it("renders a highlighted trace and phase lanes for group dimmer FX", () => {
    const layerA = makeLayer("layer-a", 0, "group-1");
    const layerB = makeLayer("layer-b", 1, "group-1");
    const group = makeGroup("group-1", [layerA, layerB]);

    render(
      <DimmerFxSection
        title="Group Dimmer FX"
        dimmerFx={{
          enabled: true,
          curve: "triangle",
          depth: 1,
          speed: 2,
          phaseOffset: 0.1,
          dutyCycle: 0.5,
          phaseSpread: 1,
          phaseDirection: "center",
        }}
        groupMode
        graphContext={{
          kind: "group",
          group,
          layers: [layerA, layerB],
          groups: [group],
          highlightedLayerId: layerB.id,
        }}
        onDimmerFxChange={vi.fn()}
        onSliderDown={vi.fn()}
        onSliderUp={vi.fn()}
      />
    );

    expect(screen.getByTestId("dimmer-fx-selected-trace")).toBeDefined();
    expect(screen.getByTestId("dimmer-fx-phase-lanes")).toBeDefined();
    expect(screen.getByText("Beats/Cycle")).toBeDefined();
  });
});

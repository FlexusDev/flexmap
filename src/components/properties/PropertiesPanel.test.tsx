import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useAppStore } from "../../store/useAppStore";

vi.mock("./sections/LayerSection", () => ({
  default: () => <div data-testid="layer-section" />,
}));

vi.mock("./sections/EditSection", () => ({
  default: () => <div data-testid="edit-section" />,
}));

vi.mock("./sections/PixelMapSection", () => ({
  default: () => <div data-testid="pixel-map-section" />,
}));

vi.mock("./sections/DimmerFxSection", () => ({
  default: ({
    title,
    onDimmerFxChange,
  }: {
    title: string;
    onDimmerFxChange: (value: unknown) => void;
  }) => (
    <button
      type="button"
      data-testid={title.toLowerCase().replace(/\s+/g, "-")}
      onClick={() => onDimmerFxChange({
        enabled: true,
        curve: "square",
        depth: 1,
        speed: 1,
        phaseOffset: 0.1,
        dutyCycle: 0.4,
        phaseSpread: 0.7,
        phaseDirection: "forward",
      })}
    >
      {title}
    </button>
  ),
}));

vi.mock("./sections/SharedInputSection", () => ({
  default: ({
    onSharedInputChange,
    defaultMapping,
    hasMixedSources,
  }: {
    onSharedInputChange: (value: unknown) => void;
    defaultMapping: {
      box: [number, number, number, number];
      offsetX: number;
      offsetY: number;
      rotation: number;
      scaleX: number;
      scaleY: number;
    };
    hasMixedSources: boolean;
  }) => (
    <div>
      <button
        type="button"
        data-testid="shared-input"
        onClick={() => onSharedInputChange({ ...defaultMapping, enabled: true })}
      >
        Shared Input
      </button>
      {hasMixedSources && <span>different sources</span>}
    </div>
  ),
}));

import PropertiesPanel from "./PropertiesPanel";

const originalSetGroupSharedInput = useAppStore.getState().setGroupSharedInput;
const originalSetGroupDimmerFx = useAppStore.getState().setGroupDimmerFx;

describe("PropertiesPanel shared input", () => {
  beforeEach(() => {
    useAppStore.setState({
      project: {
        schemaVersion: 2,
        projectName: "Test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        output: { width: 1920, height: 1080, framerate: 60, monitor_preference: null },
        calibration: { enabled: false, pattern: "grid" },
        layers: [],
        groups: [],
        uiState: null,
      },
      layers: [
        {
          id: "layer-a",
          name: "A",
          type: "circle",
          visible: true,
          locked: false,
          zIndex: 0,
          source: { protocol: "shader", source_id: "shader:a", display_name: "A" },
          geometry: {
            type: "Mesh",
            data: {
              cols: 1,
              rows: 1,
              points: [
                { x: 0.1, y: 0.1 },
                { x: 0.3, y: 0.1 },
                { x: 0.1, y: 0.3 },
                { x: 0.3, y: 0.3 },
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
          groupId: "group-1",
        },
        {
          id: "layer-b",
          name: "B",
          type: "circle",
          visible: true,
          locked: false,
          zIndex: 1,
          source: { protocol: "shader", source_id: "shader:b", display_name: "B" },
          geometry: {
            type: "Mesh",
            data: {
              cols: 1,
              rows: 1,
              points: [
                { x: 0.4, y: 0.2 },
                { x: 0.6, y: 0.2 },
                { x: 0.4, y: 0.4 },
                { x: 0.6, y: 0.4 },
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
          groupId: "group-1",
        },
      ],
      groups: [
        {
          id: "group-1",
          name: "Group 1",
          layerIds: ["layer-a", "layer-b"],
          visible: true,
          locked: false,
          pixelMap: null,
          dimmerFx: null,
          sharedInput: null,
        },
      ],
      selectedLayerId: "layer-a",
      selectedLayerIds: ["layer-a", "layer-b"],
      selectedPointIndex: null,
      editorSelectionMode: "shape",
      sources: [],
      setGroupDimmerFx: vi.fn().mockResolvedValue(undefined),
      setGroupSharedInput: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    useAppStore.setState({
      setGroupDimmerFx: originalSetGroupDimmerFx,
      setGroupSharedInput: originalSetGroupSharedInput,
    });
  });

  it("shows shared input controls and dispatches group updates", async () => {
    render(<PropertiesPanel />);

    expect(screen.getByText("Shared Input")).toBeDefined();
    expect(screen.getByText(/different sources/i)).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByTestId("shared-input"));
      await Promise.resolve();
    });

    const mock = vi.mocked(useAppStore.getState().setGroupSharedInput);
    expect(mock).toHaveBeenCalledTimes(1);
    const [groupId, mapping] = mock.mock.calls[0];
    expect(groupId).toBe("group-1");
    expect(mapping?.enabled).toBe(true);
    expect(mapping?.box[0]).toBeCloseTo(0.1);
    expect(mapping?.box[1]).toBeCloseTo(0.1);
    expect(mapping?.box[2]).toBeCloseTo(0.5);
    expect(mapping?.box[3]).toBeCloseTo(0.3);
  });

  it("shows group dimmer controls and dispatches group updates", async () => {
    render(<PropertiesPanel />);

    expect(screen.getByText("Group Dimmer FX")).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByTestId("group-dimmer-fx"));
      await Promise.resolve();
    });

    const mock = vi.mocked(useAppStore.getState().setGroupDimmerFx);
    expect(mock).toHaveBeenCalledTimes(1);
    const [groupId, effect] = mock.mock.calls[0];
    expect(groupId).toBe("group-1");
    expect(effect).toMatchObject({
      enabled: true,
      curve: "square",
      phaseSpread: 0.7,
    });
  });
});

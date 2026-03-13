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

import PropertiesPanel from "./PropertiesPanel";

const originalSetGroupSharedInput = useAppStore.getState().setGroupSharedInput;

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
          sharedInput: null,
        },
      ],
      selectedLayerId: "layer-a",
      selectedLayerIds: ["layer-a", "layer-b"],
      selectedPointIndex: null,
      editorSelectionMode: "shape",
      sources: [],
      setGroupSharedInput: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    useAppStore.setState({ setGroupSharedInput: originalSetGroupSharedInput });
  });

  it("shows shared input controls and dispatches group updates", async () => {
    render(<PropertiesPanel />);

    expect(screen.getByText("Shared Input")).toBeDefined();
    expect(screen.getByText(/different sources/i)).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button")[0]);
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
});

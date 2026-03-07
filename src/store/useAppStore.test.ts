import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import { act } from "@testing-library/react";

// Helper to get current store state
const getState = () => useAppStore.getState();

// Helper to wait for async actions (mock bridge has 5ms delay)
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  // Reset store to initial state
  useAppStore.setState({
    project: null,
    projectPath: null,
    isDirty: false,
    layers: [],
    selectedLayerId: null,
    selectedLayerIds: [],
    selectedFaceIndices: [],
    editorSelectionMode: "shape",
    calibrationEnabled: false,
    calibrationPattern: "grid",
    sources: [],
    monitors: [],
    projectorWindowOpen: false,
    projectorGpuNative: false,
    canUndo: false,
    canRedo: false,
    toasts: [],
    snapEnabled: false,
  });
});

describe("addLayer", () => {
  it("adds a layer and selects it", async () => {
    await act(async () => {
      await getState().addLayer("Test Layer", "quad");
    });
    await tick();

    const state = getState();
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0].name).toBe("Test Layer");
    expect(state.layers[0].type).toBe("quad");
    expect(state.selectedLayerId).toBe(state.layers[0].id);
    expect(state.selectedLayerIds).toEqual([state.layers[0].id]);
    expect(state.isDirty).toBe(true);
  });

  it("adds multiple layers", async () => {
    await act(async () => {
      await getState().addLayer("Layer 1", "quad");
      await getState().addLayer("Layer 2", "triangle");
    });
    await tick();

    const state = getState();
    expect(state.layers).toHaveLength(2);
    expect(state.layers[0].name).toBe("Layer 1");
    expect(state.layers[1].name).toBe("Layer 2");
    // Most recently added layer should be selected
    expect(state.selectedLayerId).toBe(state.layers[1].id);
  });
});

describe("removeLayer", () => {
  it("removes a layer by id", async () => {
    await act(async () => {
      await getState().addLayer("ToRemove", "quad");
    });
    await tick();

    const layerId = getState().layers[0].id;

    await act(async () => {
      await getState().removeLayer(layerId);
    });
    await tick();

    expect(getState().layers).toHaveLength(0);
    expect(getState().isDirty).toBe(true);
  });

  it("clears selection when the selected layer is removed", async () => {
    await act(async () => {
      await getState().addLayer("A", "quad");
    });
    await tick();

    const id = getState().selectedLayerId!;

    await act(async () => {
      await getState().removeLayer(id);
    });
    await tick();

    expect(getState().selectedLayerId).toBeNull();
    expect(getState().selectedLayerIds).toHaveLength(0);
  });
});

describe("selectLayer", () => {
  it("selects a layer by id", async () => {
    await act(async () => {
      await getState().addLayer("A", "quad");
      await getState().addLayer("B", "quad");
    });
    await tick();

    const firstId = getState().layers[0].id;
    act(() => {
      getState().selectLayer(firstId);
    });

    expect(getState().selectedLayerId).toBe(firstId);
    expect(getState().selectedLayerIds).toEqual([firstId]);
  });

  it("deselects when null is passed", async () => {
    await act(async () => {
      await getState().addLayer("A", "quad");
    });
    await tick();

    act(() => {
      getState().selectLayer(null);
    });

    expect(getState().selectedLayerId).toBeNull();
    expect(getState().selectedLayerIds).toHaveLength(0);
  });
});

describe("duplicateLayer", () => {
  it("duplicates a layer with (copy) suffix", async () => {
    await act(async () => {
      await getState().addLayer("Original", "quad");
    });
    await tick();

    const origId = getState().layers[0].id;

    await act(async () => {
      await getState().duplicateLayer(origId);
    });
    await tick();

    const state = getState();
    expect(state.layers).toHaveLength(2);
    expect(state.layers[1].name).toBe("Original (copy)");
    expect(state.selectedLayerId).toBe(state.layers[1].id);
    expect(state.isDirty).toBe(true);
  });
});

describe("renameLayer", () => {
  it("renames a layer", async () => {
    await act(async () => {
      await getState().addLayer("Before", "quad");
    });
    await tick();

    const id = getState().layers[0].id;

    await act(async () => {
      await getState().renameLayer(id, "After");
    });
    await tick();

    expect(getState().layers[0].name).toBe("After");
    expect(getState().isDirty).toBe(true);
  });
});

describe("setLayerVisibility", () => {
  it("toggles layer visibility", async () => {
    await act(async () => {
      await getState().addLayer("Visible", "quad");
    });
    await tick();

    const id = getState().layers[0].id;
    expect(getState().layers[0].visible).toBe(true);

    await act(async () => {
      await getState().setLayerVisibility(id, false);
    });
    await tick();

    expect(getState().layers[0].visible).toBe(false);

    await act(async () => {
      await getState().setLayerVisibility(id, true);
    });
    await tick();

    expect(getState().layers[0].visible).toBe(true);
  });
});

describe("toggleSnap", () => {
  it("toggles snap state", () => {
    expect(getState().snapEnabled).toBe(false);

    act(() => {
      getState().toggleSnap();
    });
    expect(getState().snapEnabled).toBe(true);

    act(() => {
      getState().toggleSnap();
    });
    expect(getState().snapEnabled).toBe(false);
  });
});

describe("addToast / dismissToast", () => {
  it("adds a toast", () => {
    act(() => {
      getState().addToast("Test message", "info");
    });

    const toasts = getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe("Test message");
    expect(toasts[0].type).toBe("info");
    expect(typeof toasts[0].id).toBe("string");
  });

  it("adds multiple toasts", () => {
    act(() => {
      getState().addToast("Error msg", "error");
      getState().addToast("Warning msg", "warning");
    });

    expect(getState().toasts).toHaveLength(2);
  });

  it("dismisses a toast by id", () => {
    act(() => {
      getState().addToast("To dismiss", "info");
    });

    const toastId = getState().toasts[0].id;

    act(() => {
      getState().dismissToast(toastId);
    });

    expect(getState().toasts).toHaveLength(0);
  });

  it("dismisses only the specified toast", () => {
    act(() => {
      getState().addToast("Keep", "info");
      getState().addToast("Remove", "error");
    });

    const removeId = getState().toasts[1].id;

    act(() => {
      getState().dismissToast(removeId);
    });

    const remaining = getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].message).toBe("Keep");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

// Ensure we are in browser mock mode (no __TAURI_INTERNALS__)
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__TAURI_INTERNALS__;
});

// Dynamic import so that isTauri is evaluated after we clean the global
async function freshImport() {
  // Vitest caches modules, so we need to reset modules for each test suite
  // Instead we rely on the fact that isTauri was set at import time.
  // Since __TAURI_INTERNALS__ is not present in jsdom, isTauri should be false.
  const mod = await import("./tauri-bridge");
  return mod;
}

describe("tauri-bridge mock mode", () => {
  it("isTauri is false in jsdom", async () => {
    const { isTauri } = await freshImport();
    expect(isTauri).toBe(false);
  });

  it("get_project returns a valid ProjectFile shape", async () => {
    const { tauriInvoke } = await freshImport();
    const project = await tauriInvoke<{
      schemaVersion: number;
      projectName: string;
      layers: unknown[];
      output: { width: number; height: number };
    }>("get_project");

    expect(project).toBeDefined();
    expect(project.schemaVersion).toBe(2);
    expect(typeof project.projectName).toBe("string");
    expect(Array.isArray(project.layers)).toBe(true);
    expect(project.output.width).toBe(3840);
    expect(project.output.height).toBe(2160);
  });

  it("add_layer creates a layer and returns it", async () => {
    const { tauriInvoke } = await freshImport();
    const layer = await tauriInvoke<{
      id: string;
      name: string;
      type: string;
      visible: boolean;
      geometry: { type: string };
    }>("add_layer", { params: { name: "Test Quad", type: "quad" } });

    expect(layer).toBeDefined();
    expect(typeof layer.id).toBe("string");
    expect(layer.name).toBe("Test Quad");
    expect(layer.type).toBe("quad");
    expect(layer.visible).toBe(true);
    expect(layer.geometry.type).toBe("Mesh");
  });

  it("list_sources returns an array of sources", async () => {
    const { tauriInvoke } = await freshImport();
    const sources = await tauriInvoke<{ id: string; name: string; protocol: string }[]>(
      "list_sources"
    );

    expect(Array.isArray(sources)).toBe(true);
    expect(sources.length).toBeGreaterThan(0);
    // Should include test sources
    expect(sources.some((s) => s.protocol === "test")).toBe(true);
  });

  it("list_monitors returns mock monitors", async () => {
    const { tauriInvoke } = await freshImport();
    const monitors = await tauriInvoke<{ name: string; width: number }[]>("list_monitors");

    expect(Array.isArray(monitors)).toBe(true);
    expect(monitors.length).toBe(2);
    expect(monitors[0].name).toBe("Built-in Display");
  });

  it("duplicate_layer duplicates an existing layer", async () => {
    const { tauriInvoke } = await freshImport();
    // First, add a layer
    const original = await tauriInvoke<{ id: string; name: string }>("add_layer", {
      params: { name: "Original", type: "quad" },
    });

    const copy = await tauriInvoke<{ id: string; name: string } | null>("duplicate_layer", {
      layerId: original.id,
    });

    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(original.id);
    expect(copy!.name).toBe("Original (copy)");
  });

  it("rename_layer updates the layer name", async () => {
    const { tauriInvoke } = await freshImport();
    const layer = await tauriInvoke<{ id: string }>("add_layer", {
      params: { name: "Before", type: "quad" },
    });

    const result = await tauriInvoke<boolean>("rename_layer", {
      layerId: layer.id,
      name: "After",
    });
    expect(result).toBe(true);

    // Verify via get_layers
    const layers = await tauriInvoke<{ id: string; name: string }[]>("get_layers");
    const renamed = layers.find((l) => l.id === layer.id);
    expect(renamed?.name).toBe("After");
  });

  it("remove_layer removes a layer", async () => {
    const { tauriInvoke } = await freshImport();
    const layer = await tauriInvoke<{ id: string }>("add_layer", {
      params: { name: "ToRemove", type: "quad" },
    });

    const result = await tauriInvoke<boolean>("remove_layer", { layerId: layer.id });
    expect(result).toBe(true);

    const layers = await tauriInvoke<{ id: string }[]>("get_layers");
    expect(layers.some((l) => l.id === layer.id)).toBe(false);
  });

  it("set_layer_visibility toggles visibility", async () => {
    const { tauriInvoke } = await freshImport();
    const layer = await tauriInvoke<{ id: string; visible: boolean }>("add_layer", {
      params: { name: "Vis", type: "quad" },
    });
    expect(layer.visible).toBe(true);

    await tauriInvoke("set_layer_visibility", { layerId: layer.id, visible: false });

    const layers = await tauriInvoke<{ id: string; visible: boolean }[]>("get_layers");
    const updated = layers.find((l) => l.id === layer.id);
    expect(updated?.visible).toBe(false);
  });

  it("save_project returns a path", async () => {
    const { tauriInvoke } = await freshImport();
    const path = await tauriInvoke<string>("save_project", { path: "/tmp/test.flexmap" });
    expect(path).toBe("/tmp/test.flexmap");
  });

  it("new_project resets state", async () => {
    const { tauriInvoke } = await freshImport();
    // Add a layer first
    await tauriInvoke("add_layer", { params: { name: "Temp", type: "quad" } });

    const project = await tauriInvoke<{ layers: unknown[]; projectName: string }>("new_project");
    expect(project.layers).toHaveLength(0);
    expect(project.projectName).toBe("Untitled Project");
  });

  it("unknown command returns undefined with a warning", async () => {
    const { tauriInvoke } = await freshImport();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await tauriInvoke("totally_fake_command");
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    const callArgs = warnSpy.mock.calls[0][0];
    expect(callArgs).toContain("totally_fake_command");
    warnSpy.mockRestore();
  });
});

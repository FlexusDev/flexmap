import { useAppStore } from "../../store/useAppStore";
import type { LayerProperties, BlendMode } from "../../types";
import { BLEND_MODES } from "../../types";

function PropertiesPanel() {
  const { layers, selectedLayerId, updateProperties, connectSource, disconnectSource, setBlendMode, sources } =
    useAppStore();

  const selectedLayer = layers.find((l) => l.id === selectedLayerId);

  if (!selectedLayer) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-aura-text-dim p-4">
        Select a layer to edit its properties
      </div>
    );
  }

  const props = selectedLayer.properties;

  const handleChange = (key: keyof LayerProperties, value: number) => {
    updateProperties(selectedLayer.id, { ...props, [key]: value });
  };

  const handleReset = (key: keyof LayerProperties) => {
    const defaults: LayerProperties = {
      brightness: 1.0,
      contrast: 1.0,
      gamma: 1.0,
      opacity: 1.0,
      feather: 0.0,
    };
    handleChange(key, defaults[key]);
  };

  const controls: {
    key: keyof LayerProperties;
    label: string;
    min: number;
    max: number;
    step: number;
  }[] = [
    { key: "brightness", label: "Brightness", min: 0, max: 2, step: 0.01 },
    { key: "contrast", label: "Contrast", min: 0, max: 3, step: 0.01 },
    { key: "gamma", label: "Gamma", min: 0.1, max: 3, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
    { key: "feather", label: "Feather", min: 0, max: 1, step: 0.01 },
  ];

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Layer info */}
      <div className="px-3 py-2 border-b border-aura-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
          Properties
        </span>
        <div className="mt-1">
          <span className="text-sm font-medium">{selectedLayer.name}</span>
          <span className="ml-2 text-xs text-aura-text-dim">
            ({selectedLayer.type})
          </span>
        </div>
      </div>

      {/* Source assignment */}
      <div className="px-3 py-3 border-b border-aura-border">
        <label className="text-xs text-aura-text-dim block mb-1">Source</label>
        <select
          value={selectedLayer.source?.source_id ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "") {
              disconnectSource(selectedLayer.id);
            } else {
              connectSource(selectedLayer.id, val);
            }
          }}
          className="input w-full text-xs"
        >
          <option value="">None</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              [{s.protocol}] {s.name}
              {s.width && s.height ? ` (${s.width}x${s.height})` : ""}
            </option>
          ))}
        </select>
        {selectedLayer.source && !sources.find((s) => s.id === selectedLayer.source?.source_id) && (
          <div className="mt-1 text-xs text-aura-warning">
            Source missing: {selectedLayer.source.display_name}
          </div>
        )}
      </div>

      {/* Blend mode */}
      <div className="px-3 py-3 border-b border-aura-border">
        <label className="text-xs text-aura-text-dim block mb-1">Blend Mode</label>
        <select
          value={selectedLayer.blend_mode ?? "normal"}
          onChange={(e) => setBlendMode(selectedLayer.id, e.target.value as BlendMode)}
          className="input w-full text-xs"
        >
          {BLEND_MODES.map((bm) => (
            <option key={bm.value} value={bm.value}>
              {bm.label}
            </option>
          ))}
        </select>
      </div>

      {/* Post-processing controls */}
      <div className="px-3 py-3 space-y-4">
        {controls.map(({ key, label, min, max, step }) => (
          <div key={key}>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-aura-text-dim">{label}</label>
              <div className="flex items-center gap-1">
                <span className="text-xs font-mono text-aura-text w-10 text-right">
                  {props[key].toFixed(2)}
                </span>
                <button
                  onClick={() => handleReset(key)}
                  className="text-xs text-aura-text-dim hover:text-aura-text px-1"
                  title="Reset to default"
                >
                  ↺
                </button>
              </div>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={props[key]}
              onChange={(e) => handleChange(key, parseFloat(e.target.value))}
              className="slider"
            />
          </div>
        ))}
      </div>

      {/* Geometry info */}
      <div className="px-3 py-3 border-t border-aura-border">
        <span className="text-xs text-aura-text-dim">Geometry</span>
        <div className="mt-1 text-xs font-mono text-aura-text-dim">
          {selectedLayer.geometry.type === "Quad" && "4-point warp"}
          {selectedLayer.geometry.type === "Triangle" && "3-point warp"}
          {selectedLayer.geometry.type === "Mesh" &&
            `Grid ${selectedLayer.geometry.data.cols}×${selectedLayer.geometry.data.rows}`}
          {selectedLayer.geometry.type === "Circle" && "Circle mask"}
        </div>
      </div>
    </div>
  );
}

export default PropertiesPanel;

import { useState, useEffect } from "react";
import { useAppStore } from "../../store/useAppStore";
import { isTauri, tauriInvoke } from "../../lib/tauri-bridge";

interface SyphonStatus {
  bridge_compiled: boolean;
  bridge_available: boolean;
  search_paths: [string, boolean][];
  message: string;
}

function SourcePanel() {
  const {
    sources,
    layers,
    selectedLayerId,
    refreshSources,
    addMediaFile,
    connectSource,
    disconnectSource,
  } = useAppStore();

  const [syphonStatus, setSyphonStatus] = useState<SyphonStatus | null>(null);

  // Check Syphon status on mount
  useEffect(() => {
    tauriInvoke<SyphonStatus>("check_syphon_status").then(setSyphonStatus);
  }, []);

  const handleAddMedia = async () => {
    let path: string | null = null;
    if (isTauri) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }],
        multiple: false,
      });
      path = typeof result === "string" ? result : null;
    } else {
      path = window.prompt("Enter image file path:");
    }
    if (path) {
      await addMediaFile(path);
    }
  };

  const selectedLayer = layers.find((l) => l.id === selectedLayerId);
  const connectedSourceId = selectedLayer?.source?.source_id ?? null;

  const handleConnect = (sourceId: string) => {
    if (!selectedLayerId) return;
    if (connectedSourceId === sourceId) {
      // Toggle off — disconnect
      disconnectSource(selectedLayerId);
    } else {
      connectSource(selectedLayerId, sourceId);
    }
  };

  return (
    <div className="h-full border-t border-aura-border flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-aura-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
          Sources
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleAddMedia}
            className="btn-ghost text-xs px-2 py-0.5"
            title="Add media file (image)"
          >
            + Media
          </button>
          <button
            onClick={refreshSources}
            className="btn-ghost text-xs px-2 py-0.5"
            title="Refresh sources"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Current assignment info */}
      {selectedLayer && (
        <div className="px-3 py-1.5 border-b border-aura-border/50 bg-aura-surface/50">
          <div className="text-xs text-aura-text-dim">
            <span className="text-aura-text">{selectedLayer.name}</span>
            {" → "}
            {selectedLayer.source ? (
              <span className="text-aura-success">
                {selectedLayer.source.display_name}
              </span>
            ) : (
              <span className="text-aura-text-dim italic">no source</span>
            )}
          </div>
        </div>
      )}

      {/* Syphon status banner — show if bridge is NOT available */}
      {syphonStatus && !syphonStatus.bridge_available && (
        <div className="px-3 py-2 border-b border-aura-border/50 bg-yellow-500/10">
          <div className="text-[10px] text-yellow-300 mb-1">
            Syphon not available
          </div>
          <div className="text-[10px] text-aura-text-dim">
            {syphonStatus.message}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {sources.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-aura-text-dim px-3 text-center">
            No sources detected.
            <br />
            Click "+ Media" to add an image file, or test patterns will appear when a source is connected.
          </div>
        ) : (
          sources.map((source) => {
            const isConnected = connectedSourceId === source.id;
            // Check if ANY layer is using this source
            const usedByLayer = layers.find(
              (l) => l.source?.source_id === source.id && l.id !== selectedLayerId
            );

            return (
              <button
                key={source.id}
                onClick={() => handleConnect(source.id)}
                disabled={!selectedLayerId}
                className={`w-full flex items-center gap-2 px-3 py-2 border-b border-aura-border/50 transition-colors text-left ${
                  isConnected
                    ? "bg-indigo-500/15 hover:bg-indigo-500/25"
                    : selectedLayerId
                    ? "hover:bg-aura-hover cursor-pointer"
                    : "opacity-50 cursor-not-allowed"
                }`}
                title={
                  !selectedLayerId
                    ? "Select a layer first"
                    : isConnected
                    ? "Click to disconnect"
                    : `Connect "${source.name}" to "${selectedLayer?.name}"`
                }
              >
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    isConnected ? "bg-indigo-400" : "bg-aura-success"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate">
                    {source.name}
                    {isConnected && (
                      <span className="ml-1.5 text-indigo-400 text-[10px]">
                        ● connected
                      </span>
                    )}
                    {usedByLayer && !isConnected && (
                      <span className="ml-1.5 text-aura-text-dim text-[10px]">
                        (→ {usedByLayer.name})
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-aura-text-dim">
                    {source.protocol}
                    {source.width && source.height
                      ? ` · ${source.width}×${source.height}`
                      : ""}
                    {source.fps ? ` · ${source.fps}fps` : ""}
                  </div>
                </div>
                {isConnected && (
                  <span className="text-[10px] text-indigo-400 flex-shrink-0">✕</span>
                )}
              </button>
            );
          })
        )}
      </div>

      {!selectedLayerId && sources.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-aura-text-dim text-center border-t border-aura-border/50">
          Select a layer to assign a source
        </div>
      )}
    </div>
  );
}

export default SourcePanel;

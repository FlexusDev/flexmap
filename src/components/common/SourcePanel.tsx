import { useState, useEffect, useRef } from "react";
import { useAppStore } from "../../store/useAppStore";
import { isTauri, tauriInvoke } from "../../lib/tauri-bridge";
import ShaderLibraryModal from "./ShaderLibraryModal";

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
    selectedLayerIds,
    refreshSources,
    addMediaFile,
    connectSourceForSelection,
    disconnectSourceForSelection,
  } = useAppStore();

  const [syphonStatus, setSyphonStatus] = useState<SyphonStatus | null>(null);
  const [shaderLibraryOpen, setShaderLibraryOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Check Syphon status on mount
  useEffect(() => {
    tauriInvoke<SyphonStatus>("check_syphon_status").then(setSyphonStatus);
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  // Discovery timer only while the Sources panel is mounted/visible.
  useEffect(() => {
    const isPanelVisible = () => {
      const panel = panelRef.current;
      return !!panel
        && panel.offsetParent !== null
        && panel.clientWidth > 0
        // Left panel collapsed size is ~40px; treat that as hidden for discovery polling.
        && panel.clientHeight > 80;
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && isPanelVisible()) {
        void refreshSources();
      }
    }, 30000);
    return () => window.clearInterval(interval);
  }, [refreshSources]);

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

  const effectiveSelectedIds = selectedLayerIds.length > 0
    ? selectedLayerIds
    : selectedLayerId
      ? [selectedLayerId]
      : [];
  const selectedSet = new Set(effectiveSelectedIds);
  const selectedLayers = layers.filter((l) => selectedSet.has(l.id));
  const selectedLayer = selectedLayerId
    ? layers.find((l) => l.id === selectedLayerId) ?? null
    : null;
  const hasSelection = selectedLayers.length > 0;

  const handleConnect = (sourceId: string) => {
    if (!hasSelection) return;
    const allConnected = selectedLayers.every((l) => l.source?.source_id === sourceId);
    if (allConnected) {
      // Toggle off — disconnect
      void disconnectSourceForSelection();
    } else {
      void connectSourceForSelection(sourceId);
    }
  };

  const selectedSourceIds = new Set(
    selectedLayers.map((l) => l.source?.source_id ?? "__none__")
  );
  const hasMixedSource = hasSelection && selectedSourceIds.size > 1;
  const allNoSource = hasSelection
    && selectedLayers.every((l) => !l.source?.source_id);
  const singleSharedSource = hasSelection
    && selectedSourceIds.size === 1
    && !selectedSourceIds.has("__none__")
    ? selectedLayers[0]?.source?.display_name ?? null
    : null;

  return (
    <div ref={panelRef} className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-end gap-1 px-3 py-1.5 border-b border-aura-border/50">
        <button
          onClick={() => setShaderLibraryOpen(true)}
          className="btn-ghost text-xs px-2 py-0.5"
          title="Browse bundled and online shader library"
        >
          Shader Library
        </button>
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

      {/* Current assignment info */}
      {hasSelection && (
        <div className="px-3 py-1.5 border-b border-aura-border/50 bg-aura-surface/50">
          <div className="text-xs text-aura-text-dim">
            {selectedLayers.length === 1 && selectedLayer ? (
              <>
                <span className="text-aura-text">{selectedLayer.name}</span>
                {" → "}
                {selectedLayer.source ? (
                  <span className="text-aura-success">
                    {selectedLayer.source.display_name}
                  </span>
                ) : (
                  <span className="text-aura-text-dim italic">no source</span>
                )}
              </>
            ) : (
              <>
                <span className="text-aura-text">{selectedLayers.length} layers</span>
                {" → "}
                {hasMixedSource ? (
                  <span className="text-aura-warning italic">mixed sources</span>
                ) : allNoSource ? (
                  <span className="text-aura-text-dim italic">no source</span>
                ) : (
                  <span className="text-aura-success">{singleSharedSource}</span>
                )}
              </>
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
            const isConnectedAll = hasSelection
              && selectedLayers.every((l) => l.source?.source_id === source.id);
            const isConnectedSome = hasSelection
              && selectedLayers.some((l) => l.source?.source_id === source.id);
            // Check if ANY layer is using this source
            const usedByLayer = layers.find(
              (l) => l.source?.source_id === source.id && !selectedSet.has(l.id)
            );

            return (
              <button
                key={source.id}
                onClick={() => handleConnect(source.id)}
                disabled={!hasSelection}
                className={`w-full flex items-center gap-2 px-3 py-2 border-b border-aura-border/50 transition-colors text-left ${
                  isConnectedAll
                    ? "bg-indigo-500/15 hover:bg-indigo-500/25"
                    : hasSelection
                    ? "hover:bg-aura-hover cursor-pointer"
                    : "opacity-50 cursor-not-allowed"
                }`}
                title={
                  !hasSelection
                    ? "Select a layer first"
                    : isConnectedAll
                    ? `Disconnect "${source.name}" from selected layers`
                    : `Connect "${source.name}" to selected layers`
                }
              >
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    isConnectedAll ? "bg-indigo-400" : isConnectedSome ? "bg-amber-400" : "bg-aura-success"
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate">
                    {source.name}
                    {isConnectedAll && (
                      <span className="ml-1.5 text-indigo-400 text-[10px]">
                        ● connected
                      </span>
                    )}
                    {isConnectedSome && !isConnectedAll && (
                      <span className="ml-1.5 text-amber-300 text-[10px]">
                        ● mixed
                      </span>
                    )}
                    {usedByLayer && !isConnectedAll && (
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
                {isConnectedAll && (
                  <span className="text-[10px] text-indigo-400 flex-shrink-0">✕</span>
                )}
              </button>
            );
          })
        )}
      </div>

      {!hasSelection && sources.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-aura-text-dim text-center border-t border-aura-border/50">
          Select one or more layers to assign a source
        </div>
      )}

      <ShaderLibraryModal
        open={shaderLibraryOpen}
        onClose={() => setShaderLibraryOpen(false)}
        hasSelection={hasSelection}
        onApplySource={async (sourceId) => {
          if (!hasSelection) return;
          await connectSourceForSelection(sourceId);
        }}
      />
    </div>
  );
}

export default SourcePanel;

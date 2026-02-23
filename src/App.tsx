import { useEffect, useState } from "react";
import { useAppStore } from "./store/useAppStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { tauriInvoke } from "./lib/tauri-bridge";
import Toolbar from "./components/common/Toolbar";
import LayerPanel from "./components/layers/LayerPanel";
import PropertiesPanel from "./components/properties/PropertiesPanel";
import EditorCanvas from "./components/editor/EditorCanvas";
import CalibrationBar from "./components/calibration/CalibrationBar";
import SourcePanel from "./components/common/SourcePanel";
import StatusBar from "./components/common/StatusBar";
import KeyboardOverlay from "./components/common/KeyboardOverlay";
import ToastContainer from "./components/common/ToastContainer";

function RecoveryDialog({ onRecover, onDismiss }: { onRecover: () => void; onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-aura-surface border border-aura-border rounded-lg shadow-2xl p-6 max-w-sm">
        <div className="text-sm font-medium mb-2">Recover Unsaved Work?</div>
        <div className="text-xs text-aura-text-dim mb-4">
          AuraMap found an autosave file from a previous session. Would you like to recover it?
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onDismiss} className="btn-ghost text-xs">
            Discard
          </button>
          <button onClick={onRecover} className="btn-primary text-xs">
            Recover
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const { loadProject, refreshMonitors, refreshSources } = useAppStore();
  const [showRecovery, setShowRecovery] = useState(false);

  useKeyboardShortcuts();

  useEffect(() => {
    loadProject();
    refreshMonitors();
    refreshSources();

    // Check for crash recovery
    tauriInvoke<boolean>("has_recovery").then((hasRecovery) => {
      if (hasRecovery) {
        setShowRecovery(true);
      }
    });

    // Periodic source refresh (every 3s)
    const interval = setInterval(() => {
      refreshSources();
    }, 3000);

    return () => clearInterval(interval);
  }, [loadProject, refreshMonitors, refreshSources]);

  const handleRecover = async () => {
    try {
      const project = await tauriInvoke<unknown>("load_recovery");
      if (project) {
        await loadProject();
      }
    } catch (e) {
      console.error("Recovery failed:", e);
    }
    setShowRecovery(false);
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-aura-bg text-aura-text">
      {/* Recovery dialog */}
      {showRecovery && (
        <RecoveryDialog
          onRecover={handleRecover}
          onDismiss={() => setShowRecovery(false)}
        />
      )}

      {/* Top toolbar */}
      <Toolbar />

      {/* Calibration mode bar */}
      <CalibrationBar />

      {/* Main content area */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel: Layers + Sources */}
        <div className="w-64 flex flex-col border-r border-aura-border">
          <LayerPanel />
          <SourcePanel />
        </div>

        {/* Center: Editor canvas */}
        <div className="flex-1 relative">
          <EditorCanvas />
        </div>

        {/* Right panel: Properties */}
        <div className="w-72 border-l border-aura-border">
          <PropertiesPanel />
        </div>
      </div>

      {/* Status bar */}
      <StatusBar />

      {/* Keyboard shortcut overlay (main window only) */}
      <KeyboardOverlay />

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  );
}

export default App;

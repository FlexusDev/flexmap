import { useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
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
          FlexMap found an autosave file from a previous session. Would you like to recover it?
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

  const { defaultLayout: mainLayout, onLayoutChanged: onMainLayoutChanged } =
    useDefaultLayout({ id: "flexmap-main", storage: localStorage });
  const { defaultLayout: leftLayout, onLayoutChanged: onLeftLayoutChanged } =
    useDefaultLayout({ id: "flexmap-left-split", storage: localStorage });

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
      <Group
        orientation="horizontal"
        className="flex-1 min-h-0"
        defaultLayout={mainLayout}
        onLayoutChanged={onMainLayoutChanged}
      >
        {/* Left panel: Layers + Sources */}
        <Panel
          id="left"
          defaultSize={256}
          minSize={180}
          maxSize={400}
          collapsible
          className="flex flex-col border-r border-aura-border"
        >
          <Group
            orientation="vertical"
            className="h-full"
            defaultLayout={leftLayout}
            onLayoutChanged={onLeftLayoutChanged}
          >
            <Panel id="layers" defaultSize="65" minSize={80}>
              <LayerPanel />
            </Panel>
            <Separator />
            <Panel id="sources" defaultSize="35" minSize={60}>
              <SourcePanel />
            </Panel>
          </Group>
        </Panel>

        <Separator />

        {/* Center: Editor canvas */}
        <Panel id="center" minSize={200}>
          <div className="relative h-full w-full">
            <EditorCanvas />
          </div>
        </Panel>

        <Separator />

        {/* Right panel: Properties */}
        <Panel
          id="right"
          defaultSize={288}
          minSize={200}
          maxSize={450}
          collapsible
          className="border-l border-aura-border"
        >
          <PropertiesPanel />
        </Panel>
      </Group>

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

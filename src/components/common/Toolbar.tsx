import { useAppStore } from "../../store/useAppStore";
import { tauriOpenDialog, tauriSaveDialog } from "../../lib/tauri-bridge";
import OutputConfigPanel from "../output/OutputConfigPanel";
import pkg from "../../../package.json";

function Toolbar() {
  const {
    isDirty,
    projectPath,
    projectorWindowOpen,
    canUndo,
    canRedo,
    openProjector,
    closeProjector,
    saveProject,
    loadProjectFile,
    newProject,
    undo,
    redo,
  } = useAppStore();

  const handleNew = async () => {
    await newProject();
  };

  const handleOpen = async () => {
    const result = await tauriOpenDialog({
      filters: [{ name: "FlexMap Project", extensions: ["flexmap", "json"] }],
    });
    if (result) {
      await loadProjectFile(result);
    }
  };

  const handleSave = async () => {
    if (projectPath) {
      await saveProject();
    } else {
      await handleSaveAs();
    }
  };

  const handleSaveAs = async () => {
    const path = await tauriSaveDialog({
      filters: [{ name: "FlexMap Project", extensions: ["flexmap"] }],
      defaultPath: "project.flexmap",
    });
    if (path) {
      await saveProject(path);
    }
  };

  return (
    <div className="flex items-center h-10 px-3 bg-aura-surface border-b border-aura-border gap-1">
      {/* Project controls */}
      <div className="flex items-center gap-1">
        <button onClick={handleNew} className="btn-ghost text-xs" title="New Project (Cmd+N)">
          New
        </button>
        <button onClick={handleOpen} className="btn-ghost text-xs" title="Open Project (Cmd+O)">
          Open
        </button>
        <button onClick={handleSave} className="btn-ghost text-xs" title="Save Project (Cmd+S)">
          Save{isDirty ? " *" : ""}
        </button>
        <button onClick={handleSaveAs} className="btn-ghost text-xs" title="Save As... (Cmd+Shift+S)">
          Save As
        </button>
      </div>

      <div className="w-px h-5 bg-aura-border mx-2" />

      {/* Undo / Redo */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={undo}
          disabled={!canUndo}
          className={`btn-ghost text-xs px-2 ${!canUndo ? "opacity-30 cursor-not-allowed" : ""}`}
          title="Undo (Cmd+Z)"
        >
          Undo
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          className={`btn-ghost text-xs px-2 ${!canRedo ? "opacity-30 cursor-not-allowed" : ""}`}
          title="Redo (Cmd+Shift+Z)"
        >
          Redo
        </button>
      </div>

      <div className="w-px h-5 bg-aura-border mx-2" />

      {/* Projector output toggle */}
      <button
        onClick={projectorWindowOpen ? closeProjector : openProjector}
        className={`btn text-xs ${
          projectorWindowOpen
            ? "bg-aura-accent text-white"
            : "bg-aura-hover text-aura-text-dim"
        }`}
        title="Toggle Projector (Cmd+P)"
      >
        {projectorWindowOpen ? "Projector ON" : "Open Projector"}
      </button>

      {/* Output config */}
      <OutputConfigPanel />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Title */}
      <span className="text-xs text-aura-text-dim font-mono">
        FlexMap
      </span>
      <span className="text-xs text-aura-text-dim/80 font-mono ml-2">
        v{pkg.version} · Alpha 1
      </span>
    </div>
  );
}

export default Toolbar;

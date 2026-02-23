import { useEffect } from "react";
import { useAppStore } from "../store/useAppStore";
import { tauriOpenDialog, tauriSaveDialog } from "../lib/tauri-bridge";

/**
 * Global keyboard shortcuts for AuraMap.
 * Cmd+S = Save, Cmd+Shift+S = Save As, Cmd+N = New, Cmd+O = Open,
 * Cmd+Z = Undo, Cmd+Shift+Z = Redo, Delete/Backspace = Delete selected layer
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const state = useAppStore.getState();

      // Cmd+Z / Cmd+Shift+Z — Undo / Redo
      if (meta && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          state.redo();
        } else {
          state.undo();
        }
        return;
      }

      // Cmd+S / Cmd+Shift+S — Save / Save As
      if (meta && e.key === "s") {
        e.preventDefault();
        if (e.shiftKey) {
          // Save As
          tauriSaveDialog({
            filters: [{ name: "AuraMap Project", extensions: ["auramap"] }],
            defaultPath: "project.auramap",
          }).then((path) => {
            if (path) state.saveProject(path);
          });
        } else {
          if (state.projectPath) {
            state.saveProject();
          } else {
            tauriSaveDialog({
              filters: [{ name: "AuraMap Project", extensions: ["auramap"] }],
              defaultPath: "project.auramap",
            }).then((path) => {
              if (path) state.saveProject(path);
            });
          }
        }
        return;
      }

      // Cmd+N — New Project
      if (meta && e.key === "n") {
        e.preventDefault();
        state.newProject();
        return;
      }

      // Cmd+O — Open Project
      if (meta && e.key === "o") {
        e.preventDefault();
        tauriOpenDialog({
          filters: [{ name: "AuraMap Project", extensions: ["auramap", "json"] }],
        }).then((path) => {
          if (path) state.loadProjectFile(path);
        });
        return;
      }

      // Cmd+D — Duplicate selected layer
      if (meta && e.key === "d") {
        e.preventDefault();
        if (state.selectedLayerId) {
          state.duplicateLayer(state.selectedLayerId);
        }
        return;
      }

      // Delete / Backspace — Remove selected layer (when not in input)
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !meta &&
        state.selectedLayerId
      ) {
        const target = e.target as HTMLElement;
        // Don't delete if user is typing in an input
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        state.removeLayer(state.selectedLayerId);
        return;
      }

      // Cmd+P — Toggle projector
      if (meta && e.key === "p") {
        e.preventDefault();
        if (state.projectorWindowOpen) {
          state.closeProjector();
        } else {
          state.openProjector();
        }
        return;
      }

      // Number keys 0-9 — Quick opacity for selected layer (no modifier)
      // 1=10%, 2=20%, ..., 9=90%, 0=100%
      if (
        !meta &&
        !e.altKey &&
        e.key >= "0" &&
        e.key <= "9" &&
        state.selectedLayerId
      ) {
        const target = e.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }

        const layer = state.layers.find((l) => l.id === state.selectedLayerId);
        if (!layer || layer.locked) return;

        e.preventDefault();
        const digit = parseInt(e.key);
        const opacity = digit === 0 ? 1.0 : digit / 10;
        state.updateProperties(layer.id, { ...layer.properties, opacity });
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

import { useEffect } from "react";
import { useAppStore } from "../store/useAppStore";
import { tauriOpenDialog, tauriSaveDialog } from "../lib/tauri-bridge";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;

  const input = target as HTMLInputElement;
  const type = (input.type || "text").toLowerCase();

  // Only text-entry inputs should suppress global shortcuts.
  // Numeric/range controls stay shortcut-friendly for fast editing workflows.
  const typingInputTypes = new Set([
    "",
    "text",
    "search",
    "email",
    "password",
    "tel",
    "url",
  ]);

  return typingInputTypes.has(type) && !input.readOnly && !input.disabled;
}

/**
 * Global keyboard shortcuts for AuraMap.
 * Cmd+S = Save, Cmd+Shift+S = Save As, Cmd+N = New, Cmd+O = Open,
 * Cmd+Z = Undo, Cmd+Shift+Z = Redo, Delete/Backspace = Delete selected layer
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const markHandled = (e: KeyboardEvent) => {
      (e as KeyboardEvent & { __auraShortcutHandled?: boolean }).__auraShortcutHandled = true;
    };

    const isMarkedHandled = (e: KeyboardEvent) =>
      (e as KeyboardEvent & { __auraShortcutHandled?: boolean }).__auraShortcutHandled === true;

    const handler = (e: KeyboardEvent) => {
      if (isMarkedHandled(e)) return;
      const meta = e.metaKey || e.ctrlKey;
      const state = useAppStore.getState();
      const target = e.target as EventTarget | null;

      // Cmd+Z / Cmd+Shift+Z — Undo / Redo
      if (meta && e.key === "z") {
        e.preventDefault();
        markHandled(e);
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
        markHandled(e);
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
        markHandled(e);
        state.newProject();
        return;
      }

      // Cmd+O — Open Project
      if (meta && e.key === "o") {
        e.preventDefault();
        markHandled(e);
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
        markHandled(e);
        if (state.selectedLayerId) {
          state.duplicateLayer(state.selectedLayerId);
        }
        return;
      }

      // Tab — toggle Shape vs UV/Input edit mode
      if ((e.key === "Tab" || e.code === "Tab") && !meta && !e.altKey) {
        if (isTypingTarget(target) || e.repeat) return;
        e.preventDefault();
        markHandled(e);
        if (state.selectedLayerId) {
          state.toggleEditorSelectionMode();
        } else {
          state.setEditorSelectionMode("shape");
        }
        return;
      }

      // Delete / Backspace — Remove selected layer (when not in input)
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !meta &&
        state.selectedLayerId
      ) {
        // Don't delete if user is typing in an input
        if (isTypingTarget(target)) {
          return;
        }
        e.preventDefault();
        markHandled(e);
        state.removeLayer(state.selectedLayerId);
        return;
      }

      // Cmd+P — Toggle projector
      if (meta && e.key === "p") {
        e.preventDefault();
        markHandled(e);
        if (state.projectorWindowOpen) {
          state.closeProjector();
        } else {
          state.openProjector();
        }
        return;
      }

      // G — Toggle snap to grid
      if (!meta && !e.altKey && e.key.toLowerCase() === "g") {
        if (isTypingTarget(target)) {
          return;
        }
        e.preventDefault();
        markHandled(e);
        state.toggleSnap();
        return;
      }

      // Escape — Clear face selection (when faces are selected)
      if (e.key === "Escape" && !meta && !e.altKey && !e.shiftKey) {
        if (isTypingTarget(target)) {
          return;
        }
        if (state.selectedFaceIndices.length > 0) {
          e.preventDefault();
          markHandled(e);
          state.clearFaceSelection();
          return;
        }
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
        if (isTypingTarget(target)) {
          return;
        }

        const layer = state.layers.find((l) => l.id === state.selectedLayerId);
        if (!layer || layer.locked) return;

        e.preventDefault();
        markHandled(e);
        const digit = parseInt(e.key);
        const opacity = digit === 0 ? 1.0 : digit / 10;
        state.updateProperties(layer.id, { ...layer.properties, opacity });
        return;
      }
    };

    // Capture phase helps intercept Tab before browser focus navigation.
    window.addEventListener("keydown", handler, true);
    document.addEventListener("keydown", handler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      document.removeEventListener("keydown", handler, true);
    };
  }, []);
}

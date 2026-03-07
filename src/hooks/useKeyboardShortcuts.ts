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
 * Global keyboard shortcuts for FlexMap.
 * Cmd+S = Save, Cmd+Shift+S = Save As, Cmd+N = New, Cmd+O = Open,
 * Cmd+Z = Undo, Cmd+Shift+Z = Redo, Delete/Backspace = Delete selected layer
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const getSelectedIds = () => {
      const state = useAppStore.getState();
      return state.selectedLayerIds.length > 0
        ? state.selectedLayerIds
        : state.selectedLayerId
          ? [state.selectedLayerId]
          : [];
    };

    const runAction = (action: "undo" | "redo" | "save" | "save_as" | "new" | "open" | "duplicate" | "toggle_projector") => {
      const state = useAppStore.getState();
      const selectedIds = getSelectedIds();

      switch (action) {
        case "undo":
          state.undo();
          return;
        case "redo":
          state.redo();
          return;
        case "save":
          if (state.projectPath) {
            state.saveProject();
          } else {
            tauriSaveDialog({
              filters: [{ name: "FlexMap Project", extensions: ["flexmap"] }],
              defaultPath: "project.flexmap",
            }).then((path) => {
              if (path) state.saveProject(path);
            });
          }
          return;
        case "save_as":
          tauriSaveDialog({
            filters: [{ name: "FlexMap Project", extensions: ["flexmap"] }],
            defaultPath: "project.flexmap",
          }).then((path) => {
            if (path) state.saveProject(path);
          });
          return;
        case "new":
          state.newProject();
          return;
        case "open":
          tauriOpenDialog({
            filters: [{ name: "FlexMap Project", extensions: ["flexmap", "json"] }],
          }).then((path) => {
            if (path) state.loadProjectFile(path);
          });
          return;
        case "duplicate":
          if (selectedIds.length > 0) state.duplicateSelectedLayers();
          return;
        case "toggle_projector":
          if (state.projectorWindowOpen) {
            state.closeProjector();
          } else {
            state.openProjector();
          }
          return;
      }
    };

    const markHandled = (e: KeyboardEvent) => {
      (e as KeyboardEvent & { __auraShortcutHandled?: boolean }).__auraShortcutHandled = true;
    };

    const isMarkedHandled = (e: KeyboardEvent) =>
      (e as KeyboardEvent & { __auraShortcutHandled?: boolean }).__auraShortcutHandled === true;

    const handler = (e: KeyboardEvent) => {
      if (isMarkedHandled(e)) return;
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const code = e.code;
      const matchesKey = (expectedKey: string, expectedCode: string) =>
        key === expectedKey || code === expectedCode;
      const state = useAppStore.getState();
      const target = e.target as EventTarget | null;
      const selectedIds = getSelectedIds();

      // Cmd+Z / Cmd+Shift+Z — Undo / Redo
      if (meta && matchesKey("z", "KeyZ")) {
        e.preventDefault();
        markHandled(e);
        runAction(e.shiftKey ? "redo" : "undo");
        return;
      }

      // Cmd+S / Cmd+Shift+S — Save / Save As
      if (meta && matchesKey("s", "KeyS")) {
        e.preventDefault();
        markHandled(e);
        runAction(e.shiftKey ? "save_as" : "save");
        return;
      }

      // Cmd+N — New Project
      if (meta && matchesKey("n", "KeyN")) {
        e.preventDefault();
        markHandled(e);
        runAction("new");
        return;
      }

      // Cmd+O — Open Project
      if (meta && matchesKey("o", "KeyO")) {
        e.preventDefault();
        markHandled(e);
        runAction("open");
        return;
      }

      // Cmd+D — Duplicate selected layer
      if (meta && matchesKey("d", "KeyD")) {
        e.preventDefault();
        markHandled(e);
        runAction("duplicate");
        return;
      }

      // Tab — toggle Shape vs UV/Input edit mode
      if ((e.key === "Tab" || e.code === "Tab") && !meta && !e.altKey) {
        if (isTypingTarget(target) || e.repeat) return;
        e.preventDefault();
        markHandled(e);
        if (selectedIds.length === 1) {
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
        selectedIds.length > 0
      ) {
        // Don't delete if user is typing in an input
        if (isTypingTarget(target)) {
          return;
        }
        e.preventDefault();
        markHandled(e);
        state.removeSelectedLayers();
        return;
      }

      // Cmd+P — Toggle projector
      if (meta && matchesKey("p", "KeyP")) {
        e.preventDefault();
        markHandled(e);
        runAction("toggle_projector");
        return;
      }

      // Z — Toggle magnifier
      if (!meta && !e.altKey && matchesKey("z", "KeyZ")) {
        if (isTypingTarget(target)) {
          return;
        }
        e.preventDefault();
        markHandled(e);
        state.toggleMagnifier();
        return;
      }

      // G — Toggle snap to grid
      if (!meta && !e.altKey && matchesKey("g", "KeyG")) {
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
        selectedIds.length > 0
      ) {
        if (isTypingTarget(target)) {
          return;
        }
        const selectedLayers = state.layers.filter((l) => selectedIds.includes(l.id));
        const unlocked = selectedLayers.filter((l) => !l.locked);
        if (unlocked.length === 0) return;

        e.preventDefault();
        markHandled(e);
        const digit = parseInt(e.key);
        const opacity = digit === 0 ? 1.0 : digit / 10;
        for (const layer of unlocked) {
          state.updateProperties(layer.id, { ...layer.properties, opacity });
        }
        return;
      }
    };

    let unlistenNativeMenu: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<string>("native-menu-shortcut", (event) => {
          switch (event.payload) {
            case "undo":
            case "redo":
            case "save":
            case "save_as":
            case "new":
            case "open":
            case "duplicate":
            case "toggle_projector":
              runAction(event.payload);
              break;
            default:
              break;
          }
        })
      )
      .then((unlisten) => {
        unlistenNativeMenu = unlisten;
      })
      .catch(() => {
        // Running without Tauri event bridge (e.g. plain web preview).
      });

    // Capture phase helps intercept Tab before browser focus navigation.
    window.addEventListener("keydown", handler, true);
    document.addEventListener("keydown", handler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      document.removeEventListener("keydown", handler, true);
      if (unlistenNativeMenu) {
        unlistenNativeMenu();
      }
    };
  }, []);
}

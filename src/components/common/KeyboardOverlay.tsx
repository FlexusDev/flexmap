import { useState, useCallback } from "react";
import { useAppStore } from "../../store/useAppStore";

// ── Shortcut definitions ────────────────────────────────────────────────
interface Shortcut {
  keys: string[];          // key ids that light up
  label: string;           // short label shown on the key
  description: string;     // full description on click
  category: "project" | "edit" | "view" | "layer";
}

const SHORTCUTS: Shortcut[] = [
  // Project
  { keys: ["meta", "n"],       label: "New",        description: "Create a new blank project",                   category: "project" },
  { keys: ["meta", "o"],       label: "Open",       description: "Open an existing .auramap project file",       category: "project" },
  { keys: ["meta", "s"],       label: "Save",       description: "Save the current project (Save As if new)",    category: "project" },
  { keys: ["meta", "shift", "s"], label: "Save As",  description: "Save the project to a new file location",     category: "project" },
  // Edit
  { keys: ["esc"],             label: "Deselect",   description: "Clear face selection",                         category: "edit" },
  { keys: ["meta", "z"],       label: "Undo",       description: "Undo the last layer operation",                category: "edit" },
  { keys: ["meta", "shift", "z"], label: "Redo",     description: "Redo the last undone operation",               category: "edit" },
  { keys: ["meta", "d"],       label: "Duplicate",  description: "Duplicate the selected layer",                 category: "edit" },
  { keys: ["delete"],          label: "Delete",     description: "Remove the selected layer",                    category: "edit" },
  { keys: ["backspace"],       label: "Delete",     description: "Remove the selected layer (alternate)",        category: "edit" },
  { keys: ["tab"],             label: "Shape/Edit", description: "Toggle shape vs UV/input edit mode",            category: "edit" },
  // View
  { keys: ["meta", "p"],       label: "Projector",  description: "Toggle the projector output window",           category: "view" },
  // Snap
  { keys: ["g"],               label: "Snap",       description: "Toggle snap-to-grid for point dragging",         category: "edit" },
  // Layer opacity (0-9)
  { keys: ["1"],               label: "10%",        description: "Set selected layer opacity to 10%",            category: "layer" },
  { keys: ["5"],               label: "50%",        description: "Set selected layer opacity to 50%",            category: "layer" },
  { keys: ["0"],               label: "100%",       description: "Set selected layer opacity to 100%",           category: "layer" },
  // Layer nudge
  { keys: ["arrowleft"],       label: "Nudge ←",    description: "Move selected layer left (0.5%)",              category: "layer" },
  { keys: ["arrowright"],      label: "Nudge →",    description: "Move selected layer right (0.5%)",             category: "layer" },
  { keys: ["arrowup"],         label: "Nudge ↑",    description: "Move selected layer up (0.5%)",                category: "layer" },
  { keys: ["arrowdown"],       label: "Nudge ↓",    description: "Move selected layer down (0.5%)",              category: "layer" },
  { keys: ["shift", "arrowleft"],  label: "Fine ←",  description: "Fine-nudge selected layer left (0.1%)",       category: "layer" },
  { keys: ["shift", "arrowright"], label: "Fine →",  description: "Fine-nudge selected layer right (0.1%)",      category: "layer" },
  { keys: ["shift", "arrowup"],    label: "Fine ↑",  description: "Fine-nudge selected layer up (0.1%)",         category: "layer" },
  { keys: ["shift", "arrowdown"],  label: "Fine ↓",  description: "Fine-nudge selected layer down (0.1%)",       category: "layer" },
];

// Build a set of all key IDs that have bindings
const BOUND_KEYS = new Set(SHORTCUTS.flatMap((s) => s.keys));

// ── Virtual keyboard layout ─────────────────────────────────────────────
// Each row is an array of { id, label, width? }
interface VKey {
  id: string;
  label: string;
  w?: number; // width multiplier (1 = standard key)
}

const KB_ROWS: VKey[][] = [
  [
    { id: "esc", label: "Esc" },
    { id: "f1", label: "F1" }, { id: "f2", label: "F2" }, { id: "f3", label: "F3" },
    { id: "f4", label: "F4" }, { id: "f5", label: "F5" }, { id: "f6", label: "F6" },
    { id: "f7", label: "F7" }, { id: "f8", label: "F8" }, { id: "f9", label: "F9" },
    { id: "f10", label: "F10" }, { id: "f11", label: "F11" }, { id: "f12", label: "F12" },
    { id: "delete", label: "Del" },
  ],
  [
    { id: "`", label: "`" }, { id: "1", label: "1" }, { id: "2", label: "2" },
    { id: "3", label: "3" }, { id: "4", label: "4" }, { id: "5", label: "5" },
    { id: "6", label: "6" }, { id: "7", label: "7" }, { id: "8", label: "8" },
    { id: "9", label: "9" }, { id: "0", label: "0" }, { id: "-", label: "-" },
    { id: "=", label: "=" }, { id: "backspace", label: "⌫", w: 1.5 },
  ],
  [
    { id: "tab", label: "Tab", w: 1.5 },
    { id: "q", label: "Q" }, { id: "w", label: "W" }, { id: "e", label: "E" },
    { id: "r", label: "R" }, { id: "t", label: "T" }, { id: "y", label: "Y" },
    { id: "u", label: "U" }, { id: "i", label: "I" }, { id: "o", label: "O" },
    { id: "p", label: "P" }, { id: "[", label: "[" }, { id: "]", label: "]" },
    { id: "\\", label: "\\" },
  ],
  [
    { id: "caps", label: "Caps", w: 1.8 },
    { id: "a", label: "A" }, { id: "s", label: "S" }, { id: "d", label: "D" },
    { id: "f", label: "F" }, { id: "g", label: "G" }, { id: "h", label: "H" },
    { id: "j", label: "J" }, { id: "k", label: "K" }, { id: "l", label: "L" },
    { id: ";", label: ";" }, { id: "'", label: "'" },
    { id: "enter", label: "Return", w: 1.8 },
  ],
  [
    { id: "shift", label: "Shift", w: 2.3 },
    { id: "z", label: "Z" }, { id: "x", label: "X" }, { id: "c", label: "C" },
    { id: "v", label: "V" }, { id: "b", label: "B" }, { id: "n", label: "N" },
    { id: "m", label: "M" }, { id: ",", label: "," }, { id: ".", label: "." },
    { id: "/", label: "/" },
    { id: "shift-r", label: "Shift", w: 2.3 },
  ],
  [
    { id: "fn", label: "Fn", w: 1 },
    { id: "ctrl", label: "Ctrl", w: 1 },
    { id: "alt", label: "Opt", w: 1 },
    { id: "meta", label: "⌘", w: 1.4 },
    { id: "space", label: "", w: 5.5 },
    { id: "meta-r", label: "⌘", w: 1.4 },
    { id: "alt-r", label: "Opt", w: 1 },
    { id: "arrowleft", label: "←", w: 1 },
    { id: "arrowup", label: "↑", w: 1 },
    { id: "arrowdown", label: "↓", w: 1 },
    { id: "arrowright", label: "→", w: 1 },
  ],
];

// Normalise key ids for matching (shift-r → shift, meta-r → meta)
function normalize(id: string): string {
  if (id === "shift-r") return "shift";
  if (id === "meta-r") return "meta";
  if (id === "alt-r") return "alt";
  return id;
}

// ── Category colours ────────────────────────────────────────────────────
const CAT_COLORS: Record<string, { bg: string; ring: string; text: string }> = {
  project: { bg: "bg-indigo-500/20", ring: "ring-indigo-400/60", text: "text-indigo-300" },
  edit:    { bg: "bg-amber-500/20",  ring: "ring-amber-400/60",  text: "text-amber-300" },
  view:    { bg: "bg-emerald-500/20", ring: "ring-emerald-400/60", text: "text-emerald-300" },
  layer:   { bg: "bg-sky-500/20",    ring: "ring-sky-400/60",    text: "text-sky-300" },
};

// ── Component ───────────────────────────────────────────────────────────

function KeyboardOverlay() {
  const [open, setOpen] = useState(false);
  const [activeShortcut, setActiveShortcut] = useState<Shortcut | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const {
    layers,
    selectedLayerId,
    selectedLayerIds,
    editorSelectionMode,
    setEditorSelectionMode,
    toggleEditorSelectionMode,
  } = useAppStore((s) => ({
    layers: s.layers,
    selectedLayerId: s.selectedLayerId,
    selectedLayerIds: s.selectedLayerIds,
    editorSelectionMode: s.editorSelectionMode,
    setEditorSelectionMode: s.setEditorSelectionMode,
    toggleEditorSelectionMode: s.toggleEditorSelectionMode,
  }));

  const selectedLayer = selectedLayerId
    ? layers.find((l) => l.id === selectedLayerId) ?? null
    : null;
  const selectedCount = selectedLayerIds.length > 0
    ? selectedLayerIds.length
    : selectedLayer
      ? 1
      : 0;
  const modeIsUv = selectedCount === 1 && editorSelectionMode === "uv" && !!selectedLayer;
  const uvLabel = selectedLayer?.geometry.type === "Mesh" ? "UV" : "Input";

  const setModeFromPopup = (mode: "shape" | "uv") => {
    if (!selectedLayer || selectedCount !== 1) {
      setEditorSelectionMode("shape");
      return;
    }
    setEditorSelectionMode(mode);
  };

  const toggleModeFromPopup = () => {
    if (!selectedLayer || selectedCount !== 1) {
      setEditorSelectionMode("shape");
      return;
    }
    toggleEditorSelectionMode();
  };

  // Find all shortcuts a key belongs to
  const shortcutsForKey = useCallback(
    (keyId: string): Shortcut[] =>
      SHORTCUTS.filter((s) => s.keys.includes(normalize(keyId))),
    []
  );

  // Is this key part of the currently selected shortcut?
  const isActiveKey = (keyId: string) =>
    activeShortcut?.keys.includes(normalize(keyId)) ?? false;

  // Is this key bound to anything?
  const isBound = (keyId: string) => BOUND_KEYS.has(normalize(keyId));

  const handleKeyClick = (keyId: string) => {
    if (normalize(keyId) === "tab") {
      toggleModeFromPopup();
    }
    const matches = shortcutsForKey(keyId);
    if (matches.length === 0) {
      setActiveShortcut(null);
      return;
    }
    // Cycle through if multiple
    if (activeShortcut && matches.includes(activeShortcut)) {
      const idx = matches.indexOf(activeShortcut);
      setActiveShortcut(matches[(idx + 1) % matches.length]);
    } else {
      setActiveShortcut(matches[0]);
    }
  };

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className={`
          fixed bottom-10 right-4 z-40
          w-9 h-9 rounded-lg
          flex items-center justify-center
          transition-all duration-200
          ${open
            ? "bg-aura-accent text-white shadow-lg shadow-aura-accent/30 scale-105"
            : "bg-aura-surface/80 text-aura-text-dim border border-aura-border hover:border-aura-accent/50 hover:text-aura-text backdrop-blur-sm"
          }
        `}
        title="Keyboard shortcuts"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <line x1="6" y1="8" x2="6" y2="8" />
          <line x1="10" y1="8" x2="10" y2="8" />
          <line x1="14" y1="8" x2="14" y2="8" />
          <line x1="18" y1="8" x2="18" y2="8" />
          <line x1="6" y1="12" x2="6" y2="12" />
          <line x1="10" y1="12" x2="10" y2="12" />
          <line x1="14" y1="12" x2="14" y2="12" />
          <line x1="18" y1="12" x2="18" y2="12" />
          <line x1="8" y1="16" x2="16" y2="16" />
        </svg>
      </button>

      {/* Overlay */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center pb-16 pointer-events-none">
          {/* Backdrop — click to close */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm pointer-events-auto"
            onClick={() => { setOpen(false); setActiveShortcut(null); }}
          />

          {/* Panel */}
          <div
            className="
              relative pointer-events-auto
              bg-gradient-to-b from-[#1c1c24] to-[#14141a]
              border border-white/[0.06] rounded-2xl
              shadow-2xl shadow-black/50
              p-5 max-w-[720px] w-full
              animate-slideUp
            "
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-6 h-6 rounded-md bg-aura-accent/20 flex items-center justify-center">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <line x1="8" y1="16" x2="16" y2="16" />
                  </svg>
                </div>
                <span className="text-sm font-medium text-white/90 tracking-tight">
                  Keyboard Shortcuts
                </span>
              </div>

              {/* Category legend */}
              <div className="flex items-center gap-3">
                {Object.entries(CAT_COLORS).map(([cat, c]) => (
                  <span key={cat} className={`text-[10px] uppercase tracking-wider ${c.text} opacity-70`}>
                    {cat}
                  </span>
                ))}
                <div className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-0.5">
                  <button
                    type="button"
                    disabled={!selectedLayer}
                    onClick={() => setModeFromPopup("shape")}
                    className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider transition ${
                      !modeIsUv
                        ? "text-indigo-200 bg-indigo-500/25 border border-indigo-400/40"
                        : "text-white/55 hover:text-white/80"
                    }`}
                    title="Switch to Shape edit mode"
                  >
                    Shape
                  </button>
                  <button
                    type="button"
                    disabled={!selectedLayer}
                    onClick={() => setModeFromPopup("uv")}
                    className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider transition ${
                      modeIsUv
                        ? (selectedLayer?.geometry.type === "Mesh"
                          ? "text-amber-200 bg-amber-500/25 border border-amber-400/40"
                          : "text-cyan-200 bg-cyan-500/25 border border-cyan-400/40")
                        : "text-white/55 hover:text-white/80"
                    }`}
                    title={`Switch to ${uvLabel} edit mode`}
                  >
                    {uvLabel}
                  </button>
                </div>
              </div>
            </div>

            {/* Virtual keyboard */}
            <div className="flex flex-col gap-[3px]">
              {KB_ROWS.map((row, ri) => (
                <div key={ri} className="flex gap-[3px]">
                  {row.map((key) => {
                    const bound = isBound(key.id);
                    const active = isActiveKey(key.id);
                    const hovered = hoveredKey === key.id;
                    const matches = shortcutsForKey(key.id);
                    const topMatch = matches[0];
                    const cat = topMatch ? CAT_COLORS[topMatch.category] : null;
                    const widthPx = (key.w ?? 1) * 42;
                    const tabModeAccent = key.id === "tab"
                      ? (modeIsUv
                        ? (selectedLayer?.geometry.type === "Mesh"
                          ? "ring-1 ring-amber-400/60 bg-amber-500/20 text-amber-200"
                          : "ring-1 ring-cyan-400/60 bg-cyan-500/20 text-cyan-200")
                        : "ring-1 ring-indigo-400/60 bg-indigo-500/20 text-indigo-200")
                      : "";

                    return (
                      <button
                        key={key.id}
                        style={{ width: widthPx, minWidth: widthPx }}
                        className={`
                          h-[34px] rounded-md text-[10px] font-medium
                          flex items-center justify-center
                          transition-all duration-150 relative
                          ${active
                            ? `bg-white text-[#14141a] shadow-md shadow-white/20 scale-[1.06] ring-1 ${cat?.ring ?? "ring-white/30"}`
                            : bound
                              ? `${cat?.bg ?? "bg-white/10"} text-white/90 ring-1 ${cat?.ring ?? "ring-white/10"} hover:scale-[1.04] hover:brightness-125 cursor-pointer`
                              : "bg-white/[0.04] text-white/20 cursor-default"
                          }
                          ${hovered && bound && !active ? "brightness-125 scale-[1.04]" : ""}
                          ${!active && tabModeAccent}
                        `}
                        onClick={() => handleKeyClick(key.id)}
                        onMouseEnter={() => setHoveredKey(key.id)}
                        onMouseLeave={() => setHoveredKey(null)}
                      >
                        {key.label}
                        {/* Dot indicator for bound keys */}
                        {bound && !active && (
                          <span className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${cat?.text?.replace("text-", "bg-") ?? "bg-white/50"}`} />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Description area */}
            <div className="mt-4 h-[52px] rounded-lg bg-white/[0.03] border border-white/[0.04] flex items-center px-4">
              {activeShortcut ? (
                <div className="flex items-center gap-3 w-full">
                  {/* Key combo */}
                  <div className="flex items-center gap-1">
                    {activeShortcut.keys.map((k) => (
                      <kbd
                        key={k}
                        className={`
                          px-2 py-0.5 rounded text-[11px] font-semibold
                          bg-white/10 text-white/80 border border-white/10
                        `}
                      >
                        {k === "meta" ? "⌘" : k === "shift" ? "⇧" : k === "delete" ? "Del" : k === "backspace" ? "⌫" : k.replace("arrow", "")}
                      </kbd>
                    ))}
                  </div>
                  {/* Divider */}
                  <div className="w-px h-5 bg-white/10" />
                  {/* Label & description */}
                  <div className="flex-1 min-w-0">
                    <span className={`text-xs font-semibold ${CAT_COLORS[activeShortcut.category]?.text ?? "text-white"}`}>
                      {activeShortcut.label}
                    </span>
                    <span className="text-xs text-white/40 ml-2">
                      {activeShortcut.description}
                    </span>
                  </div>
                  {/* Category badge */}
                  <span className={`text-[9px] uppercase tracking-widest px-2 py-0.5 rounded-full ${CAT_COLORS[activeShortcut.category]?.bg} ${CAT_COLORS[activeShortcut.category]?.text} opacity-60`}>
                    {activeShortcut.category}
                  </span>
                </div>
              ) : (
                <span className="text-xs text-white/25 italic">
                  Click a highlighted key to see its shortcut
                </span>
              )}
            </div>

            {/* Close hint */}
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 text-[10px] text-white/20">
              click outside or press Esc to close
            </div>
          </div>
        </div>
      )}

      {/* Slide-up animation */}
      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .animate-slideUp {
          animation: slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
    </>
  );
}

export default KeyboardOverlay;

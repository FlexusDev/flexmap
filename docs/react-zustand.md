# React 18 + Zustand 4 Reference

> **Pinned versions: React 18.3.1, Zustand 4.5.x.** Do NOT upgrade.
> - React 19 has breaking changes (new compiler, hooks changes, removed legacy APIs).
> - Zustand 5 requires `useShallow` for array selectors, stricter `setState` types.

## State Management

Zustand store (`useAppStore`) mirrors backend state. All mutations are `async` — they invoke the Tauri command, then optimistically update local state.

### Store Pattern
```typescript
// src/store/useAppStore.ts
import { create } from 'zustand';

interface AppState {
  layers: Layer[];
  selectedLayerId: string | null;
  // ...actions
  addLayer: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  layers: [],
  selectedLayerId: null,
  addLayer: async () => {
    const layer = await invoke('add_layer', { ... });
    set(state => ({ layers: [...state.layers, layer] }));
  },
}));
```

### Selector Pattern (Zustand 4)
```typescript
// Simple selector — no useShallow needed in v4
const layers = useAppStore(state => state.layers);

// Multiple values — this works fine in v4 (would break in v5 without useShallow)
const { layers, selectedLayerId } = useAppStore(state => ({
  layers: state.layers,
  selectedLayerId: state.selectedLayerId,
}));
```

## Key Files
- `src/store/` — Zustand store
- `src/hooks/` — custom React hooks
- `src/components/` — React components organized by feature
- `src/types/index.ts` — TypeScript interfaces

## Undo/Redo (Frontend Side)
- `begin_interaction()` is called ONCE before a drag/nudge burst starts
- High-frequency updates (sliders, geometry drag) must NOT push undo per-frame
- Discrete actions (add/remove/duplicate/reorder/set_source) push undo internally

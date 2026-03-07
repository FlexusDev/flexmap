# React 19 + Zustand 5 Reference

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

### Selector Patterns (Zustand 5)
```typescript
// Simple scalar selector — no useShallow needed
const layers = useAppStore(state => state.layers);

// Object/array-returning selectors REQUIRE useShallow in Zustand 5
import { useShallow } from 'zustand/react/shallow';

const { layers, selectedLayerId } = useAppStore(useShallow(state => ({
  layers: state.layers,
  selectedLayerId: state.selectedLayerId,
})));
```

> **Important**: In Zustand 5, selectors that return new object/array references on every call
> will cause infinite re-render loops. Always wrap them with `useShallow`.

### React 19 Notes
- `RefObject<T>` now requires explicit `null`: use `RefObject<HTMLDivElement | null>`
- `forwardRef` is no longer needed — `ref` is a regular prop
- No `defaultProps` or `propTypes` — use TypeScript interfaces

## Key Files
- `src/store/` — Zustand store
- `src/hooks/` — custom React hooks
- `src/components/` — React components organized by feature
- `src/types/index.ts` — TypeScript interfaces

## Undo/Redo (Frontend Side)
- `begin_interaction()` is called ONCE before a drag/nudge burst starts
- High-frequency updates (sliders, geometry drag) must NOT push undo per-frame
- Discrete actions (add/remove/duplicate/reorder/set_source) push undo internally

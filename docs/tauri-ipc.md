# Tauri v2 IPC Reference

> **On Tauri 2.10.x** (latest stable). No upgrade needed.

## IPC Command Pattern

Every mutation command in `commands.rs` must:
1. Mutate `SceneState` (via `RwLock` write guard)
2. Call `sync_render_state(&state, &render)` to push changes to the GPU
3. Return the result to the frontend

### Adding a New Command

1. **Rust** — add command function in `src-tauri/src/commands.rs`:
   ```rust
   #[tauri::command]
   pub fn my_command(state: State<'_, AppState>, ...) -> Result<ReturnType, String> {
       let mut scene = state.scene.write();
       // mutate scene...
       sync_render_state(&state.scene, &state.render);
       Ok(result)
   }
   ```

2. **Register** in `src-tauri/src/lib.rs` → `invoke_handler`:
   ```rust
   .invoke_handler(tauri::generate_handler![
       commands::my_command,
       // ...
   ])
   ```

3. **Mock** in `src/lib/tauri-bridge.ts`:
   ```typescript
   my_command: async (args: { ... }): Promise<ReturnType> => {
       // mock implementation
   }
   ```

4. **Types** — add TypeScript types in `src/types/index.ts` if new data structures are involved.

## Key Files
- `src-tauri/src/commands.rs` — all IPC command handlers
- `src-tauri/src/lib.rs` — command registration, app builder
- `src/lib/tauri-bridge.ts` — browser mock implementations
- `src/types/index.ts` — shared TypeScript types

## Frontend Invocation
```typescript
import { invoke } from '../lib/tauri-bridge';
const result = await invoke('my_command', { arg1: value });
```

## Borrow Checker Pattern for Commands
When you need to clone + mutate on the same `RwLock<T>`:
1. Check existence with `.any()` (immutable borrow ends)
2. Clone snapshot
3. Find with `.iter_mut().find()` (mutable borrow)

Never hold a read guard and write guard on the same lock simultaneously.

## Windows
- **Main window**: full editor UI with all panels
- **Projector window**: fullscreen output only — no UI overlays, no keyboard widget

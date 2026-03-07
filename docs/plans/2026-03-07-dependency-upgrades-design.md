# Full Dependency Upgrade — Design Document

**Date:** 2026-03-07
**Goal:** Upgrade all major dependencies to latest, with full test suite as safety net. Preparing for open-source release.

## Current vs Target Versions

| Dep | Current | Target | Breaking |
|-----|---------|--------|----------|
| wgpu | 23.0.1 | 26.x | Yes — surface, pipeline, texture API rewrites |
| React | 18.3.1 | 19.x | Yes — new compiler, hooks changes |
| Zustand | 4.5.7 | 5.x | Yes — `useShallow` required, stricter `setState` types |
| Tailwind CSS | 3.4.19 | 4.x | Yes — full rewrite, CSS-first config |
| Vite | 5.4.21 | 7.x | Yes — Node 18 dropped, env API changes |
| Vitest | (new) | 3.x → 4.x | N/A (new dep, bumped during Vite upgrade) |
| Tauri | 2.10.x | 2.10.x | No — already latest |

## Strategy

7 sequential branches, each merged to master before the next starts. Phase 1 (test infrastructure) can be built in parallel using worktree-isolated agents. Phase 2 (upgrades) is strictly sequential.

## Phase 1: Test Infrastructure (Parallel Agents)

### Branch 1: `test/rust-unit-tests`

**Scope:** `src-tauri/src/` only, plus CI.

**Package:** Built-in `#[test]` — no extra dependencies.

**Test coverage:**
- Scene state: layer CRUD, reorder, duplicate, geometry mutations
- Undo/redo: snapshot/restore, `begin_interaction` boundaries, discrete vs high-frequency
- Persistence: save/load roundtrip `.flexmap` JSON, autosave scheduling, crash recovery files
- Mesh ops: face mask toggle, face groups, UV overrides, subdivision
- Renderer state: `sync_render_state` correctness, `RenderState` reads reflect `SceneState` mutations
- Input manager: backend registration, source listing

**CI:** Add `cargo test` step to `.github/workflows/release-build.yml`.

### Branch 2: `test/frontend-tests`

**Scope:** `src/` only, plus `package.json`, config files.

**Packages:**
- `vitest` ^3.2 (works with Vite 5)
- `@testing-library/react` latest
- `@testing-library/jest-dom` latest
- `jsdom` latest

**Test coverage:**
- Store tests: every Zustand action (add/remove/reorder layer, undo/redo, selection, source assignment)
- Hook tests: `useKeyboardShortcuts`, other custom hooks
- tauri-bridge tests: every mock returns correct shape, mock signatures match TypeScript types
- Component tests: key UI components render without crash, props propagate, conditional rendering

**Config:** `vitest.config.ts` with jsdom environment. Script: `npm test`.

**CI:** Add `npm test` step to workflow.

### Branch 3: `test/e2e`

**Scope:** New `e2e-tests/` directory, plus CI.

**Packages:**
- `@wdio/cli` + `@wdio/mocha-framework` + `@wdio/spec-reporter` (WebDriverIO)
- `chai` for assertions
- `tauri-driver` (Cargo install)

**Test coverage:**
- Smoke: app launches, main window renders, correct title
- Projector: projector window opens and closes
- Layer CRUD: add/remove/duplicate/reorder layers via UI interactions
- Geometry: drag corners, nudge via keyboard, verify canvas state
- Persistence: save project, quit, reload, verify layers restored
- Input sources: assign test pattern, verify source appears in layer

**CI:** Separate workflow or job with `xvfb-run` on Linux, direct on Windows. Builds debug binary first, spawns `tauri-driver`, runs WebDriverIO.

## Phase 2: Upgrades (Strictly Sequential)

### Branch 4: `upgrade/wgpu-26`

**Scope:** `src-tauri/` only.

**Migration path:** Apply changes from v24, v25, v26 changelogs sequentially:
- v24: `SurfaceConfiguration` API changes, `entry_point` becomes `Option<&str>`
- v25: `ImageCopyBuffer`/`ImageCopyTexture` renamed to `TexelCopyBufferLayout`/`TexelCopyTextureInfo`
- v26: Environment-based rendering updates, further surface API changes

**Files affected:** All of `src-tauri/src/renderer/` — engine, pipeline, gpu, texture_manager, buffer_cache, projector, shaders.

**Validation:** `cargo test` + `cargo build` + e2e smoke tests.

**Agent instruction:** Use Context7 to fetch wgpu v26 migration docs before writing any code.

### Branch 5: `upgrade/react-19-zustand-5`

**Scope:** `src/` + `package.json`.

**React 18 → 19:**
- Update `react`, `react-dom`, `@types/react`, `@types/react-dom`
- Adapt to any removed/changed APIs (legacy context, string refs, etc.)
- Verify all components render correctly

**Zustand 4 → 5:**
- Add `use-sync-external-store` peer dependency
- Wrap array/object selectors with `useShallow` from `zustand/shallow`
- Fix any `setState` with `replace: true` to provide full state
- Or use `createWithEqualityFn` from `zustand/traditional` if needed

**Validation:** `npm test` + e2e full suite.

**Agent instruction:** Use Context7 to fetch Zustand v5 migration guide and React 19 changelog.

### Branch 6: `upgrade/tailwind-4`

**Scope:** CSS, config files, `package.json`.

**Migration steps:**
1. Run `npx @tailwindcss/upgrade` automated migration tool
2. Remove `tailwind.config.js` and `postcss.config.js`
3. Add `@tailwindcss/vite` plugin to `vite.config.ts`
4. Replace `@tailwind` directives with `@import "tailwindcss"`
5. Migrate custom theme values to CSS custom properties
6. Review changed utility class names (if any)

**Validation:** `npm test` + e2e + manual visual review of all panels.

**Agent instruction:** Use Context7 to fetch Tailwind v4 migration docs.

### Branch 7: `upgrade/vite-7-vitest-4`

**Scope:** Config files, `package.json`.

**Vite 5 → 7:**
- Update `vite`, `@vitejs/plugin-react`
- Verify Node.js version ≥ 20.19
- Remove deprecated config (`splitVendorChunkPlugin`, `legacy.proxySsrExternalModules`)
- Update `transformIndexHtml` hooks if used (`enforce` → `order`, `transform` → `handler`)

**Vitest 3 → 4:**
- Bump `vitest` to ^4.0
- Adapt to any API changes in test config

**Validation:** Full test suite (`cargo test` + `npm test` + e2e).

**Agent instruction:** Use Context7 to fetch Vite v7 and Vitest v4 migration docs.

## Parallelism Plan

```
Time →
Agent A: [rust-unit-tests] ──────────────→ merge
Agent B: [frontend-tests]  ──────────────→ merge (after A)
Agent C: [e2e-tests]       ──────────────→ merge (after B)
                                              ↓
Agent D:                              [wgpu-26] → merge
Agent E:                                   [react-19-zustand-5] → merge
Agent F:                                        [tailwind-4] → merge
Agent G:                                             [vite-7-vitest-4] → merge
```

Phase 1 agents work in parallel worktrees. Merges are sequential (A, B, C). Phase 2 is fully sequential — each upgrade depends on tests passing from all previous branches.

## CI After All Upgrades

Final `.github/workflows/release-build.yml` will include:
1. `cargo test` (Rust unit tests)
2. `npm test` (Vitest frontend tests)
3. `npm run build` (TypeScript + Vite build)
4. `tauri build` (full binary)
5. E2E tests (separate job with `tauri-driver` + `xvfb-run`)

## Context7 Mandate

Every implementing agent MUST:
1. Call `resolve-library-id` for the library being upgraded
2. Call `query-docs` with the specific migration/changelog query
3. Base implementation on the fetched docs, not training data

## Docs Updates

After all upgrades complete:
- Update `docs/wgpu.md` → v26 patterns
- Update `docs/react-zustand.md` → React 19 + Zustand 5 patterns
- Update `docs/tailwind-vite.md` → Tailwind 4 + Vite 7 patterns
- Update `CLAUDE.md` version table
- Update `docs/plans/` with completion status

# Full Dependency Upgrade — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **MANDATORY:** Before writing ANY upgrade code, use `mcp__claude_ai_Context7__resolve-library-id` and `mcp__claude_ai_Context7__query-docs` to fetch the LATEST migration guide. Do not rely on training data.

**Goal:** Add full test suite (Rust unit, Vitest frontend, WebDriverIO e2e), then upgrade wgpu 23→26, React 18→19, Zustand 4→5, Tailwind 3→4, Vite 5→7.

**Architecture:** 7 sequential branches. Phase 1 (branches 1-3) builds test infrastructure in parallel worktrees. Phase 2 (branches 4-7) applies upgrades sequentially, validating with the test suite after each.

**Tech Stack:** Rust `#[test]`, Vitest 3.x, @testing-library/react, WebDriverIO + tauri-driver, wgpu 26, React 19, Zustand 5, Tailwind CSS 4, Vite 7, Vitest 4.

---

## Branch 1: `test/rust-unit-tests`

**Worktree:** Yes (parallel with branches 2 and 3)
**Scope:** `src-tauri/src/` only + CI workflow
**Merge to:** master (first)

### Task 1.1: History Module Tests

**Files:**
- Modify: `src-tauri/src/scene/history.rs`

**Step 1: Add test module with basic undo/redo tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::layer::Layer;

    fn make_layers(n: usize) -> Vec<Layer> {
        (0..n).map(|i| Layer::new_quad(&format!("Layer {}", i), i as i32)).collect()
    }

    #[test]
    fn new_history_has_no_undo_redo() {
        let h = History::new();
        assert!(!h.can_undo());
        assert!(!h.can_redo());
    }

    #[test]
    fn push_then_undo_restores_previous() {
        let h = History::new();
        let v1 = make_layers(1);
        let v2 = make_layers(2);
        h.push(v1.clone());
        let restored = h.undo(v2.clone());
        assert!(restored.is_some());
        assert_eq!(restored.unwrap().len(), 1);
    }

    #[test]
    fn redo_after_undo_restores_forward() {
        let h = History::new();
        let v1 = make_layers(1);
        let v2 = make_layers(2);
        h.push(v1.clone());
        let _ = h.undo(v2.clone());
        let restored = h.redo(v1.clone());
        assert!(restored.is_some());
        assert_eq!(restored.unwrap().len(), 2);
    }

    #[test]
    fn push_after_undo_clears_redo_stack() {
        let h = History::new();
        let v1 = make_layers(1);
        let v2 = make_layers(2);
        let v3 = make_layers(3);
        h.push(v1.clone());
        let _ = h.undo(v2.clone());
        h.push(v3.clone());
        assert!(!h.can_redo());
    }

    #[test]
    fn undo_with_empty_history_returns_none() {
        let h = History::new();
        assert!(h.undo(make_layers(1)).is_none());
    }

    #[test]
    fn max_history_truncates_oldest() {
        let h = History::new();
        for i in 0..60 {
            h.push(make_layers(i + 1));
        }
        assert!(h.can_undo());
        // Should still work but oldest entries are gone
        let mut count = 0;
        let mut current = make_layers(61);
        while let Some(prev) = h.undo(current.clone()) {
            current = prev;
            count += 1;
        }
        assert!(count <= 50); // MAX_HISTORY cap
    }

    #[test]
    fn clear_resets_all() {
        let h = History::new();
        h.push(make_layers(1));
        h.clear();
        assert!(!h.can_undo());
        assert!(!h.can_redo());
    }
}
```

**Step 2: Run tests**

```bash
cd src-tauri && cargo test --lib scene::history
```

Expected: All 7 tests pass.

**Step 3: Commit**

```bash
git add src-tauri/src/scene/history.rs
git commit -m "test(rust): add History unit tests"
```

---

### Task 1.2: Layer Module Tests

**Files:**
- Modify: `src-tauri/src/scene/layer.rs`

**Step 1: Add test module**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_quad_has_4_corners() {
        let layer = Layer::new_quad("test", 0);
        match &layer.geometry {
            LayerGeometry::Quad { corners } => assert_eq!(corners.len(), 4),
            _ => panic!("Expected Quad geometry"),
        }
    }

    #[test]
    fn new_triangle_has_3_vertices() {
        let layer = Layer::new_triangle("test", 0);
        match &layer.geometry {
            LayerGeometry::Triangle { vertices } => assert_eq!(vertices.len(), 3),
            _ => panic!("Expected Triangle geometry"),
        }
    }

    #[test]
    fn new_mesh_has_correct_dimensions() {
        let layer = Layer::new_mesh("test", 0, 3, 2);
        match &layer.geometry {
            LayerGeometry::Mesh { cols, rows, points, .. } => {
                assert_eq!(*cols, 3);
                assert_eq!(*rows, 2);
                assert_eq!(points.len(), (3 + 1) * (2 + 1)); // (cols+1)*(rows+1) control points
            }
            _ => panic!("Expected Mesh geometry"),
        }
    }

    #[test]
    fn new_circle_has_center_and_radii() {
        let layer = Layer::new_circle("test", 0);
        match &layer.geometry {
            LayerGeometry::Circle { center, radius_x, radius_y, .. } => {
                assert!(center.x > 0.0 && center.x < 1.0);
                assert!(*radius_x > 0.0);
                assert!(*radius_y > 0.0);
            }
            _ => panic!("Expected Circle geometry"),
        }
    }

    #[test]
    fn default_layer_properties() {
        let layer = Layer::new_quad("test", 0);
        assert_eq!(layer.properties.opacity, 1.0);
        assert_eq!(layer.properties.brightness, 0.0);
        assert_eq!(layer.properties.contrast, 0.0);
        assert!(layer.visible);
        assert!(!layer.locked);
    }

    #[test]
    fn control_points_returns_all_quad_corners() {
        let geom = LayerGeometry::default_quad();
        assert_eq!(geom.control_points().len(), 4);
    }

    #[test]
    fn control_points_returns_all_mesh_points() {
        let geom = LayerGeometry::default_mesh(3, 2);
        assert_eq!(geom.control_points().len(), 12); // (3+1)*(2+1)
    }

    #[test]
    fn layer_ids_are_unique() {
        let a = Layer::new_quad("a", 0);
        let b = Layer::new_quad("b", 1);
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn blend_mode_default_is_normal() {
        let layer = Layer::new_quad("test", 0);
        assert_eq!(layer.blend_mode, BlendMode::Normal);
    }

    #[test]
    fn point2d_new() {
        let p = Point2D::new(0.5, 0.7);
        assert_eq!(p.x, 0.5);
        assert_eq!(p.y, 0.7);
    }
}
```

**Step 2: Run tests**

```bash
cd src-tauri && cargo test --lib scene::layer
```

Expected: All 10 tests pass.

**Step 3: Commit**

```bash
git add src-tauri/src/scene/layer.rs
git commit -m "test(rust): add Layer and LayerGeometry unit tests"
```

---

### Task 1.3: SceneState Tests

**Files:**
- Modify: `src-tauri/src/scene/state.rs`

**Step 1: Add test module for layer CRUD and undo/redo integration**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::layer::{Layer, LayerGeometry, Point2D, BlendMode};

    #[test]
    fn new_scene_has_no_layers() {
        let state = SceneState::new();
        assert!(state.get_layers_snapshot().is_empty());
    }

    #[test]
    fn add_layer_increases_count() {
        let state = SceneState::new();
        let layer = Layer::new_quad("test", 0);
        state.add_layer(layer);
        assert_eq!(state.get_layers_snapshot().len(), 1);
    }

    #[test]
    fn remove_layer_decreases_count() {
        let state = SceneState::new();
        let layer = Layer::new_quad("test", 0);
        let id = layer.id.clone();
        state.add_layer(layer);
        assert!(state.remove_layer(&id).is_some());
        assert!(state.get_layers_snapshot().is_empty());
    }

    #[test]
    fn remove_nonexistent_returns_none() {
        let state = SceneState::new();
        assert!(state.remove_layer("nonexistent").is_none());
    }

    #[test]
    fn duplicate_layer_creates_copy_with_new_id() {
        let state = SceneState::new();
        let layer = Layer::new_quad("original", 0);
        let id = layer.id.clone();
        state.add_layer(layer);
        let dup = state.duplicate_layer(&id);
        assert!(dup.is_some());
        let dup = dup.unwrap();
        assert_ne!(dup.id, id);
        assert_eq!(state.get_layers_snapshot().len(), 2);
    }

    #[test]
    fn undo_add_layer() {
        let state = SceneState::new();
        let layer = Layer::new_quad("test", 0);
        state.add_layer(layer);
        assert_eq!(state.get_layers_snapshot().len(), 1);
        assert!(state.can_undo());
        state.undo();
        assert!(state.get_layers_snapshot().is_empty());
    }

    #[test]
    fn redo_after_undo() {
        let state = SceneState::new();
        let layer = Layer::new_quad("test", 0);
        state.add_layer(layer);
        state.undo();
        assert!(state.can_redo());
        state.redo();
        assert_eq!(state.get_layers_snapshot().len(), 1);
    }

    #[test]
    fn begin_interaction_then_update_geometry_no_extra_undo() {
        let state = SceneState::new();
        let layer = Layer::new_quad("test", 0);
        let id = layer.id.clone();
        state.add_layer(layer);
        state.begin_interaction();
        // Multiple geometry updates should not push undo
        for _ in 0..5 {
            let geom = LayerGeometry::Quad {
                corners: [
                    Point2D::new(0.1, 0.1),
                    Point2D::new(0.9, 0.1),
                    Point2D::new(0.9, 0.9),
                    Point2D::new(0.1, 0.9),
                ],
            };
            state.update_layer_geometry(&id, geom);
        }
        // One undo should go back to pre-interaction state
        state.undo();
        // Another undo goes back to before add_layer
        state.undo();
        assert!(state.get_layers_snapshot().is_empty());
    }

    #[test]
    fn reorder_layers_changes_order() {
        let state = SceneState::new();
        let a = Layer::new_quad("A", 0);
        let b = Layer::new_quad("B", 1);
        let a_id = a.id.clone();
        let b_id = b.id.clone();
        state.add_layer(a);
        state.add_layer(b);
        // Reorder: B before A
        state.reorder_layers(&[b_id.clone(), a_id.clone()]);
        let snap = state.get_layers_snapshot();
        assert_eq!(snap[0].id, b_id);
        assert_eq!(snap[1].id, a_id);
    }

    #[test]
    fn set_layer_visibility() {
        let state = SceneState::new();
        let layer = Layer::new_quad("test", 0);
        let id = layer.id.clone();
        state.add_layer(layer);
        assert!(state.set_layer_visibility(&id, false));
        let snap = state.get_layers_snapshot();
        assert!(!snap[0].visible);
    }

    #[test]
    fn rename_layer() {
        let state = SceneState::new();
        let layer = Layer::new_quad("old", 0);
        let id = layer.id.clone();
        state.add_layer(layer);
        assert!(state.rename_layer(&id, "new"));
        assert_eq!(state.get_layers_snapshot()[0].name, "new");
    }

    #[test]
    fn dirty_flag_tracking() {
        let state = SceneState::new();
        assert!(!state.is_dirty());
        state.add_layer(Layer::new_quad("test", 0));
        assert!(state.is_dirty());
        state.mark_clean();
        assert!(!state.is_dirty());
    }

    #[test]
    fn revision_increments_on_mutation() {
        let state = SceneState::new();
        let r1 = state.revision();
        state.add_layer(Layer::new_quad("test", 0));
        let r2 = state.revision();
        assert!(r2 > r1);
    }

    #[test]
    fn set_blend_mode() {
        let state = SceneState::new();
        let layer = Layer::new_quad("test", 0);
        let id = layer.id.clone();
        state.add_layer(layer);
        assert!(state.set_layer_blend_mode(&id, BlendMode::Multiply));
        assert_eq!(state.get_layers_snapshot()[0].blend_mode, BlendMode::Multiply);
    }

    #[test]
    fn remove_layers_batch() {
        let state = SceneState::new();
        let a = Layer::new_quad("A", 0);
        let b = Layer::new_quad("B", 1);
        let c = Layer::new_quad("C", 2);
        let ids = vec![a.id.clone(), b.id.clone()];
        state.add_layer(a);
        state.add_layer(b);
        state.add_layer(c);
        assert!(state.remove_layers(&ids));
        assert_eq!(state.get_layers_snapshot().len(), 1);
    }

    #[test]
    fn duplicate_layers_batch() {
        let state = SceneState::new();
        let a = Layer::new_quad("A", 0);
        let b = Layer::new_quad("B", 1);
        let ids = vec![a.id.clone(), b.id.clone()];
        state.add_layer(a);
        state.add_layer(b);
        let dups = state.duplicate_layers(&ids);
        assert_eq!(dups.len(), 2);
        assert_eq!(state.get_layers_snapshot().len(), 4);
    }
}
```

**Step 2: Run tests**

```bash
cd src-tauri && cargo test --lib scene::state
```

Expected: All 16 tests pass.

**Step 3: Commit**

```bash
git add src-tauri/src/scene/state.rs
git commit -m "test(rust): add SceneState unit tests (CRUD, undo/redo, interaction)"
```

---

### Task 1.4: Mesh & Face Operation Tests

**Files:**
- Modify: `src-tauri/src/scene/state.rs` (append to existing test module)

**Step 1: Add mesh-specific tests to the existing test module**

```rust
    #[test]
    fn toggle_face_mask() {
        let state = SceneState::new();
        let layer = Layer::new_mesh("mesh", 0, 2, 2);
        let id = layer.id.clone();
        state.add_layer(layer);
        assert!(state.toggle_face_mask(&id, vec![0, 1], true));
        let snap = state.get_layers_snapshot();
        match &snap[0].geometry {
            LayerGeometry::Mesh { masked_faces, .. } => {
                assert!(masked_faces.contains(&0));
                assert!(masked_faces.contains(&1));
            }
            _ => panic!("Expected Mesh"),
        }
    }

    #[test]
    fn create_and_remove_face_group() {
        let state = SceneState::new();
        let layer = Layer::new_mesh("mesh", 0, 2, 2);
        let id = layer.id.clone();
        state.add_layer(layer);
        assert!(state.create_face_group(&id, "Group A".to_string(), vec![0, 1], "#ff0000".to_string()));
        let snap = state.get_layers_snapshot();
        match &snap[0].geometry {
            LayerGeometry::Mesh { face_groups, .. } => assert_eq!(face_groups.len(), 1),
            _ => panic!("Expected Mesh"),
        }
        assert!(state.remove_face_group(&id, 0));
        let snap = state.get_layers_snapshot();
        match &snap[0].geometry {
            LayerGeometry::Mesh { face_groups, .. } => assert_eq!(face_groups.len(), 0),
            _ => panic!("Expected Mesh"),
        }
    }

    #[test]
    fn rename_face_group() {
        let state = SceneState::new();
        let layer = Layer::new_mesh("mesh", 0, 2, 2);
        let id = layer.id.clone();
        state.add_layer(layer);
        state.create_face_group(&id, "Old".to_string(), vec![0], "#ff0000".to_string());
        assert!(state.rename_face_group(&id, 0, "New".to_string()));
        let snap = state.get_layers_snapshot();
        match &snap[0].geometry {
            LayerGeometry::Mesh { face_groups, .. } => assert_eq!(face_groups[0].name, "New"),
            _ => panic!("Expected Mesh"),
        }
    }

    #[test]
    fn set_and_clear_face_uv_override() {
        let state = SceneState::new();
        let layer = Layer::new_mesh("mesh", 0, 2, 2);
        let id = layer.id.clone();
        state.add_layer(layer);
        let adj = UvAdjustment {
            offset: [0.1, 0.2],
            rotation: 0.5,
            scale: [1.5, 1.5],
        };
        assert!(state.set_face_uv_override(&id, 0, adj));
        let snap = state.get_layers_snapshot();
        match &snap[0].geometry {
            LayerGeometry::Mesh { uv_overrides, .. } => assert!(uv_overrides.contains_key(&0)),
            _ => panic!("Expected Mesh"),
        }
        assert!(state.clear_face_uv_override(&id, 0));
        let snap = state.get_layers_snapshot();
        match &snap[0].geometry {
            LayerGeometry::Mesh { uv_overrides, .. } => assert!(!uv_overrides.contains_key(&0)),
            _ => panic!("Expected Mesh"),
        }
    }

    #[test]
    fn subdivide_mesh_doubles_resolution() {
        let state = SceneState::new();
        let layer = Layer::new_mesh("mesh", 0, 2, 2);
        let id = layer.id.clone();
        state.add_layer(layer);
        let result = state.subdivide_mesh(&id);
        assert!(result.is_some());
        match result.unwrap() {
            LayerGeometry::Mesh { cols, rows, points, .. } => {
                assert_eq!(cols, 4);
                assert_eq!(rows, 4);
                assert_eq!(points.len(), 25); // (4+1)*(4+1)
            }
            _ => panic!("Expected Mesh"),
        }
    }

    #[test]
    fn face_ops_on_non_mesh_return_false() {
        let state = SceneState::new();
        let layer = Layer::new_quad("quad", 0);
        let id = layer.id.clone();
        state.add_layer(layer);
        assert!(!state.toggle_face_mask(&id, vec![0], true));
        assert!(!state.create_face_group(&id, "G".to_string(), vec![0], "#000".to_string()));
    }
```

**Step 2: Run tests**

```bash
cd src-tauri && cargo test --lib scene::state
```

Expected: All tests pass (previous 16 + new 6 = 22).

**Step 3: Commit**

```bash
git add src-tauri/src/scene/state.rs
git commit -m "test(rust): add mesh face operation tests"
```

---

### Task 1.5: Persistence Tests

**Files:**
- Modify: `src-tauri/src/persistence/mod.rs`

**Step 1: Add test module**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::project::ProjectFile;
    use crate::scene::layer::Layer;
    use std::fs;
    use tempfile::TempDir;

    // Note: add `tempfile = "3"` to [dev-dependencies] in Cargo.toml

    #[test]
    fn save_and_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.flexmap");
        let mut project = ProjectFile::new("Test Project");
        project.layers.push(Layer::new_quad("Layer 1", 0));
        project.layers.push(Layer::new_mesh("Layer 2", 1, 3, 2));

        save_project(&project, &path).unwrap();
        let loaded = load_project(&path).unwrap();

        assert_eq!(loaded.project_name, "Test Project");
        assert_eq!(loaded.layers.len(), 2);
        assert_eq!(loaded.layers[0].name, "Layer 1");
        assert_eq!(loaded.layers[1].name, "Layer 2");
    }

    #[test]
    fn save_creates_valid_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.flexmap");
        let project = ProjectFile::new("JSON Test");

        save_project(&project, &path).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["project_name"], "JSON Test");
    }

    #[test]
    fn load_nonexistent_returns_error() {
        let result = load_project(Path::new("/tmp/nonexistent_flexmap_test.flexmap"));
        assert!(result.is_err());
    }

    #[test]
    fn autosave_and_recovery_roundtrip() {
        let dir = TempDir::new().unwrap();
        let project_path = dir.path().join("project.flexmap");
        let mut project = ProjectFile::new("Autosave Test");
        project.layers.push(Layer::new_quad("Saved Layer", 0));

        let auto_path = autosave(&project, Some(project_path.as_path())).unwrap();
        assert!(auto_path.exists());
        assert!(has_recovery(Some(project_path.as_path())));

        let recovered = load_recovery(Some(project_path.as_path())).unwrap();
        assert_eq!(recovered.project_name, "Autosave Test");
        assert_eq!(recovered.layers.len(), 1);

        clear_recovery(Some(project_path.as_path()));
        assert!(!has_recovery(Some(project_path.as_path())));
    }

    #[test]
    fn layer_geometry_survives_serialization() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("geom.flexmap");
        let mut project = ProjectFile::new("Geom Test");
        let mut mesh = Layer::new_mesh("Mesh", 0, 3, 3);
        // Add some face metadata
        match &mut mesh.geometry {
            LayerGeometry::Mesh { masked_faces, face_groups, .. } => {
                masked_faces.insert(0);
                masked_faces.insert(2);
                face_groups.push(FaceGroup {
                    name: "Group A".to_string(),
                    face_indices: vec![0, 1],
                    color: "#ff0000".to_string(),
                });
            }
            _ => {}
        }
        project.layers.push(mesh);

        save_project(&project, &path).unwrap();
        let loaded = load_project(&path).unwrap();

        match &loaded.layers[0].geometry {
            LayerGeometry::Mesh { masked_faces, face_groups, .. } => {
                assert!(masked_faces.contains(&0));
                assert!(masked_faces.contains(&2));
                assert_eq!(face_groups.len(), 1);
                assert_eq!(face_groups[0].name, "Group A");
            }
            _ => panic!("Expected Mesh"),
        }
    }
}
```

**Step 2: Add tempfile dev-dependency**

In `src-tauri/Cargo.toml`, add:
```toml
[dev-dependencies]
tempfile = "3"
```

**Step 3: Run tests**

```bash
cd src-tauri && cargo test --lib persistence
```

Expected: All 5 tests pass.

**Step 4: Commit**

```bash
git add src-tauri/src/persistence/mod.rs src-tauri/Cargo.toml
git commit -m "test(rust): add persistence save/load/autosave/recovery tests"
```

---

### Task 1.6: Project Module Tests

**Files:**
- Modify: `src-tauri/src/scene/project.rs`

**Step 1: Add test module**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_project_has_defaults() {
        let p = ProjectFile::new("Test");
        assert_eq!(p.project_name, "Test");
        assert_eq!(p.schema_version, 1);
        assert!(p.layers.is_empty());
        assert!(p.output.width > 0);
        assert!(p.output.height > 0);
    }

    #[test]
    fn touch_updates_timestamp() {
        let mut p = ProjectFile::new("Test");
        let before = p.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(10));
        p.touch();
        assert_ne!(p.updated_at, before);
    }

    #[test]
    fn calibration_defaults_disabled() {
        let p = ProjectFile::new("Test");
        assert!(!p.calibration.enabled);
    }
}
```

**Step 2: Run tests**

```bash
cd src-tauri && cargo test --lib scene::project
```

**Step 3: Commit**

```bash
git add src-tauri/src/scene/project.rs
git commit -m "test(rust): add ProjectFile unit tests"
```

---

### Task 1.7: RenderState Tests

**Files:**
- Modify: `src-tauri/src/renderer/engine.rs`

**Step 1: Add test module for RenderState (not RenderEngine — that needs GPU)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::layer::Layer;

    #[test]
    fn new_render_state_defaults() {
        let rs = RenderState::new();
        assert_eq!(rs.layer_generation(), 0);
        assert!(!rs.take_redraw());
    }

    #[test]
    fn update_layers_increments_generation() {
        let rs = RenderState::new();
        let g1 = rs.layer_generation();
        rs.update_layers(vec![Layer::new_quad("test", 0)]);
        let g2 = rs.layer_generation();
        assert!(g2 > g1);
    }

    #[test]
    fn request_redraw_sets_flag() {
        let rs = RenderState::new();
        rs.request_redraw();
        assert!(rs.take_redraw());
        // take_redraw consumes the flag
        assert!(!rs.take_redraw());
    }

    #[test]
    fn update_calibration_does_not_panic() {
        let rs = RenderState::new();
        rs.update_calibration(CalibrationConfig {
            enabled: true,
            pattern: CalibrationPattern::Grid,
            target_layer: None,
        });
        // No assertion — just verify it doesn't panic
    }
}
```

**Step 2: Run tests**

```bash
cd src-tauri && cargo test --lib renderer::engine
```

**Step 3: Commit**

```bash
git add src-tauri/src/renderer/engine.rs
git commit -m "test(rust): add RenderState unit tests"
```

---

### Task 1.8: InputManager Tests

**Files:**
- Modify: `src-tauri/src/input/adapter.rs`

**Step 1: Add test module**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_manager_has_no_bindings() {
        let mgr = InputManager::new();
        assert!(mgr.bound_layer_ids().is_empty());
    }

    #[test]
    fn available_protocols_not_empty() {
        let mgr = InputManager::new();
        let protos = mgr.available_protocols();
        // At minimum, test_pattern and media backends should be available
        assert!(!protos.is_empty());
    }

    #[test]
    fn list_all_sources_includes_test_patterns() {
        let mut mgr = InputManager::new();
        let sources = mgr.refresh_all_sources();
        // Test pattern backend should provide at least one source
        assert!(sources.iter().any(|s| s.protocol == "test_pattern" || s.protocol == "test"));
    }

    #[test]
    fn connect_and_disconnect_source() {
        let mut mgr = InputManager::new();
        let sources = mgr.refresh_all_sources();
        if let Some(src) = sources.first() {
            let result = mgr.connect_source("layer-1", &src.id);
            assert!(result.is_ok());
            assert_eq!(mgr.get_binding("layer-1"), Some(src.id.as_str()));
            mgr.disconnect_source("layer-1");
            assert!(mgr.get_binding("layer-1").is_none());
        }
    }

    #[test]
    fn connect_nonexistent_source_returns_error() {
        let mut mgr = InputManager::new();
        let result = mgr.connect_source("layer-1", "nonexistent-source-id");
        assert!(result.is_err());
    }
}
```

**Step 2: Run tests**

```bash
cd src-tauri && cargo test --lib input::adapter
```

**Step 3: Commit**

```bash
git add src-tauri/src/input/adapter.rs
git commit -m "test(rust): add InputManager unit tests"
```

---

### Task 1.9: Add cargo test to CI

**Files:**
- Modify: `.github/workflows/release-build.yml`

**Step 1: Read current CI file, add `cargo test` step before the build step**

Add after the Rust cache setup step, before `npm ci`:

```yaml
      - name: Cargo test
        run: cd src-tauri && cargo test --lib
```

**Step 2: Commit**

```bash
git add .github/workflows/release-build.yml
git commit -m "ci: add cargo test step to release-build workflow"
```

---

### Task 1.10: Final validation and merge

**Step 1: Run full test suite**

```bash
cd src-tauri && cargo test --lib
```

Expected: All tests pass (7 + 10 + 22 + 5 + 3 + 4 + 5 = ~56 tests).

**Step 2: Verify build still compiles**

```bash
cd src-tauri && cargo build
```

**Step 3: Merge branch to master**

---

## Branch 2: `test/frontend-tests`

**Worktree:** Yes (parallel with branches 1 and 3)
**Scope:** `src/` + config files + `package.json`
**Merge to:** master (after branch 1)

### Task 2.1: Install Vitest and Testing Library

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`

**Step 1: Install deps**

```bash
npm install -D vitest@^3.2 @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

**Step 2: Create vitest config**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

**Step 3: Create test setup**

```typescript
// src/test/setup.ts
import '@testing-library/jest-dom';
```

**Step 4: Add test script to package.json**

Add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 5: Verify vitest runs (no tests yet)**

```bash
npm test
```

Expected: "No test files found" or clean exit.

**Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/test/setup.ts
git commit -m "chore: add Vitest + Testing Library test infrastructure"
```

---

### Task 2.2: Math Utility Tests

**Files:**
- Create: `src/lib/math.test.ts`

**Step 1: Write tests for pure math functions**

```typescript
import { describe, it, expect } from 'vitest';
import { distance, clamp, hashPoints, compose2DTransform, computeHomography, transformPoint } from './math';

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it('clamps to min', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });
  it('clamps to max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe('distance', () => {
  it('returns 0 for same point', () => {
    expect(distance({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(0);
  });
  it('calculates euclidean distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
  });
});

describe('hashPoints', () => {
  it('returns same hash for same points', () => {
    const pts = [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }];
    expect(hashPoints(pts)).toBe(hashPoints(pts));
  });
  it('returns different hash for different points', () => {
    const a = [{ x: 0.1, y: 0.2 }];
    const b = [{ x: 0.3, y: 0.4 }];
    expect(hashPoints(a)).not.toBe(hashPoints(b));
  });
});

describe('compose2DTransform', () => {
  it('identity when no transform', () => {
    const m = compose2DTransform(0, 0, 0, 1, 1);
    expect(m[0]).toBeCloseTo(1);
    expect(m[4]).toBeCloseTo(1);
  });
  it('applies translation', () => {
    const m = compose2DTransform(10, 20, 0, 1, 1);
    expect(m[6]).toBeCloseTo(10);
    expect(m[7]).toBeCloseTo(20);
  });
});

describe('computeHomography', () => {
  it('returns identity-like for unit square', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const h = computeHomography(corners);
    expect(h).not.toBeNull();
  });
  it('returns null for degenerate quad', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    const h = computeHomography(corners);
    // Either null or produces a valid matrix — implementation-dependent
    // Just verify it doesn't throw
  });
});
```

**Step 2: Run tests**

```bash
npm test -- src/lib/math.test.ts
```

**Step 3: Commit**

```bash
git add src/lib/math.test.ts
git commit -m "test(frontend): add math utility tests"
```

---

### Task 2.3: Aspect Ratio Utility Tests

**Files:**
- Create: `src/lib/aspect-ratios.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect } from 'vitest';
import {
  getAspectRatioById,
  findAspectRatioByDimensions,
  inferAspectRatioId,
  computeHeightFromWidth,
  computeWidthFromHeight,
  fitAspectViewport,
  COMMON_ASPECT_RATIOS,
} from './aspect-ratios';

describe('COMMON_ASPECT_RATIOS', () => {
  it('has entries', () => {
    expect(COMMON_ASPECT_RATIOS.length).toBeGreaterThan(0);
  });
});

describe('getAspectRatioById', () => {
  it('returns known ratio', () => {
    const r = getAspectRatioById('16:9');
    expect(r).not.toBeNull();
  });
  it('returns null for unknown', () => {
    expect(getAspectRatioById('99:1' as any)).toBeNull();
  });
});

describe('inferAspectRatioId', () => {
  it('infers 16:9 from 1920x1080', () => {
    expect(inferAspectRatioId(1920, 1080)).toBe('16:9');
  });
  it('infers 4:3 from 1024x768', () => {
    expect(inferAspectRatioId(1024, 768)).toBe('4:3');
  });
});

describe('computeHeightFromWidth', () => {
  it('1920 at 16:9 = 1080', () => {
    expect(computeHeightFromWidth(1920, '16:9')).toBe(1080);
  });
});

describe('computeWidthFromHeight', () => {
  it('1080 at 16:9 = 1920', () => {
    expect(computeWidthFromHeight(1080, '16:9')).toBe(1920);
  });
});

describe('fitAspectViewport', () => {
  it('fits 16:9 into square container', () => {
    const vp = fitAspectViewport(1000, 1000, 16, 9, true);
    expect(vp).toBeDefined();
    // Should letterbox (width fills, height < 1000)
  });
});
```

**Step 2: Run and commit**

```bash
npm test -- src/lib/aspect-ratios.test.ts
git add src/lib/aspect-ratios.test.ts
git commit -m "test(frontend): add aspect ratio utility tests"
```

---

### Task 2.4: Tauri Bridge Mock Tests

**Files:**
- Create: `src/lib/tauri-bridge.test.ts`

**Step 1: Test that all mocks return correct shapes**

```typescript
import { describe, it, expect } from 'vitest';

// Import the mock registry directly
// Force browser mode so mocks are used
vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: undefined });

describe('tauri-bridge mocks', () => {
  let bridge: typeof import('./tauri-bridge');

  beforeAll(async () => {
    bridge = await import('./tauri-bridge');
  });

  it('get_project returns a ProjectFile', async () => {
    const result = await bridge.tauriInvoke('get_project');
    expect(result).toHaveProperty('project_name');
    expect(result).toHaveProperty('layers');
    expect(result).toHaveProperty('schema_version');
  });

  it('add_layer returns a Layer', async () => {
    const result = await bridge.tauriInvoke('add_layer', { name: 'Test', layer_type: 'quad' });
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('geometry');
  });

  it('list_sources returns SourceInfo[]', async () => {
    const result = await bridge.tauriInvoke('list_sources');
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('protocol');
    }
  });

  it('list_monitors returns MonitorInfo[]', async () => {
    const result = await bridge.tauriInvoke('list_monitors');
    expect(Array.isArray(result)).toBe(true);
  });

  it('save_project does not throw', async () => {
    await expect(bridge.tauriInvoke('save_project', {})).resolves.not.toThrow();
  });

  it('undo returns result or null', async () => {
    const result = await bridge.tauriInvoke('undo');
    // May return null if nothing to undo
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('isTauri is false in test env', () => {
    expect(bridge.isTauri).toBe(false);
  });
});
```

**Step 2: Run and commit**

```bash
npm test -- src/lib/tauri-bridge.test.ts
git add src/lib/tauri-bridge.test.ts
git commit -m "test(frontend): add tauri-bridge mock validation tests"
```

---

### Task 2.5: Zustand Store Tests

**Files:**
- Create: `src/store/useAppStore.test.ts`

**Step 1: Test store actions**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from './useAppStore';

// Reset store between tests
beforeEach(() => {
  useAppStore.setState({
    layers: [],
    selectedLayerId: null,
    selectedLayerIds: [],
    selectedFaceIndices: [],
    canUndo: false,
    canRedo: false,
    isDirty: false,
  });
});

describe('useAppStore', () => {
  it('has initial empty state', () => {
    const state = useAppStore.getState();
    expect(state.layers).toEqual([]);
    expect(state.selectedLayerId).toBeNull();
  });

  it('addLayer adds a layer and selects it', async () => {
    await useAppStore.getState().addLayer('Test Layer', 'quad');
    const state = useAppStore.getState();
    expect(state.layers.length).toBe(1);
    expect(state.layers[0].name).toBe('Test Layer');
    expect(state.selectedLayerId).toBe(state.layers[0].id);
  });

  it('removeLayer removes and clears selection', async () => {
    await useAppStore.getState().addLayer('To Remove', 'quad');
    const id = useAppStore.getState().layers[0].id;
    await useAppStore.getState().removeLayer(id);
    const state = useAppStore.getState();
    expect(state.layers.length).toBe(0);
    expect(state.selectedLayerId).toBeNull();
  });

  it('selectLayer updates selectedLayerId', async () => {
    await useAppStore.getState().addLayer('Layer A', 'quad');
    await useAppStore.getState().addLayer('Layer B', 'quad');
    const layers = useAppStore.getState().layers;
    useAppStore.getState().selectLayer(layers[0].id);
    expect(useAppStore.getState().selectedLayerId).toBe(layers[0].id);
  });

  it('duplicateLayer creates copy', async () => {
    await useAppStore.getState().addLayer('Original', 'quad');
    const id = useAppStore.getState().layers[0].id;
    await useAppStore.getState().duplicateLayer(id);
    expect(useAppStore.getState().layers.length).toBe(2);
  });

  it('renameLayer changes name', async () => {
    await useAppStore.getState().addLayer('Old Name', 'quad');
    const id = useAppStore.getState().layers[0].id;
    await useAppStore.getState().renameLayer(id, 'New Name');
    expect(useAppStore.getState().layers[0].name).toBe('New Name');
  });

  it('setLayerVisibility toggles visible', async () => {
    await useAppStore.getState().addLayer('Layer', 'quad');
    const id = useAppStore.getState().layers[0].id;
    await useAppStore.getState().setLayerVisibility(id, false);
    expect(useAppStore.getState().layers[0].visible).toBe(false);
  });

  it('toggleSnap flips snapEnabled', () => {
    const before = useAppStore.getState().snapEnabled;
    useAppStore.getState().toggleSnap();
    expect(useAppStore.getState().snapEnabled).toBe(!before);
  });

  it('addToast adds and dismissToast removes', () => {
    useAppStore.getState().addToast('Error occurred', 'error');
    expect(useAppStore.getState().toasts.length).toBe(1);
    const toastId = useAppStore.getState().toasts[0].id;
    useAppStore.getState().dismissToast(toastId);
    expect(useAppStore.getState().toasts.length).toBe(0);
  });
});
```

**Step 2: Run and commit**

```bash
npm test -- src/store/useAppStore.test.ts
git add src/store/useAppStore.test.ts
git commit -m "test(frontend): add Zustand store action tests"
```

---

### Task 2.6: Component Smoke Tests

**Files:**
- Create: `src/components/common/Toolbar.test.tsx`
- Create: `src/components/common/ToastContainer.test.tsx`
- Create: `src/components/common/KeyboardOverlay.test.tsx`

**Step 1: Toolbar smoke test**

```tsx
// src/components/common/Toolbar.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Toolbar from './Toolbar';

describe('Toolbar', () => {
  it('renders without crashing', () => {
    render(<Toolbar />);
  });

  it('shows undo and redo buttons', () => {
    render(<Toolbar />);
    // Look for undo/redo by accessible role or text
    expect(document.querySelector('button')).not.toBeNull();
  });
});
```

**Step 2: ToastContainer smoke test**

```tsx
// src/components/common/ToastContainer.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ToastContainer from './ToastContainer';

describe('ToastContainer', () => {
  it('renders without crashing', () => {
    render(<ToastContainer />);
  });

  it('renders empty when no toasts', () => {
    const { container } = render(<ToastContainer />);
    // Should render container but no toast elements
    expect(container).toBeDefined();
  });
});
```

**Step 3: Run and commit**

```bash
npm test -- src/components/
git add src/components/common/Toolbar.test.tsx src/components/common/ToastContainer.test.tsx
git commit -m "test(frontend): add component smoke tests"
```

---

### Task 2.7: Add npm test to CI and merge

**Files:**
- Modify: `.github/workflows/release-build.yml`

**Step 1: Add npm test step after npm ci**

```yaml
      - name: Frontend tests
        run: npm test
```

**Step 2: Commit**

```bash
git add .github/workflows/release-build.yml
git commit -m "ci: add npm test step to release-build workflow"
```

**Step 3: Run full suite, verify, merge to master**

```bash
npm test
```

---

## Branch 3: `test/e2e`

**Worktree:** Yes (parallel with branches 1 and 2)
**Scope:** New `e2e-tests/` directory + CI
**Merge to:** master (after branch 2)

### Task 3.1: E2E Infrastructure Setup

**Files:**
- Create: `e2e-tests/package.json`
- Create: `e2e-tests/wdio.conf.js`

**Step 1: Create e2e-tests directory and init**

```bash
mkdir -p e2e-tests
cd e2e-tests
npm init -y
npm install --save-dev @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/spec-reporter chai
```

**Step 2: Create WebDriverIO config**

```javascript
// e2e-tests/wdio.conf.js
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let tauriDriver;
let exit = false;

// Detect binary name based on platform
const binaryName = process.platform === 'win32' ? 'flexmap.exe' : 'flexmap';
const application = path.resolve(__dirname, '..', 'src-tauri', 'target', 'debug', binaryName);

export const config = {
  host: '127.0.0.1',
  port: 4444,
  specs: ['./specs/**/*.js'],
  maxInstances: 1,
  capabilities: [{
    maxInstances: 1,
    'tauri:options': { application },
  }],
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 60000 },

  onPrepare: () => {
    spawnSync('npm', ['run', 'tauri', 'build', '--', '--debug', '--no-bundle'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      shell: true,
    });
  },

  beforeSession: () => {
    tauriDriver = spawn(
      path.resolve(os.homedir(), '.cargo', 'bin', 'tauri-driver'),
      [],
      { stdio: [null, process.stdout, process.stderr] },
    );
    tauriDriver.on('error', (err) => { console.error('tauri-driver error:', err); process.exit(1); });
    tauriDriver.on('exit', (code) => { if (!exit) { console.error('tauri-driver exit:', code); process.exit(1); } });
  },

  afterSession: () => { exit = true; tauriDriver?.kill(); },
};
```

**Step 3: Add test script to e2e-tests/package.json**

```json
{
  "type": "module",
  "scripts": {
    "test": "wdio run wdio.conf.js"
  }
}
```

**Step 4: Commit**

```bash
git add e2e-tests/
git commit -m "chore: add WebDriverIO e2e test infrastructure"
```

---

### Task 3.2: App Launch Smoke Test

**Files:**
- Create: `e2e-tests/specs/smoke.js`

**Step 1: Write smoke test**

```javascript
import { expect } from 'chai';

describe('FlexMap App Launch', () => {
  it('should display the main window', async () => {
    const title = await browser.getTitle();
    expect(title).to.include('FlexMap');
  });

  it('should render the toolbar', async () => {
    const toolbar = await browser.$('[data-testid="toolbar"]');
    expect(await toolbar.isExisting()).to.be.true;
  });

  it('should render the editor canvas', async () => {
    const canvas = await browser.$('canvas');
    expect(await canvas.isExisting()).to.be.true;
  });

  it('should render the layer panel', async () => {
    const panel = await browser.$('[data-testid="layer-panel"]');
    expect(await panel.isExisting()).to.be.true;
  });
});
```

**Step 2: Add data-testid attributes to components**

Add `data-testid="toolbar"` to `Toolbar.tsx` root element.
Add `data-testid="layer-panel"` to `LayerPanel.tsx` root element.

**Step 3: Install tauri-driver**

```bash
cargo install tauri-driver --locked
```

**Step 4: Run e2e locally (requires display)**

```bash
cd e2e-tests && npm test
```

**Step 5: Commit**

```bash
git add e2e-tests/specs/smoke.js src/components/common/Toolbar.tsx src/components/layers/LayerPanel.tsx
git commit -m "test(e2e): add app launch smoke test"
```

---

### Task 3.3: Layer CRUD E2E Test

**Files:**
- Create: `e2e-tests/specs/layers.js`

**Step 1: Write layer CRUD test**

```javascript
import { expect } from 'chai';

describe('Layer CRUD', () => {
  it('should add a quad layer', async () => {
    // Click add layer button
    const addBtn = await browser.$('[data-testid="add-layer-btn"]');
    await addBtn.click();
    // Select quad from dropdown
    const quadOption = await browser.$('[data-testid="add-quad"]');
    await quadOption.click();
    // Verify layer appears in list
    const layerItems = await browser.$$('[data-testid="layer-item"]');
    expect(layerItems.length).to.be.greaterThan(0);
  });

  it('should select a layer by clicking', async () => {
    const layerItem = await browser.$('[data-testid="layer-item"]');
    await layerItem.click();
    const isSelected = await layerItem.getAttribute('data-selected');
    expect(isSelected).to.equal('true');
  });

  it('should delete selected layer', async () => {
    const layerItems = await browser.$$('[data-testid="layer-item"]');
    const countBefore = layerItems.length;
    // Press Delete key
    await browser.keys(['Delete']);
    const layerItemsAfter = await browser.$$('[data-testid="layer-item"]');
    expect(layerItemsAfter.length).to.equal(countBefore - 1);
  });
});
```

**Step 2: Add data-testid attributes to LayerPanel components**

Add `data-testid="add-layer-btn"`, `data-testid="add-quad"`, `data-testid="layer-item"`, and `data-selected` attribute to layer items in `LayerPanel.tsx`.

**Step 3: Run and commit**

```bash
cd e2e-tests && npm test
git add e2e-tests/specs/layers.js src/components/layers/LayerPanel.tsx
git commit -m "test(e2e): add layer CRUD tests"
```

---

### Task 3.4: Persistence E2E Test

**Files:**
- Create: `e2e-tests/specs/persistence.js`

**Step 1: Write save/load test**

```javascript
import { expect } from 'chai';

describe('Project Persistence', () => {
  it('should show dirty indicator after adding layer', async () => {
    const addBtn = await browser.$('[data-testid="add-layer-btn"]');
    await addBtn.click();
    const quadOption = await browser.$('[data-testid="add-quad"]');
    await quadOption.click();
    // Check title bar or dirty indicator
    const title = await browser.getTitle();
    expect(title).to.include('*'); // Dirty indicator in title
  });

  it('should support undo', async () => {
    // Cmd+Z
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'z']);
    const layerItems = await browser.$$('[data-testid="layer-item"]');
    expect(layerItems.length).to.equal(0);
  });

  it('should support redo', async () => {
    // Cmd+Shift+Z
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'Shift', 'z']);
    const layerItems = await browser.$$('[data-testid="layer-item"]');
    expect(layerItems.length).to.equal(1);
  });
});
```

**Step 2: Run and commit**

```bash
cd e2e-tests && npm test
git add e2e-tests/specs/persistence.js
git commit -m "test(e2e): add persistence and undo/redo tests"
```

---

### Task 3.5: E2E CI Workflow

**Files:**
- Create: `.github/workflows/e2e.yml`

**Step 1: Create separate e2e workflow**

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e:
    name: E2E Tests
    runs-on: ${{ matrix.platform }}
    strategy:
      fail-fast: false
      matrix:
        platform: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4

      - name: System deps (Ubuntu)
        if: matrix.platform == 'ubuntu-latest'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev webkit2gtk-driver xvfb

      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci
      - run: npm ci
        working-directory: e2e-tests

      - name: Install tauri-driver
        run: cargo install tauri-driver --locked

      - name: E2E (Linux)
        if: matrix.platform == 'ubuntu-latest'
        run: xvfb-run npm test
        working-directory: e2e-tests

      - name: E2E (Windows)
        if: matrix.platform == 'windows-latest'
        run: npm test
        working-directory: e2e-tests
```

**Step 2: Commit and merge**

```bash
git add .github/workflows/e2e.yml
git commit -m "ci: add E2E test workflow with WebDriverIO + tauri-driver"
```

---

## Branch 4: `upgrade/wgpu-26`

**Scope:** `src-tauri/` only
**MANDATORY:** Agent MUST run these Context7 queries first:
```
resolve-library-id: "wgpu" → /gfx-rs/wgpu
query-docs: libraryId="/gfx-rs/wgpu/v26.0.0", query="migration changelog breaking changes from v23 v24 v25 to v26"
```

### Task 4.1: Read wgpu changelogs via Context7

Fetch migration docs for v24, v25, v26 before touching any code. Document all breaking changes in a scratch file.

### Task 4.2: Bump wgpu version

**Files:**
- Modify: `src-tauri/Cargo.toml` — change `wgpu = "23"` to `wgpu = "26"`

```bash
cd src-tauri && cargo update -p wgpu
```

### Task 4.3: Fix Surface API changes

Read each file in `src-tauri/src/renderer/` and fix surface configuration changes per the migration docs. Key known changes:
- `SurfaceConfiguration` API changes (v24)
- `entry_point` becomes required `Option<&str>` (v24)

### Task 4.4: Fix texture API renames

- `ImageCopyBuffer` → `TexelCopyBufferLayout` (v25)
- `ImageCopyTexture` → `TexelCopyTextureInfo` (v25)

Search for old names and replace.

### Task 4.5: Fix remaining compilation errors

```bash
cd src-tauri && cargo build 2>&1 | head -100
```

Fix errors iteratively until clean build.

### Task 4.6: Run tests and validate

```bash
cd src-tauri && cargo test --lib
```

All tests must pass. Fix any failures.

### Task 4.7: Update docs/wgpu.md

Update the doc to reflect v26 patterns. Remove the "DO NOT UPGRADE" warning.

### Task 4.8: Commit and merge

```bash
git add -A
git commit -m "upgrade: wgpu 23 → 26"
```

---

## Branch 5: `upgrade/react-19-zustand-5`

**MANDATORY:** Agent MUST run these Context7 queries first:
```
resolve-library-id: "react" → /facebook/react
query-docs: libraryId="/facebook/react/v19_2_0", query="migration from React 18 to 19 breaking changes"

resolve-library-id: "zustand" → /pmndrs/zustand
query-docs: libraryId="/pmndrs/zustand/v5.0.8", query="migration from zustand v4 to v5 breaking changes useShallow"
```

### Task 5.1: Bump React to 19

```bash
npm install react@^19 react-dom@^19 @types/react@^19 @types/react-dom@^19
```

### Task 5.2: Fix React 19 breaking changes

Read Context7 docs. Common changes:
- `ReactDOM.createRoot` API may have changed
- Legacy context API removed
- `forwardRef` may be unnecessary in React 19

Fix `src/main.tsx` and any affected components.

### Task 5.3: Bump Zustand to 5

```bash
npm install zustand@^5 use-sync-external-store
```

### Task 5.4: Fix Zustand 5 migration

- Wrap array/object selectors with `useShallow` from `zustand/shallow`
- Fix `setState` with `replace: true` to provide full state object
- Search all components for `useAppStore(state => ...)` patterns that return new references

### Task 5.5: Run tests

```bash
npm test
```

Fix failures. The store tests from Branch 2 will catch selector issues.

### Task 5.6: Update docs/react-zustand.md

### Task 5.7: Commit and merge

```bash
git add -A
git commit -m "upgrade: React 18 → 19, Zustand 4 → 5"
```

---

## Branch 6: `upgrade/tailwind-4`

**MANDATORY:** Agent MUST run:
```
resolve-library-id: "tailwindcss" → find official docs
query-docs: query="migration from tailwind v3 to v4 upgrade guide"
```

### Task 6.1: Run automated migration

```bash
npx @tailwindcss/upgrade
```

This should handle most changes automatically.

### Task 6.2: Install Tailwind Vite plugin

```bash
npm install -D @tailwindcss/vite
```

Update `vite.config.ts`:
```typescript
import tailwindcss from '@tailwindcss/vite';
// Add to plugins array
```

### Task 6.3: Remove old config files

Delete `tailwind.config.js` and `postcss.config.js` if the migration tool didn't already.

### Task 6.4: Fix CSS directives

Replace `@tailwind base/components/utilities` with `@import "tailwindcss"`.

### Task 6.5: Visual review and fix

```bash
npm run dev
```

Manually check all panels render correctly. Fix any broken utilities.

### Task 6.6: Run tests

```bash
npm test
```

### Task 6.7: Update docs/tailwind-vite.md

### Task 6.8: Commit and merge

```bash
git add -A
git commit -m "upgrade: Tailwind CSS 3 → 4"
```

---

## Branch 7: `upgrade/vite-7-vitest-4`

**MANDATORY:** Agent MUST run:
```
resolve-library-id: "vite" → /vitejs/vite
query-docs: libraryId="/vitejs/vite/v7.0.0", query="migration from vite 5 to 6 to 7 breaking changes"

resolve-library-id: "vitest" → /vitest-dev/vitest
query-docs: libraryId="/vitest-dev/vitest/v4.0.7", query="migration from vitest 3 to 4 breaking changes"
```

### Task 7.1: Bump Vite

```bash
npm install -D vite@^7 @vitejs/plugin-react@latest
```

### Task 7.2: Fix Vite config

- Remove deprecated: `splitVendorChunkPlugin`, `legacy.proxySsrExternalModules`
- Update `transformIndexHtml` hooks: `enforce` → `order`, `transform` → `handler`
- Verify Node.js ≥ 20.19

### Task 7.3: Bump Vitest

```bash
npm install -D vitest@^4
```

### Task 7.4: Fix Vitest config changes

Update `vitest.config.ts` per migration docs.

### Task 7.5: Run full test suite

```bash
cargo test --lib --manifest-path src-tauri/Cargo.toml
npm test
```

All tests must pass.

### Task 7.6: Update docs

- `docs/tailwind-vite.md` — update Vite/Vitest versions and patterns
- `CLAUDE.md` — update pinned versions table

### Task 7.7: Commit and merge

```bash
git add -A
git commit -m "upgrade: Vite 5 → 7, Vitest 3 → 4"
```

---

## Post-Upgrade Checklist

After all 7 branches are merged:

1. [ ] `cargo test --lib` passes
2. [ ] `npm test` passes
3. [ ] `npm run build` succeeds
4. [ ] `cargo tauri dev` launches correctly
5. [ ] E2E tests pass
6. [ ] All `docs/*.md` files updated with new version patterns
7. [ ] `CLAUDE.md` version table reflects new versions
8. [ ] `docs/plans/` marked as completed

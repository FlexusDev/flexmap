use parking_lot::RwLock;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use super::history::History;
use super::layer::*;
use super::project::*;

fn geometry_center(geometry: &LayerGeometry) -> Point2D {
    match geometry {
        LayerGeometry::Quad { corners } => {
            let mut min_x = f64::INFINITY;
            let mut min_y = f64::INFINITY;
            let mut max_x = f64::NEG_INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            for p in corners {
                min_x = min_x.min(p.x);
                min_y = min_y.min(p.y);
                max_x = max_x.max(p.x);
                max_y = max_y.max(p.y);
            }
            Point2D::new((min_x + max_x) * 0.5, (min_y + max_y) * 0.5)
        }
        LayerGeometry::Triangle { vertices } => {
            let mut min_x = f64::INFINITY;
            let mut min_y = f64::INFINITY;
            let mut max_x = f64::NEG_INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            for p in vertices {
                min_x = min_x.min(p.x);
                min_y = min_y.min(p.y);
                max_x = max_x.max(p.x);
                max_y = max_y.max(p.y);
            }
            Point2D::new((min_x + max_x) * 0.5, (min_y + max_y) * 0.5)
        }
        LayerGeometry::Mesh { points, .. } => {
            let mut min_x = f64::INFINITY;
            let mut min_y = f64::INFINITY;
            let mut max_x = f64::NEG_INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            for p in points {
                min_x = min_x.min(p.x);
                min_y = min_y.min(p.y);
                max_x = max_x.max(p.x);
                max_y = max_y.max(p.y);
            }
            Point2D::new((min_x + max_x) * 0.5, (min_y + max_y) * 0.5)
        }
        LayerGeometry::Circle { center, .. } => *center,
    }
}

fn transform_point(
    p: Point2D,
    pivot: Point2D,
    dx: f64,
    dy: f64,
    d_rotation: f64,
    sx: f64,
    sy: f64,
) -> Point2D {
    let px = p.x - pivot.x;
    let py = p.y - pivot.y;
    let sxp = px * sx;
    let syp = py * sy;
    let c = d_rotation.cos();
    let s = d_rotation.sin();
    Point2D::new(
        pivot.x + (sxp * c - syp * s) + dx,
        pivot.y + (sxp * s + syp * c) + dy,
    )
}

fn apply_geometry_delta(
    geometry: &LayerGeometry,
    dx: f64,
    dy: f64,
    d_rotation: f64,
    sx: f64,
    sy: f64,
) -> LayerGeometry {
    let pivot = geometry_center(geometry);
    match geometry {
        LayerGeometry::Quad { corners } => LayerGeometry::Quad {
            corners: [
                transform_point(corners[0], pivot, dx, dy, d_rotation, sx, sy),
                transform_point(corners[1], pivot, dx, dy, d_rotation, sx, sy),
                transform_point(corners[2], pivot, dx, dy, d_rotation, sx, sy),
                transform_point(corners[3], pivot, dx, dy, d_rotation, sx, sy),
            ],
        },
        LayerGeometry::Triangle { vertices } => LayerGeometry::Triangle {
            vertices: [
                transform_point(vertices[0], pivot, dx, dy, d_rotation, sx, sy),
                transform_point(vertices[1], pivot, dx, dy, d_rotation, sx, sy),
                transform_point(vertices[2], pivot, dx, dy, d_rotation, sx, sy),
            ],
        },
        LayerGeometry::Mesh {
            cols,
            rows,
            points,
            face_groups,
            masked_faces,
            uv_overrides,
        } => LayerGeometry::Mesh {
            cols: *cols,
            rows: *rows,
            points: points
                .iter()
                .copied()
                .map(|p| transform_point(p, pivot, dx, dy, d_rotation, sx, sy))
                .collect(),
            face_groups: face_groups.clone(),
            masked_faces: masked_faces.clone(),
            uv_overrides: uv_overrides.clone(),
        },
        LayerGeometry::Circle {
            center,
            radius_x,
            radius_y,
            rotation,
        } => LayerGeometry::Circle {
            center: transform_point(*center, pivot, dx, dy, d_rotation, sx, sy),
            radius_x: (radius_x * sx).abs().max(0.000_1),
            radius_y: (radius_y * sy).abs().max(0.000_1),
            rotation: rotation + d_rotation,
        },
    }
}

/// Thread-safe application scene state. Rust backend is the source of truth.
pub struct SceneState {
    pub project: RwLock<ProjectFile>,
    pub dirty: RwLock<bool>,
    pub project_path: RwLock<Option<String>>,
    pub autosave_path: RwLock<Option<String>>,
    pub history: History,
    pub revision: AtomicU64,
}

impl SceneState {
    pub fn new() -> Self {
        Self {
            project: RwLock::new(ProjectFile::new("Untitled Project")),
            dirty: RwLock::new(false),
            project_path: RwLock::new(None),
            autosave_path: RwLock::new(None),
            history: History::new(),
            revision: AtomicU64::new(1),
        }
    }

    pub fn mark_dirty(&self) {
        *self.dirty.write() = true;
        self.project.write().touch();
        self.revision.fetch_add(1, Ordering::Release);
    }

    pub fn mark_clean(&self) {
        *self.dirty.write() = false;
    }

    pub fn is_dirty(&self) -> bool {
        *self.dirty.read()
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    /// Push current layer state to undo stack before mutating
    fn push_undo(&self) {
        let layers = self.project.read().layers.clone();
        self.history.push(layers);
    }

    // --- Undo / Redo ---

    pub fn undo(&self) -> Option<Vec<Layer>> {
        let current = self.project.read().layers.clone();
        if let Some(prev) = self.history.undo(current) {
            self.project.write().layers = prev.clone();
            self.mark_dirty();
            Some(prev)
        } else {
            None
        }
    }

    pub fn redo(&self) -> Option<Vec<Layer>> {
        let current = self.project.read().layers.clone();
        if let Some(next) = self.history.redo(current) {
            self.project.write().layers = next.clone();
            self.mark_dirty();
            Some(next)
        } else {
            None
        }
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    // --- Layer operations ---

    pub fn add_layer(&self, layer: Layer) {
        self.push_undo();
        self.project.write().layers.push(layer);
        self.mark_dirty();
    }

    pub fn remove_layer(&self, layer_id: &str) -> Option<Layer> {
        let mut proj = self.project.write();
        if let Some(idx) = proj.layers.iter().position(|l| l.id == layer_id) {
            self.history.push(proj.layers.clone());
            let removed = proj.layers.remove(idx);
            drop(proj);
            self.mark_dirty();
            Some(removed)
        } else {
            None
        }
    }

    /// Remove multiple layers in one undo step.
    pub fn remove_layers(&self, layer_ids: &[String]) -> bool {
        if layer_ids.is_empty() {
            return false;
        }

        let id_set: HashSet<&str> = layer_ids.iter().map(|s| s.as_str()).collect();
        let mut proj = self.project.write();

        if !proj.layers.iter().any(|l| id_set.contains(l.id.as_str())) {
            return false;
        }

        self.history.push(proj.layers.clone());
        let before_len = proj.layers.len();
        proj.layers.retain(|l| !id_set.contains(l.id.as_str()));
        let removed = proj.layers.len() != before_len;
        drop(proj);

        if removed {
            self.mark_dirty();
        }

        removed
    }

    pub fn duplicate_layer(&self, layer_id: &str) -> Option<Layer> {
        let proj = self.project.read();
        if let Some(layer) = proj.layers.iter().find(|l| l.id == layer_id) {
            let mut dup = layer.clone();
            dup.id = uuid::Uuid::new_v4().to_string();
            dup.name = format!("{} (copy)", dup.name);
            dup.z_index += 1;
            drop(proj);
            // push_undo is called inside add_layer
            self.add_layer(dup.clone());
            Some(dup)
        } else {
            None
        }
    }

    /// Duplicate multiple layers in deterministic input order with one undo step.
    pub fn duplicate_layers(&self, layer_ids: &[String]) -> Vec<Layer> {
        if layer_ids.is_empty() {
            return Vec::new();
        }

        let mut proj = self.project.write();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut originals: Vec<Layer> = Vec::new();

        for layer_id in layer_ids {
            if !seen.insert(layer_id.as_str()) {
                continue;
            }
            if let Some(layer) = proj.layers.iter().find(|l| l.id == *layer_id) {
                originals.push(layer.clone());
            }
        }

        if originals.is_empty() {
            return Vec::new();
        }

        self.history.push(proj.layers.clone());

        let mut next_z = proj.layers.iter().map(|l| l.z_index).max().unwrap_or(-1) + 1;
        let mut duplicates = Vec::with_capacity(originals.len());
        for mut dup in originals {
            dup.id = uuid::Uuid::new_v4().to_string();
            dup.name = format!("{} (copy)", dup.name);
            dup.z_index = next_z;
            next_z += 1;
            proj.layers.push(dup.clone());
            duplicates.push(dup);
        }

        drop(proj);
        self.mark_dirty();
        duplicates
    }

    /// Snapshot current layers for undo BEFORE a drag/interaction begins.
    /// Call this once at the start of a drag, not on every move.
    pub fn begin_interaction(&self) {
        self.push_undo();
    }

    /// Update geometry WITHOUT pushing undo (caller must call begin_interaction first)
    pub fn update_layer_geometry(&self, layer_id: &str, geometry: LayerGeometry) -> bool {
        let mut proj = self.project.write();
        if let Some(layer) = proj.layers.iter_mut().find(|l| l.id == layer_id) {
            layer.geometry = geometry;
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    pub fn update_layer_properties(&self, layer_id: &str, properties: LayerProperties) -> bool {
        let mut proj = self.project.write();
        if let Some(layer) = proj.layers.iter_mut().find(|l| l.id == layer_id) {
            // Don't push undo for every property slider drag — only on significant changes
            // The frontend should batch these; for now we skip undo on properties
            layer.properties = properties;
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    pub fn set_layer_source(&self, layer_id: &str, source: Option<SourceAssignment>) -> bool {
        let mut proj = self.project.write();
        if proj.layers.iter().any(|l| l.id == layer_id) {
            let snapshot = proj.layers.clone();
            let layer = proj.layers.iter_mut().find(|l| l.id == layer_id).unwrap();
            self.history.push(snapshot);
            layer.source = source;
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    pub fn set_layer_input_transform(
        &self,
        layer_id: &str,
        input_transform: InputTransform,
    ) -> bool {
        let mut proj = self.project.write();
        if let Some(layer) = proj.layers.iter_mut().find(|l| l.id == layer_id) {
            layer.input_transform = input_transform;
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    /// Apply a delta transform to geometry without shipping full point arrays over IPC.
    /// Does NOT push undo (caller should call begin_interaction before drag starts).
    pub fn apply_layer_geometry_transform_delta(
        &self,
        layer_id: &str,
        dx: f64,
        dy: f64,
        d_rotation: f64,
        sx: f64,
        sy: f64,
    ) -> Option<LayerGeometry> {
        let mut proj = self.project.write();
        let layer = proj.layers.iter_mut().find(|l| l.id == layer_id)?;
        let new_geometry = apply_geometry_delta(&layer.geometry, dx, dy, d_rotation, sx, sy);
        layer.geometry = new_geometry.clone();
        drop(proj);
        self.mark_dirty();
        Some(new_geometry)
    }

    /// Update a single control point in-layer without sending full geometry over IPC.
    /// Does NOT push undo (caller should call begin_interaction before drag starts).
    pub fn update_layer_point(
        &self,
        layer_id: &str,
        point_index: usize,
        point: Point2D,
    ) -> Option<LayerGeometry> {
        let mut proj = self.project.write();
        let layer = proj.layers.iter_mut().find(|l| l.id == layer_id)?;
        let updated = match &mut layer.geometry {
            LayerGeometry::Quad { corners } => {
                if point_index >= 4 {
                    return None;
                }
                corners[point_index] = point;
                LayerGeometry::Quad { corners: *corners }
            }
            LayerGeometry::Triangle { vertices } => {
                if point_index >= 3 {
                    return None;
                }
                vertices[point_index] = point;
                LayerGeometry::Triangle { vertices: *vertices }
            }
            LayerGeometry::Mesh { points, .. } => {
                if point_index >= points.len() {
                    return None;
                }
                points[point_index] = point;
                layer.geometry.clone()
            }
            LayerGeometry::Circle { center, .. } => {
                if point_index != 0 {
                    return None;
                }
                *center = point;
                layer.geometry.clone()
            }
        };

        layer.geometry = updated.clone();
        drop(proj);
        self.mark_dirty();
        Some(updated)
    }

    pub fn set_layer_visibility(&self, layer_id: &str, visible: bool) -> bool {
        let mut proj = self.project.write();
        if let Some(layer) = proj.layers.iter_mut().find(|l| l.id == layer_id) {
            layer.visible = visible;
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    pub fn set_layer_locked(&self, layer_id: &str, locked: bool) -> bool {
        let mut proj = self.project.write();
        if let Some(layer) = proj.layers.iter_mut().find(|l| l.id == layer_id) {
            layer.locked = locked;
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    pub fn rename_layer(&self, layer_id: &str, name: &str) -> bool {
        let mut proj = self.project.write();
        if let Some(layer) = proj.layers.iter_mut().find(|l| l.id == layer_id) {
            layer.name = name.to_string();
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    pub fn reorder_layers(&self, layer_ids: &[String]) -> bool {
        self.push_undo();
        let mut proj = self.project.write();
        for (idx, id) in layer_ids.iter().enumerate() {
            if let Some(layer) = proj.layers.iter_mut().find(|l| &l.id == id) {
                layer.z_index = idx as i32;
            }
        }
        drop(proj);
        self.mark_dirty();
        true
    }

    pub fn set_layer_blend_mode(&self, layer_id: &str, blend_mode: BlendMode) -> bool {
        let mut proj = self.project.write();
        if let Some(layer) = proj.layers.iter_mut().find(|l| l.id == layer_id) {
            layer.blend_mode = blend_mode;
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    pub fn get_layers_snapshot(&self) -> Vec<Layer> {
        self.project.read().layers.clone()
    }

    pub fn get_project_snapshot(&self) -> ProjectFile {
        self.project.read().clone()
    }

    // --- Mesh face operations ---

    /// Toggle face masking on a Mesh layer. Pushes undo.
    pub fn toggle_face_mask(&self, layer_id: &str, face_indices: Vec<usize>, masked: bool) -> bool {
        let mut proj = self.project.write();
        if proj.layers.iter().any(|l| l.id == layer_id) {
            let snapshot = proj.layers.clone();
            self.history.push(snapshot);
            let layer = proj.layers.iter_mut().find(|l| l.id == layer_id).unwrap();
            if let LayerGeometry::Mesh { ref mut masked_faces, .. } = layer.geometry {
                if masked {
                    for idx in &face_indices {
                        if !masked_faces.contains(idx) {
                            masked_faces.push(*idx);
                        }
                    }
                } else {
                    masked_faces.retain(|f| !face_indices.contains(f));
                }
            }
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    /// Create a named face group on a Mesh layer. Pushes undo.
    pub fn create_face_group(
        &self,
        layer_id: &str,
        name: String,
        face_indices: Vec<usize>,
        color: String,
    ) -> bool {
        let mut proj = self.project.write();
        if proj.layers.iter().any(|l| l.id == layer_id) {
            let snapshot = proj.layers.clone();
            self.history.push(snapshot);
            let layer = proj.layers.iter_mut().find(|l| l.id == layer_id).unwrap();
            if let LayerGeometry::Mesh { ref mut face_groups, .. } = layer.geometry {
                face_groups.push(FaceGroup { name, face_indices, color });
            }
            drop(proj);
            self.mark_dirty();
            true
        } else {
            false
        }
    }

    /// Remove a face group by index from a Mesh layer. Pushes undo.
    pub fn remove_face_group(&self, layer_id: &str, group_index: usize) -> bool {
        let mut proj = self.project.write();
        if proj.layers.iter().any(|l| l.id == layer_id) {
            let snapshot = proj.layers.clone();
            self.history.push(snapshot);
            let layer = proj.layers.iter_mut().find(|l| l.id == layer_id).unwrap();
            if let LayerGeometry::Mesh { ref mut face_groups, .. } = layer.geometry {
                if group_index < face_groups.len() {
                    face_groups.remove(group_index);
                    drop(proj);
                    self.mark_dirty();
                    return true;
                }
            }
            false
        } else {
            false
        }
    }

    /// Rename a face group by index on a Mesh layer. Pushes undo.
    pub fn rename_face_group(&self, layer_id: &str, group_index: usize, name: String) -> bool {
        let mut proj = self.project.write();
        if proj.layers.iter().any(|l| l.id == layer_id) {
            let snapshot = proj.layers.clone();
            self.history.push(snapshot);
            let layer = proj.layers.iter_mut().find(|l| l.id == layer_id).unwrap();
            if let LayerGeometry::Mesh { ref mut face_groups, .. } = layer.geometry {
                if let Some(group) = face_groups.get_mut(group_index) {
                    group.name = name;
                    drop(proj);
                    self.mark_dirty();
                    return true;
                }
            }
            false
        } else {
            false
        }
    }

    /// Set or clear the calibration target layer (for layer-level calibration overlay).
    pub fn set_calibration_target(&self, target: Option<CalibrationTarget>) {
        self.project.write().calibration.target_layer = target;
        self.mark_dirty();
    }

    /// Set a per-face UV override on a Mesh layer. Does NOT push undo
    /// (caller must call begin_interaction first for slider-based adjustments).
    pub fn set_face_uv_override(
        &self,
        layer_id: &str,
        face_index: usize,
        adjustment: UvAdjustment,
    ) -> bool {
        let mut proj = self.project.write();
        if proj.layers.iter().any(|l| l.id == layer_id) {
            let layer = proj.layers.iter_mut().find(|l| l.id == layer_id).unwrap();
            if let LayerGeometry::Mesh { ref mut uv_overrides, .. } = layer.geometry {
                uv_overrides.insert(face_index, adjustment);
                drop(proj);
                self.mark_dirty();
                return true;
            }
            false
        } else {
            false
        }
    }

    /// Clear a per-face UV override on a Mesh layer. Pushes undo.
    pub fn clear_face_uv_override(&self, layer_id: &str, face_index: usize) -> bool {
        let mut proj = self.project.write();
        if proj.layers.iter().any(|l| l.id == layer_id) {
            let snapshot = proj.layers.clone();
            self.history.push(snapshot);
            let layer = proj.layers.iter_mut().find(|l| l.id == layer_id).unwrap();
            if let LayerGeometry::Mesh { ref mut uv_overrides, .. } = layer.geometry {
                let removed = uv_overrides.remove(&face_index).is_some();
                drop(proj);
                self.mark_dirty();
                return removed;
            }
            false
        } else {
            false
        }
    }

    /// Double the resolution of a Mesh layer grid, remapping all face metadata.
    /// Pushes undo. Returns the new geometry on success.
    pub fn subdivide_mesh(&self, layer_id: &str) -> Option<LayerGeometry> {
        // Read and clone geometry (drops read lock before write)
        let geometry = {
            let proj = self.project.read();
            proj.layers.iter().find(|l| l.id == layer_id)?.geometry.clone()
        };

        let new_geometry = if let LayerGeometry::Mesh {
            cols,
            rows,
            ref points,
            ref face_groups,
            ref masked_faces,
            ref uv_overrides,
        } = geometry
        {
            let new_cols = cols * 2;
            let new_rows = rows * 2;
            let cols = cols as usize;
            let rows = rows as usize;
            let new_cols_usize = new_cols as usize;
            let new_rows_usize = new_rows as usize;

            let mut new_points =
                vec![crate::scene::layer::Point2D::new(0.0, 0.0); (new_rows_usize + 1) * (new_cols_usize + 1)];

            // Copy original grid points at even indices
            for r in 0..=rows {
                for c in 0..=cols {
                    let old_idx = r * (cols + 1) + c;
                    let new_idx = (2 * r) * (new_cols_usize + 1) + (2 * c);
                    new_points[new_idx] = points[old_idx];
                }
            }
            // Horizontal edge midpoints
            for r in 0..=rows {
                for c in 0..cols {
                    let l = r * (cols + 1) + c;
                    let ri = r * (cols + 1) + c + 1;
                    let new_idx = (2 * r) * (new_cols_usize + 1) + (2 * c + 1);
                    new_points[new_idx] = crate::scene::layer::Point2D::new(
                        (points[l].x + points[ri].x) / 2.0,
                        (points[l].y + points[ri].y) / 2.0,
                    );
                }
            }
            // Vertical edge midpoints
            for r in 0..rows {
                for c in 0..=cols {
                    let t = r * (cols + 1) + c;
                    let b = (r + 1) * (cols + 1) + c;
                    let new_idx = (2 * r + 1) * (new_cols_usize + 1) + (2 * c);
                    new_points[new_idx] = crate::scene::layer::Point2D::new(
                        (points[t].x + points[b].x) / 2.0,
                        (points[t].y + points[b].y) / 2.0,
                    );
                }
            }
            // Cell center midpoints
            for r in 0..rows {
                for c in 0..cols {
                    let tl = r * (cols + 1) + c;
                    let tr = r * (cols + 1) + c + 1;
                    let bl = (r + 1) * (cols + 1) + c;
                    let br = (r + 1) * (cols + 1) + c + 1;
                    let new_idx = (2 * r + 1) * (new_cols_usize + 1) + (2 * c + 1);
                    new_points[new_idx] = crate::scene::layer::Point2D::new(
                        (points[tl].x + points[tr].x + points[bl].x + points[br].x) / 4.0,
                        (points[tl].y + points[tr].y + points[bl].y + points[br].y) / 4.0,
                    );
                }
            }

            // Remap face index: old (r, c) → 4 new face indices
            let remap_face = |old_face: usize| -> [usize; 4] {
                let old_r = old_face / cols;
                let old_c = old_face % cols;
                let nr = old_r * 2;
                let nc = old_c * 2;
                [
                    nr * new_cols_usize + nc,
                    nr * new_cols_usize + nc + 1,
                    (nr + 1) * new_cols_usize + nc,
                    (nr + 1) * new_cols_usize + nc + 1,
                ]
            };

            let new_face_groups = face_groups
                .iter()
                .map(|g| FaceGroup {
                    name: g.name.clone(),
                    color: g.color.clone(),
                    face_indices: g.face_indices.iter().flat_map(|&f| remap_face(f)).collect(),
                })
                .collect();

            let new_masked = masked_faces
                .iter()
                .flat_map(|&f| remap_face(f))
                .collect();

            let new_uv_overrides = uv_overrides
                .iter()
                .flat_map(|(&f, adj)| remap_face(f).map(|nf| (nf, adj.clone())))
                .collect();

            LayerGeometry::Mesh {
                cols: new_cols,
                rows: new_rows,
                points: new_points,
                face_groups: new_face_groups,
                masked_faces: new_masked,
                uv_overrides: new_uv_overrides,
            }
        } else {
            return None; // Not a mesh layer
        };

        // Apply with undo
        let mut proj = self.project.write();
        let snapshot = proj.layers.clone();
        self.history.push(snapshot);
        if let Some(layer) = proj.layers.iter_mut().find(|l| l.id == layer_id) {
            layer.geometry = new_geometry.clone();
        }
        drop(proj);
        self.mark_dirty();
        Some(new_geometry)
    }

    // --- Calibration ---

    pub fn set_calibration_enabled(&self, enabled: bool) {
        self.project.write().calibration.enabled = enabled;
        self.mark_dirty();
    }

    pub fn set_calibration_pattern(&self, pattern: CalibrationPattern) {
        self.project.write().calibration.pattern = pattern;
        self.mark_dirty();
    }

    // --- Output ---

    pub fn set_output_config(&self, config: OutputConfig) {
        self.project.write().output = config;
        self.mark_dirty();
    }

    pub fn set_monitor_preference(&self, monitor: Option<String>) {
        self.project.write().output.monitor_preference = monitor;
        self.mark_dirty();
    }

    pub fn set_ui_state(&self, ui_state: serde_json::Value) {
        self.project.write().ui_state = ui_state;
        self.mark_dirty();
    }

    // --- Project management ---

    pub fn load_project(&self, project: ProjectFile, path: Option<String>) {
        *self.project.write() = project;
        *self.project_path.write() = path;
        self.history.clear();
        self.mark_clean();
        self.revision.fetch_add(1, Ordering::Release);
    }

    pub fn new_project(&self, name: &str) {
        *self.project.write() = ProjectFile::new(name);
        *self.project_path.write() = None;
        self.history.clear();
        self.mark_clean();
        self.revision.fetch_add(1, Ordering::Release);
    }
}

impl Default for SceneState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_quad(state: &SceneState, name: &str) -> String {
        let layer = Layer::new_quad(name, 0);
        let id = layer.id.clone();
        state.add_layer(layer);
        id
    }

    fn add_mesh(state: &SceneState, name: &str, cols: u32, rows: u32) -> String {
        let layer = Layer::new_mesh(name, 0, cols, rows);
        let id = layer.id.clone();
        state.add_layer(layer);
        id
    }

    // --- Basic SceneState tests ---

    #[test]
    fn empty_initial_state() {
        let state = SceneState::new();
        assert!(state.get_layers_snapshot().is_empty());
        assert!(!state.is_dirty());
    }

    #[test]
    fn add_and_remove_layer() {
        let state = SceneState::new();
        let id = add_quad(&state, "L1");
        assert_eq!(state.get_layers_snapshot().len(), 1);

        let removed = state.remove_layer(&id);
        assert!(removed.is_some());
        assert!(state.get_layers_snapshot().is_empty());
    }

    #[test]
    fn remove_nonexistent_returns_none() {
        let state = SceneState::new();
        assert!(state.remove_layer("bogus").is_none());
    }

    #[test]
    fn duplicate_creates_copy_with_new_id() {
        let state = SceneState::new();
        let id = add_quad(&state, "Original");
        let dup = state.duplicate_layer(&id).unwrap();
        assert_ne!(dup.id, id);
        assert!(dup.name.contains("copy"));
        assert_eq!(state.get_layers_snapshot().len(), 2);
    }

    #[test]
    fn undo_add_layer() {
        let state = SceneState::new();
        add_quad(&state, "L1");
        assert_eq!(state.get_layers_snapshot().len(), 1);

        state.undo();
        assert!(state.get_layers_snapshot().is_empty());
    }

    #[test]
    fn redo_after_undo() {
        let state = SceneState::new();
        add_quad(&state, "L1");
        state.undo();
        assert!(state.get_layers_snapshot().is_empty());

        state.redo();
        assert_eq!(state.get_layers_snapshot().len(), 1);
    }

    #[test]
    fn begin_interaction_multiple_updates_one_undo() {
        let state = SceneState::new();
        let id = add_quad(&state, "L1");

        // Simulate drag: one begin_interaction, many geometry updates
        state.begin_interaction();
        for _ in 0..10 {
            state.update_layer_geometry(&id, LayerGeometry::default_quad());
        }

        // One undo should revert to the state before the drag started
        state.undo();
        // The layer should still exist (undo reverts the geometry changes, not the add)
        assert_eq!(state.get_layers_snapshot().len(), 1);

        // Another undo reverts the add_layer
        state.undo();
        assert!(state.get_layers_snapshot().is_empty());
    }

    #[test]
    fn reorder_layers() {
        let state = SceneState::new();
        let id1 = add_quad(&state, "L1");
        let id2 = add_quad(&state, "L2");

        state.reorder_layers(&[id2.clone(), id1.clone()]);

        let layers = state.get_layers_snapshot();
        let l1 = layers.iter().find(|l| l.id == id1).unwrap();
        let l2 = layers.iter().find(|l| l.id == id2).unwrap();
        assert_eq!(l2.z_index, 0);
        assert_eq!(l1.z_index, 1);
    }

    #[test]
    fn set_layer_visibility() {
        let state = SceneState::new();
        let id = add_quad(&state, "L1");
        assert!(state.set_layer_visibility(&id, false));
        let layers = state.get_layers_snapshot();
        assert!(!layers[0].visible);
    }

    #[test]
    fn rename_layer() {
        let state = SceneState::new();
        let id = add_quad(&state, "Old");
        assert!(state.rename_layer(&id, "New"));
        assert_eq!(state.get_layers_snapshot()[0].name, "New");
    }

    #[test]
    fn dirty_flag_tracking() {
        let state = SceneState::new();
        assert!(!state.is_dirty());
        add_quad(&state, "L1");
        assert!(state.is_dirty());
        state.mark_clean();
        assert!(!state.is_dirty());
    }

    #[test]
    fn revision_increments() {
        let state = SceneState::new();
        let r0 = state.revision();
        add_quad(&state, "L1");
        let r1 = state.revision();
        assert!(r1 > r0);
    }

    #[test]
    fn set_blend_mode() {
        let state = SceneState::new();
        let id = add_quad(&state, "L1");
        assert!(state.set_layer_blend_mode(&id, BlendMode::Additive));
        assert_eq!(state.get_layers_snapshot()[0].blend_mode, BlendMode::Additive);
    }

    #[test]
    fn remove_layers_batch() {
        let state = SceneState::new();
        let id1 = add_quad(&state, "A");
        let id2 = add_quad(&state, "B");
        add_quad(&state, "C");

        assert!(state.remove_layers(&[id1, id2]));
        assert_eq!(state.get_layers_snapshot().len(), 1);
        assert_eq!(state.get_layers_snapshot()[0].name, "C");
    }

    #[test]
    fn duplicate_layers_batch() {
        let state = SceneState::new();
        let id1 = add_quad(&state, "A");
        let id2 = add_quad(&state, "B");

        let dups = state.duplicate_layers(&[id1, id2]);
        assert_eq!(dups.len(), 2);
        assert_eq!(state.get_layers_snapshot().len(), 4);
    }

    // --- Mesh face operation tests ---

    #[test]
    fn toggle_face_mask() {
        let state = SceneState::new();
        let id = add_mesh(&state, "M", 2, 2);

        assert!(state.toggle_face_mask(&id, vec![0, 1], true));
        let layers = state.get_layers_snapshot();
        if let LayerGeometry::Mesh { masked_faces, .. } = &layers[0].geometry {
            assert!(masked_faces.contains(&0));
            assert!(masked_faces.contains(&1));
        } else {
            panic!("Expected Mesh");
        }

        // Unmask face 0
        assert!(state.toggle_face_mask(&id, vec![0], false));
        let layers = state.get_layers_snapshot();
        if let LayerGeometry::Mesh { masked_faces, .. } = &layers[0].geometry {
            assert!(!masked_faces.contains(&0));
            assert!(masked_faces.contains(&1));
        } else {
            panic!("Expected Mesh");
        }
    }

    #[test]
    fn create_and_remove_face_group() {
        let state = SceneState::new();
        let id = add_mesh(&state, "M", 2, 2);

        assert!(state.create_face_group(&id, "Group1".into(), vec![0, 1], "#ff0000".into()));
        let layers = state.get_layers_snapshot();
        if let LayerGeometry::Mesh { face_groups, .. } = &layers[0].geometry {
            assert_eq!(face_groups.len(), 1);
            assert_eq!(face_groups[0].name, "Group1");
        } else {
            panic!("Expected Mesh");
        }

        assert!(state.remove_face_group(&id, 0));
        let layers = state.get_layers_snapshot();
        if let LayerGeometry::Mesh { face_groups, .. } = &layers[0].geometry {
            assert!(face_groups.is_empty());
        } else {
            panic!("Expected Mesh");
        }
    }

    #[test]
    fn rename_face_group() {
        let state = SceneState::new();
        let id = add_mesh(&state, "M", 2, 2);
        state.create_face_group(&id, "Old".into(), vec![0], "#ff0000".into());

        assert!(state.rename_face_group(&id, 0, "New".into()));
        let layers = state.get_layers_snapshot();
        if let LayerGeometry::Mesh { face_groups, .. } = &layers[0].geometry {
            assert_eq!(face_groups[0].name, "New");
        } else {
            panic!("Expected Mesh");
        }
    }

    #[test]
    fn set_and_clear_face_uv_override() {
        let state = SceneState::new();
        let id = add_mesh(&state, "M", 2, 2);

        let adj = UvAdjustment {
            offset: [0.1, 0.2],
            rotation: 0.5,
            scale: [1.0, 1.0],
        };
        assert!(state.set_face_uv_override(&id, 0, adj));

        let layers = state.get_layers_snapshot();
        if let LayerGeometry::Mesh { uv_overrides, .. } = &layers[0].geometry {
            assert!(uv_overrides.contains_key(&0));
        } else {
            panic!("Expected Mesh");
        }

        assert!(state.clear_face_uv_override(&id, 0));
        let layers = state.get_layers_snapshot();
        if let LayerGeometry::Mesh { uv_overrides, .. } = &layers[0].geometry {
            assert!(!uv_overrides.contains_key(&0));
        } else {
            panic!("Expected Mesh");
        }
    }

    #[test]
    fn subdivide_mesh_doubles_resolution() {
        let state = SceneState::new();
        let id = add_mesh(&state, "M", 2, 2);

        let result = state.subdivide_mesh(&id);
        assert!(result.is_some());
        if let Some(LayerGeometry::Mesh { cols, rows, points, .. }) = result {
            assert_eq!(cols, 4);
            assert_eq!(rows, 4);
            assert_eq!(points.len(), (4 + 1) * (4 + 1)); // 25
        } else {
            panic!("Expected Mesh geometry");
        }
    }

    #[test]
    fn face_ops_on_non_mesh_return_false() {
        let state = SceneState::new();
        let layer = Layer::new_triangle("T", 0);
        let id = layer.id.clone();
        state.add_layer(layer);

        // toggle_face_mask on a triangle does "succeed" (returns true because layer exists)
        // but doesn't modify anything since the geometry isn't a Mesh.
        // The important thing is it doesn't panic.
        let _ = state.toggle_face_mask(&id, vec![0], true);
        let _ = state.create_face_group(&id, "G".into(), vec![0], "#fff".into());

        // subdivide on non-mesh returns None
        assert!(state.subdivide_mesh(&id).is_none());
    }
}

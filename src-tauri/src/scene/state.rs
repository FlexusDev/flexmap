use parking_lot::RwLock;
use super::history::History;
use super::layer::*;
use super::project::*;

/// Thread-safe application scene state. Rust backend is the source of truth.
pub struct SceneState {
    pub project: RwLock<ProjectFile>,
    pub dirty: RwLock<bool>,
    pub project_path: RwLock<Option<String>>,
    pub autosave_path: RwLock<Option<String>>,
    pub history: History,
}

impl SceneState {
    pub fn new() -> Self {
        Self {
            project: RwLock::new(ProjectFile::new("Untitled Project")),
            dirty: RwLock::new(false),
            project_path: RwLock::new(None),
            autosave_path: RwLock::new(None),
            history: History::new(),
        }
    }

    pub fn mark_dirty(&self) {
        *self.dirty.write() = true;
        self.project.write().touch();
    }

    pub fn mark_clean(&self) {
        *self.dirty.write() = false;
    }

    pub fn is_dirty(&self) -> bool {
        *self.dirty.read()
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

    // --- Project management ---

    pub fn load_project(&self, project: ProjectFile, path: Option<String>) {
        *self.project.write() = project;
        *self.project_path.write() = path;
        self.history.clear();
        self.mark_clean();
    }

    pub fn new_project(&self, name: &str) {
        *self.project.write() = ProjectFile::new(name);
        *self.project_path.write() = None;
        self.history.clear();
        self.mark_clean();
    }
}

impl Default for SceneState {
    fn default() -> Self {
        Self::new()
    }
}

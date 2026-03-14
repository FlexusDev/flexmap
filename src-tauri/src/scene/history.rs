//! Undo/redo history for the scene state.
//! Uses a snapshot-based approach: each undo step stores the full layer list
//! and group list. This is simple, correct, and fast enough for typical counts.

use super::group::LayerGroup;
use super::layer::Layer;
use parking_lot::RwLock;

const MAX_HISTORY: usize = 50;

/// A snapshot of the scene state: (layers, groups)
pub type SceneSnapshot = (Vec<Layer>, Vec<LayerGroup>);

pub struct History {
    undo_stack: RwLock<Vec<SceneSnapshot>>,
    redo_stack: RwLock<Vec<SceneSnapshot>>,
}

impl History {
    pub fn new() -> Self {
        Self {
            undo_stack: RwLock::new(Vec::new()),
            redo_stack: RwLock::new(Vec::new()),
        }
    }

    /// Push the current state before a mutation
    pub fn push(&self, snapshot: SceneSnapshot) {
        let mut undo = self.undo_stack.write();
        undo.push(snapshot);
        if undo.len() > MAX_HISTORY {
            undo.remove(0);
        }
        // Any new action clears the redo stack
        self.redo_stack.write().clear();
    }

    /// Undo: pop from undo, push current to redo, return the previous state
    pub fn undo(&self, current: SceneSnapshot) -> Option<SceneSnapshot> {
        let mut undo = self.undo_stack.write();
        if let Some(prev) = undo.pop() {
            self.redo_stack.write().push(current);
            Some(prev)
        } else {
            None
        }
    }

    /// Redo: pop from redo, push current to undo, return the next state
    pub fn redo(&self, current: SceneSnapshot) -> Option<SceneSnapshot> {
        let mut redo = self.redo_stack.write();
        if let Some(next) = redo.pop() {
            self.undo_stack.write().push(current);
            Some(next)
        } else {
            None
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.read().is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.read().is_empty()
    }

    pub fn clear(&self) {
        self.undo_stack.write().clear();
        self.redo_stack.write().clear();
    }
}

impl Default for History {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::layer::*;

    fn make_layer(name: &str) -> Layer {
        Layer::new_quad(name, 0)
    }

    fn make_snapshot(layers: Vec<Layer>) -> SceneSnapshot {
        (layers, Vec::new())
    }

    #[test]
    fn new_history_empty() {
        let h = History::new();
        assert!(!h.can_undo());
        assert!(!h.can_redo());
    }

    #[test]
    fn push_then_undo() {
        let h = History::new();
        let snap = make_snapshot(vec![make_layer("A")]);
        h.push(snap.clone());
        assert!(h.can_undo());

        let current = make_snapshot(vec![make_layer("B")]);
        let prev = h.undo(current).unwrap();
        assert_eq!(prev.0.len(), 1);
        assert_eq!(prev.0[0].name, "A");
    }

    #[test]
    fn undo_then_redo() {
        let h = History::new();
        let snap = make_snapshot(vec![make_layer("A")]);
        h.push(snap);

        let current = make_snapshot(vec![make_layer("B")]);
        let prev = h.undo(current).unwrap();
        assert!(h.can_redo());

        let next = h.redo(prev).unwrap();
        assert_eq!(next.0.len(), 1);
        assert_eq!(next.0[0].name, "B");
    }

    #[test]
    fn push_after_undo_clears_redo() {
        let h = History::new();
        h.push(make_snapshot(vec![make_layer("A")]));
        let _ = h.undo(make_snapshot(vec![make_layer("B")]));
        assert!(h.can_redo());

        h.push(make_snapshot(vec![make_layer("C")]));
        assert!(!h.can_redo());
    }

    #[test]
    fn empty_undo_returns_none() {
        let h = History::new();
        assert!(h.undo(make_snapshot(vec![])).is_none());
    }

    #[test]
    fn max_history_truncation() {
        let h = History::new();
        for i in 0..60 {
            h.push(make_snapshot(vec![make_layer(&format!("L{}", i))]));
        }
        // Should be capped at MAX_HISTORY (50)
        assert_eq!(h.undo_stack.read().len(), MAX_HISTORY);
    }

    #[test]
    fn clear_resets() {
        let h = History::new();
        h.push(make_snapshot(vec![make_layer("A")]));
        let _ = h.undo(make_snapshot(vec![make_layer("B")]));
        assert!(h.can_redo());

        h.clear();
        assert!(!h.can_undo());
        assert!(!h.can_redo());
    }
}

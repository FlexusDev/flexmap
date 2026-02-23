//! Undo/redo history for the scene state.
//! Uses a snapshot-based approach: each undo step stores the full layer list.
//! This is simple, correct, and fast enough for typical layer counts (<100).

use parking_lot::RwLock;
use super::layer::Layer;

const MAX_HISTORY: usize = 50;

pub struct History {
    undo_stack: RwLock<Vec<Vec<Layer>>>,
    redo_stack: RwLock<Vec<Vec<Layer>>>,
}

impl History {
    pub fn new() -> Self {
        Self {
            undo_stack: RwLock::new(Vec::new()),
            redo_stack: RwLock::new(Vec::new()),
        }
    }

    /// Push the current state before a mutation
    pub fn push(&self, layers: Vec<Layer>) {
        let mut undo = self.undo_stack.write();
        undo.push(layers);
        if undo.len() > MAX_HISTORY {
            undo.remove(0);
        }
        // Any new action clears the redo stack
        self.redo_stack.write().clear();
    }

    /// Undo: pop from undo, push current to redo, return the previous state
    pub fn undo(&self, current: Vec<Layer>) -> Option<Vec<Layer>> {
        let mut undo = self.undo_stack.write();
        if let Some(prev) = undo.pop() {
            self.redo_stack.write().push(current);
            Some(prev)
        } else {
            None
        }
    }

    /// Redo: pop from redo, push current to undo, return the next state
    pub fn redo(&self, current: Vec<Layer>) -> Option<Vec<Layer>> {
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

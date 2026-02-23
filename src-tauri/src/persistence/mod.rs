use crate::scene::project::ProjectFile;
use std::path::{Path, PathBuf};

const AUTOSAVE_FILENAME: &str = ".flexmap_autosave.json";

/// Save a project to a JSON file
pub fn save_project(project: &ProjectFile, path: &Path) -> Result<(), String> {
    let json = serde_json::to_string_pretty(project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write file: {}", e))?;
    log::info!("Project saved to {:?}", path);
    Ok(())
}

/// Load a project from a JSON file
pub fn load_project(path: &Path) -> Result<ProjectFile, String> {
    let json =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;
    let project: ProjectFile =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse project: {}", e))?;

    // Validate schema version
    if project.schema_version > crate::scene::project::SCHEMA_VERSION {
        log::warn!(
            "Project schema version {} is newer than supported version {}",
            project.schema_version,
            crate::scene::project::SCHEMA_VERSION
        );
    }

    log::info!("Project loaded from {:?}", path);
    Ok(project)
}

/// Get the autosave file path (next to the project file, or in a default location)
pub fn autosave_path(project_path: Option<&Path>) -> PathBuf {
    if let Some(pp) = project_path {
        pp.parent()
            .unwrap_or(Path::new("."))
            .join(AUTOSAVE_FILENAME)
    } else {
        dirs_next()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(AUTOSAVE_FILENAME)
    }
}

/// Get a reasonable default directory for autosave
fn dirs_next() -> Option<PathBuf> {
    // Use the system's document directory or home directory
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from)
        .map(|p| p.join(".flexmap"))
}

/// Save autosave file
pub fn autosave(project: &ProjectFile, project_path: Option<&Path>) -> Result<PathBuf, String> {
    let path = autosave_path(project_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create autosave directory: {}", e))?;
    }
    save_project(project, &path)?;
    log::debug!("Autosaved to {:?}", path);
    Ok(path)
}

/// Check if an autosave recovery file exists
pub fn has_recovery(project_path: Option<&Path>) -> bool {
    autosave_path(project_path).exists()
}

/// Load autosave recovery file
pub fn load_recovery(project_path: Option<&Path>) -> Result<ProjectFile, String> {
    let path = autosave_path(project_path);
    load_project(&path)
}

/// Remove autosave file after successful save
pub fn clear_recovery(project_path: Option<&Path>) {
    let path = autosave_path(project_path);
    let _ = std::fs::remove_file(&path);
}

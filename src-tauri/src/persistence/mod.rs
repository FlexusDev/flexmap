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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::layer::*;
    use crate::scene::project::ProjectFile;
    use tempfile::TempDir;

    fn sample_project() -> ProjectFile {
        let mut proj = ProjectFile::new("Test Project");
        proj.layers.push(Layer::new_quad("Q1", 0));
        proj.layers.push(Layer::new_mesh("M1", 1, 3, 2));
        proj
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.flexmap");
        let proj = sample_project();

        save_project(&proj, &path).unwrap();
        let loaded = load_project(&path).unwrap();

        assert_eq!(loaded.project_name, "Test Project");
        assert_eq!(loaded.layers.len(), 2);
        assert_eq!(loaded.layers[0].name, "Q1");
        assert_eq!(loaded.layers[1].name, "M1");
    }

    #[test]
    fn save_creates_valid_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.flexmap");
        let proj = sample_project();

        save_project(&proj, &path).unwrap();
        let json = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed.is_object());
        assert_eq!(parsed["projectName"], "Test Project");
    }

    #[test]
    fn load_nonexistent_returns_error() {
        let result = load_project(Path::new("/tmp/nonexistent_flexmap_test_file.flexmap"));
        assert!(result.is_err());
    }

    #[test]
    fn autosave_and_recovery_roundtrip() {
        let dir = TempDir::new().unwrap();
        let proj_path = dir.path().join("project.flexmap");
        let proj = sample_project();

        // Autosave
        let auto_path = autosave(&proj, Some(proj_path.as_path())).unwrap();
        assert!(auto_path.exists());

        // Has recovery
        assert!(has_recovery(Some(proj_path.as_path())));

        // Load recovery
        let recovered = load_recovery(Some(proj_path.as_path())).unwrap();
        assert_eq!(recovered.project_name, "Test Project");
        assert_eq!(recovered.layers.len(), 2);

        // Clear recovery
        clear_recovery(Some(proj_path.as_path()));
        assert!(!has_recovery(Some(proj_path.as_path())));
    }

    #[test]
    fn layer_geometry_survives_serialization() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("geo.flexmap");

        let mut proj = ProjectFile::new("Geo Test");
        let mesh_layer = Layer::new_mesh("M", 0, 2, 2);
        proj.layers.push(mesh_layer);

        save_project(&proj, &path).unwrap();
        let loaded = load_project(&path).unwrap();

        if let LayerGeometry::Mesh {
            cols,
            rows,
            points,
        } = &loaded.layers[0].geometry
        {
            assert_eq!(*cols, 2);
            assert_eq!(*rows, 2);
            assert_eq!(points.len(), 9);
        } else {
            panic!("Expected Mesh geometry after deserialization");
        }
    }
}

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // Build Syphon.framework BEFORE tauri_build::build() — Tauri validates
    // the framework path from tauri.conf.json and will fail if it doesn't exist.
    #[cfg(all(target_os = "macos", feature = "input-syphon"))]
    {
        if target_os == "macos" {
            build_syphon_framework();
        }
    }

    tauri_build::build();

    // Syphon ObjC bridge (macOS only, behind input-syphon feature)
    //
    // The bridge uses dlopen() to load Syphon.framework at runtime,
    // so it ALWAYS compiles — no framework needed at build time.
    // build_syphon_framework() above ensures the framework binary exists
    // so that dlopen() succeeds on first launch.
    #[cfg(all(target_os = "macos", feature = "input-syphon"))]
    {
        if target_os == "macos" {
            cc::Build::new()
                .file("src/input/syphon/bridge.m")
                .include("src/input/syphon") // find bridge.h
                .flag("-fobjc-arc")          // use ARC
                .compile("syphon_bridge");

            // Link system frameworks (Metal + Foundation are always available)
            println!("cargo:rustc-link-lib=framework=Metal");
            println!("cargo:rustc-link-lib=framework=Foundation");

            println!("cargo:rerun-if-changed=src/input/syphon/bridge.m");
            println!("cargo:rerun-if-changed=src/input/syphon/bridge.h");
        }
    }
}

/// Build Syphon.framework from source and cache at src-tauri/frameworks/.
///
/// Clones the Syphon-Framework repo, compiles all .m AND .c files with clang,
/// and creates a proper macOS framework bundle. Skips if already built.
/// Also copies to ~/Library/Frameworks/ for dev mode (cargo tauri dev runs
/// a bare binary, not inside an .app bundle).
#[cfg(all(target_os = "macos", feature = "input-syphon"))]
fn build_syphon_framework() {
    use std::path::PathBuf;
    use std::process::Command;

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let fw_dir = PathBuf::from(&manifest_dir).join("frameworks/Syphon.framework");
    let dylib_path = fw_dir.join("Versions/A/Syphon");

    // Skip if already built
    println!("cargo:rerun-if-changed=frameworks/Syphon.framework/Versions/A/Syphon");
    if dylib_path.exists() {
        println!("cargo:warning=Syphon.framework already cached — skipping build");
        copy_to_user_frameworks(&fw_dir);
        return;
    }

    println!("cargo:warning=Building Syphon.framework from source...");

    // Clone repo (shallow) into OUT_DIR
    let repo_dir = PathBuf::from(&out_dir).join("Syphon-Framework");
    let _ = std::fs::remove_dir_all(&repo_dir);

    let git_output = Command::new("git")
        .args([
            "clone",
            "--depth",
            "1",
            "https://github.com/Syphon/Syphon-Framework.git",
            repo_dir.to_str().unwrap(),
        ])
        .output()
        .expect("Failed to run git — is it installed?");

    if !git_output.status.success() {
        let stderr = String::from_utf8_lossy(&git_output.stderr);
        panic!("Failed to clone Syphon-Framework: {}", stderr);
    }

    // Collect BOTH .m AND .c source files (the .c files define critical symbols)
    let source_files = collect_source_files(&repo_dir);
    if source_files.is_empty() {
        panic!("No source files found in Syphon-Framework repo");
    }
    println!(
        "cargo:warning=Found {} Syphon source files ({} .m, {} .c)",
        source_files.len(),
        source_files.iter().filter(|f| f.ends_with(".m")).count(),
        source_files.iter().filter(|f| f.ends_with(".c")).count(),
    );

    // Create framework bundle structure
    let fw_versions = fw_dir.join("Versions/A");
    let fw_headers = fw_versions.join("Headers");
    let fw_resources = fw_versions.join("Resources");
    std::fs::create_dir_all(&fw_headers).expect("mkdir Headers");
    std::fs::create_dir_all(&fw_resources).expect("mkdir Resources");

    // Create symlink so #import <Syphon/SyphonFoo.h> resolves
    let syphon_link = PathBuf::from(&out_dir).join("Syphon");
    let _ = std::fs::remove_file(&syphon_link);
    let _ = std::os::unix::fs::symlink(&repo_dir, &syphon_link);

    // Detect native architecture
    let arch_output = Command::new("uname")
        .arg("-m")
        .output()
        .expect("uname failed");
    let native_arch = String::from_utf8_lossy(&arch_output.stdout)
        .trim()
        .to_string();

    // Split source files: .c files are pure C (no ARC), .m files are ObjC with ARC.
    // SyphonDispatch.c uses dispatch_release() etc. which is incompatible with ARC.
    let c_files: Vec<&str> = source_files.iter().filter(|f| f.ends_with(".c")).map(|s| s.as_str()).collect();
    let m_files: Vec<&str> = source_files.iter().filter(|f| f.ends_with(".m")).map(|s| s.as_str()).collect();

    // Step 1: Compile .c files to .o (plain C, no ARC, no ObjC headers)
    let obj_dir = PathBuf::from(&out_dir).join("syphon_objs");
    let _ = std::fs::remove_dir_all(&obj_dir);
    std::fs::create_dir_all(&obj_dir).expect("mkdir syphon_objs");

    let mut obj_files: Vec<String> = Vec::new();
    for c_file in &c_files {
        let stem = std::path::Path::new(c_file).file_stem().unwrap().to_str().unwrap();
        let obj_path = obj_dir.join(format!("{}.o", stem));

        let c_output = Command::new("clang")
            .args([
                "-c", "-O2",
                "-arch", &native_arch,
                "-I", repo_dir.to_str().unwrap(),
                "-I", &out_dir,
                "-DSYPHONLOG(...)=",
                "-DGL_SILENCE_DEPRECATION",
                "-Wno-deprecated-declarations",
                "-Wno-implicit-function-declaration",
                "-ferror-limit=0",
                "-o", obj_path.to_str().unwrap(),
                c_file,
            ])
            .output()
            .expect("clang failed to start (C compile)");

        if !c_output.status.success() {
            let stderr = String::from_utf8_lossy(&c_output.stderr);
            panic!("Syphon C compilation failed for {}:\n{}", c_file, stderr);
        }
        obj_files.push(obj_path.to_string_lossy().into_owned());
    }

    // Step 2: Compile .m files + link with .o files into dynamic library
    let mut clang_args: Vec<String> = vec![
        "-dynamiclib".into(),
        "-fobjc-arc".into(),
        "-O2".into(),
        "-arch".into(),
        native_arch,
        "-framework".into(), "Foundation".into(),
        "-framework".into(), "Metal".into(),
        "-framework".into(), "IOSurface".into(),
        "-framework".into(), "Cocoa".into(),
        "-framework".into(), "OpenGL".into(),
        "-framework".into(), "CoreVideo".into(),
        "-install_name".into(),
        "@rpath/Syphon.framework/Versions/A/Syphon".into(),
        "-I".into(), repo_dir.to_str().unwrap().into(),
        "-I".into(), out_dir.clone(),
        "-include".into(), "Foundation/Foundation.h".into(),
        "-include".into(), "AppKit/AppKit.h".into(),
        "-include".into(), "libkern/OSAtomic.h".into(),
        "-DSYPHONLOG(...)=".into(),
        "-DGL_SILENCE_DEPRECATION".into(),
        "-Wno-deprecated-declarations".into(),
        "-Wno-implicit-function-declaration".into(),
        "-ferror-limit=0".into(),
        "-o".into(),
        dylib_path.to_str().unwrap().into(),
    ];
    // Add .m source files
    for src in &m_files {
        clang_args.push(src.to_string());
    }
    // Add pre-compiled .o files from .c sources
    for obj in &obj_files {
        clang_args.push(obj.clone());
    }

    let compile_output = Command::new("clang")
        .args(&clang_args)
        .output()
        .expect("clang failed to start");

    if !compile_output.status.success() {
        let stderr = String::from_utf8_lossy(&compile_output.stderr);
        panic!("Syphon compilation failed:\n{}", stderr);
    }

    // Copy public headers
    copy_headers(&repo_dir, &fw_headers);

    // Create Info.plist
    std::fs::write(
        fw_resources.join("Info.plist"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>info.syphon.Syphon</string>
    <key>CFBundleName</key>
    <string>Syphon</string>
    <key>CFBundleVersion</key>
    <string>5.0</string>
    <key>CFBundlePackageType</key>
    <string>FMWK</string>
    <key>CFBundleExecutable</key>
    <string>Syphon</string>
</dict>
</plist>"#,
    )
    .expect("Failed to write Info.plist");

    // Create standard framework symlinks
    let _ = std::os::unix::fs::symlink("A", fw_dir.join("Versions/Current"));
    let _ = std::os::unix::fs::symlink("Versions/Current/Syphon", fw_dir.join("Syphon"));
    let _ = std::os::unix::fs::symlink("Versions/Current/Headers", fw_dir.join("Headers"));
    let _ = std::os::unix::fs::symlink("Versions/Current/Resources", fw_dir.join("Resources"));

    println!("cargo:warning=Syphon.framework built successfully");

    // Copy to ~/Library/Frameworks/ for dev mode
    copy_to_user_frameworks(&fw_dir);
}

/// Collect .m and .c source files, excluding tests/examples.
#[cfg(all(target_os = "macos", feature = "input-syphon"))]
fn collect_source_files(repo_dir: &std::path::Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_sources_recursive(repo_dir, &mut files);
    files
}

#[cfg(all(target_os = "macos", feature = "input-syphon"))]
fn collect_sources_recursive(dir: &std::path::Path, files: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();

        // Skip test/example directories
        if path.is_dir() {
            let lower = name.to_lowercase();
            if lower.contains("test") || lower.contains("example") {
                continue;
            }
            collect_sources_recursive(&path, files);
            continue;
        }

        // Collect .m and .c files
        if let Some(ext) = path.extension() {
            if ext == "m" || ext == "c" {
                files.push(path.to_string_lossy().into_owned());
            }
        }
    }
}

/// Copy public headers from the repo into the framework Headers dir.
#[cfg(all(target_os = "macos", feature = "input-syphon"))]
fn copy_headers(repo_dir: &std::path::Path, fw_headers: &std::path::Path) {
    copy_headers_recursive(repo_dir, fw_headers);
}

#[cfg(all(target_os = "macos", feature = "input-syphon"))]
fn copy_headers_recursive(dir: &std::path::Path, fw_headers: &std::path::Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();

        if path.is_dir() {
            let lower = name.to_lowercase();
            if lower.contains("test") {
                continue;
            }
            copy_headers_recursive(&path, fw_headers);
            continue;
        }

        if path.extension().map_or(false, |e| e == "h") {
            let _ = std::fs::copy(&path, fw_headers.join(path.file_name().unwrap()));
        }
    }
}

/// Copy framework to ~/Library/Frameworks/ for dev mode.
/// In dev mode (`cargo tauri dev`), the binary runs outside an .app bundle
/// so it can't find the bundled framework. This ensures dlopen() finds it.
#[cfg(all(target_os = "macos", feature = "input-syphon"))]
fn copy_to_user_frameworks(fw_dir: &std::path::Path) {
    if let Ok(home) = std::env::var("HOME") {
        let user_fw = format!("{}/Library/Frameworks", home);
        let target = format!("{}/Syphon.framework", user_fw);
        let _ = std::fs::create_dir_all(&user_fw);
        // Remove existing and copy fresh
        let _ = std::fs::remove_dir_all(&target);
        let status = std::process::Command::new("cp")
            .args(["-R", fw_dir.to_str().unwrap(), &target])
            .status();
        match status {
            Ok(s) if s.success() => {
                println!("cargo:warning=Copied Syphon.framework to {}", target);
            }
            _ => {
                println!(
                    "cargo:warning=Failed to copy Syphon.framework to {} (non-fatal)",
                    target
                );
            }
        }
    }
}

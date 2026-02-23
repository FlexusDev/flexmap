fn main() {
    tauri_build::build();

    // Register custom cfg so rustc doesn't warn about unexpected_cfgs
    println!("cargo::rustc-check-cfg=cfg(has_syphon_bridge)");

    // Syphon.framework bridge (macOS only, behind input-syphon feature)
    #[cfg(all(target_os = "macos", feature = "input-syphon"))]
    {
        // Search for Syphon.framework in several common locations
        let home = std::env::var("HOME").unwrap_or_default();
        let mut search_paths = vec![
            "/Library/Frameworks".to_string(),
            format!("{}/Library/Frameworks", home),
        ];

        // Allow overriding via environment variable:
        //   SYPHON_FRAMEWORK_PATH=/path/to/dir/containing/Syphon.framework cargo tauri dev
        if let Ok(custom) = std::env::var("SYPHON_FRAMEWORK_PATH") {
            search_paths.insert(0, custom);
        }

        // Also check inside common app bundles that ship with Syphon
        let app_framework_globs = [
            "/Applications/Synesthesia.app/Contents/Frameworks",
            "/Applications/Resolume Arena.app/Contents/Frameworks",
            "/Applications/Resolume Avenue.app/Contents/Frameworks",
            "/Applications/VDMX5.app/Contents/Frameworks",
            "/Applications/MadMapper.app/Contents/Frameworks",
            "/Applications/Millumin3.app/Contents/Frameworks",
        ];
        for path in &app_framework_globs {
            search_paths.push(path.to_string());
        }

        // Find the first directory that contains Syphon.framework
        let syphon_dir = search_paths.iter().find(|dir| {
            std::path::Path::new(&format!("{}/Syphon.framework", dir)).exists()
        });

        if let Some(framework_dir) = syphon_dir {
            println!(
                "cargo:warning=Found Syphon.framework in {}",
                framework_dir
            );

            // Compile the Objective-C bridge
            cc::Build::new()
                .file("src/input/syphon/bridge.m")
                .include("src/input/syphon") // find bridge.h
                .flag("-fobjc-arc")          // use ARC
                .flag(&format!("-F{}", framework_dir))
                .compile("syphon_bridge");

            // Link frameworks
            println!("cargo:rustc-link-search=framework={}", framework_dir);
            println!("cargo:rustc-link-lib=framework=Syphon");
            println!("cargo:rustc-link-lib=framework=Metal");
            println!("cargo:rustc-link-lib=framework=Foundation");

            // Tell our Rust code that the bridge is available
            println!("cargo:rustc-cfg=has_syphon_bridge");

            println!("cargo:rerun-if-changed=src/input/syphon/bridge.m");
            println!("cargo:rerun-if-changed=src/input/syphon/bridge.h");
        } else {
            println!("cargo:warning=Syphon.framework not found.");
            println!("cargo:warning=Searched: {}", search_paths.join(", "));
            println!("cargo:warning=To install: download from https://github.com/Syphon/Syphon-Framework/releases");
            println!("cargo:warning=Then: sudo cp -R Syphon.framework /Library/Frameworks/");
            println!("cargo:warning=Or set SYPHON_FRAMEWORK_PATH=/path/to/folder");
        }

        println!("cargo:rerun-if-env-changed=SYPHON_FRAMEWORK_PATH");
    }
}

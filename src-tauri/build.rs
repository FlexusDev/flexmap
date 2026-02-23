fn main() {
    tauri_build::build();

    // Syphon.framework bridge (macOS only, behind input-syphon feature)
    #[cfg(all(target_os = "macos", feature = "input-syphon"))]
    {
        let syphon_paths = [
            "/Library/Frameworks/Syphon.framework",
            // Homebrew or user-local installs
            concat!(env!("HOME"), "/Library/Frameworks/Syphon.framework"),
        ];

        let syphon_found = syphon_paths.iter().any(|p| std::path::Path::new(p).exists());

        if syphon_found {
            // Compile the Objective-C bridge
            cc::Build::new()
                .file("src/input/syphon/bridge.m")
                .include("src/input/syphon")       // find bridge.h
                .flag("-fobjc-arc")                 // use ARC
                .flag("-F/Library/Frameworks")      // framework search path
                .compile("syphon_bridge");

            // Link frameworks
            println!("cargo:rustc-link-search=framework=/Library/Frameworks");
            println!("cargo:rustc-link-lib=framework=Syphon");
            println!("cargo:rustc-link-lib=framework=Metal");
            println!("cargo:rustc-link-lib=framework=Foundation");

            // Tell our Rust code that the bridge is available
            println!("cargo:rustc-cfg=has_syphon_bridge");

            println!("cargo:rerun-if-changed=src/input/syphon/bridge.m");
            println!("cargo:rerun-if-changed=src/input/syphon/bridge.h");
        } else {
            println!("cargo:warning=Syphon.framework not found at /Library/Frameworks/");
            println!("cargo:warning=Install from https://syphon.info to enable Syphon input.");
            println!("cargo:warning=Syphon backend will compile but report no sources at runtime.");
        }
    }
}

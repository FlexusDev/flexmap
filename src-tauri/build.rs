fn main() {
    tauri_build::build();

    // Syphon ObjC bridge (macOS only, behind input-syphon feature)
    //
    // The bridge uses dlopen() to load Syphon.framework at runtime,
    // so it ALWAYS compiles — no framework needed at build time.
    // This enables the "Install Syphon" button in the UI to work
    // without requiring an app rebuild.
    #[cfg(all(target_os = "macos", feature = "input-syphon"))]
    {
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

# FlexMap — Distribution builds

**You can build Windows from macOS** via cross-compilation (see below). Easiest is still building each platform on its native OS or using CI (e.g. GitHub Actions). **MSI installers** can only be created on Windows (WiX is Windows-only); from macOS you get **NSIS** (`.exe` setup) or a portable exe.

## Releasing (macOS)

To build and publish the current version to GitHub Releases:

```bash
npm run release:mac
```

This builds the portable `.app`, zips it, and creates/updates the GitHub release (e.g. `v0.2.0`) with the asset. Requires `gh` CLI and a Mac with Rust/Tauri toolchain.

## Releasing via GitHub Actions

The workflow `.github/workflows/release-build.yml` builds both portable targets.

- Trigger automatically by publishing a GitHub Release.
- Or trigger manually with `workflow_dispatch`.

When triggered by a published release, it uploads:

- `FlexMap-macOS-<version>-portable.zip` (contains `FlexMap.app`)
- `FlexMap-Windows-<version>-portable.zip` (contains `flexmap.exe` and runtime DLLs, if present)

---

## Portable builds (no installer)

Use these when you want a single runnable app without running an installer.

### Windows (portable)

**On Windows:**

```bash
npm run build:portable:win
```

- **Output:** `src-tauri/target/release/flexmap.exe` (and any runtime DLLs in that folder).
- The exe is self-contained (frontend is embedded). Copy the exe (and the whole `release` folder if you see extra DLLs) to a USB drive or folder and run it anywhere. WebView2 is required on the target machine (usually already present on Windows 10/11).

**From macOS (cross-compile):** see [Building Windows from macOS](#building-windows-from-macos-cross-compile) below, then use `--no-bundle` to get only the portable exe (no NSIS installer).

To ship as a zip: zip the contents of `src-tauri/target/release/` (or `target/x86_64-pc-windows-msvc/release/` when cross-compiling) as e.g. `FlexMap-Windows-Portable.zip`.

### macOS (portable)

On macOS:

```bash
npm run build:portable:mac
```

- **Output:** `src-tauri/target/release/bundle/macOS/FlexMap.app`.
- The `.app` is portable: copy it anywhere (e.g. Applications or a USB stick) and run it. No DMG or install step.

## Installer builds (default)

Standard `npm run tauri build` (or `npm run build` then `npm run tauri build`) produces installers:

- **Windows:** NSIS setup (`…-setup.exe`) and/or MSI in `src-tauri/target/release/bundle/nsis/` and `…/msi/`. (MSI only when building on Windows.)
- **macOS:** `.app` and `.dmg` in `src-tauri/target/release/bundle/macOS/`.

Use these when you want a normal installer experience (Start Menu / Applications, uninstaller, etc.).

---

## Building Windows from macOS (cross-compile)

You can build the Windows app (and NSIS installer) from a Mac with extra tooling. Tauri recommends this only if you can’t use a Windows machine or CI.

### One-time setup (macOS)

1. **NSIS** (for the Windows installer):
   ```bash
   brew install nsis
   ```

2. **LLVM + LLD** (linker and Windows resource compiler):
   ```bash
   brew install llvm
   ```
   Ensure `lld` and `llvm-rc` are on your `PATH` (Homebrew often installs them with a version prefix; you may need a symlink or to add the LLVM bin directory).

3. **Windows Rust target:**
   ```bash
   rustup target add x86_64-pc-windows-msvc
   ```

4. **cargo-xwin** (provides Windows SDK / MSVC libs for cross-compile):
   ```bash
   cargo install --locked cargo-xwin
   ```

### Build commands (from project root)

- **Portable Windows exe only** (no installer):
  ```bash
  npm run build && npx tauri build --no-bundle --runner cargo-xwin --target x86_64-pc-windows-msvc
  ```
  Output: `src-tauri/target/x86_64-pc-windows-msvc/release/flexmap.exe`

- **NSIS installer** (Windows setup `.exe`):
  ```bash
  npm run build && npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
  ```
  Output: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`

You cannot produce **MSI** installers from macOS (WiX runs only on Windows).

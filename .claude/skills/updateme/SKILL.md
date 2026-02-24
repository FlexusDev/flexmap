---
name: updateme
description: >
  End-of-session release skill for FlexMap. Checks CI, runs local builds,
  bumps version, writes a denoised changelog, commits, and tags. Use this
  skill whenever the user says "release", "ship it", "bump version",
  "wrap up session", "cut a release", or "/release". Also use it if the user
  asks to update the changelog or version after a coding session.
---

# Release — FlexMap Session Wrap-Up

Run this at the end of a coding session to verify everything works, bump the
version, write a clean changelog entry, and commit the release.

## Versioning Rules (Pre-1.0 Alpha)

FlexMap is in alpha. All versions stay in the `0.x.y` range until a stable
public release is declared.

| Bump    | When to use                                          | Example         |
|---------|------------------------------------------------------|-----------------|
| `minor` | New user-facing features, new milestones, breaking changes | 0.2.1 → 0.3.0 |
| `patch` | Bug fixes, refactors, docs, CI, dependency updates   | 0.2.1 → 0.2.2 |

- **No major bumps** — the leading `0` stays until the project leaves alpha.
- Default to `patch` unless the session introduced something a user would notice
  as new functionality.
- Ask the user which bump to apply. Suggest the appropriate default based on
  the commits since the last tag.

### Version Files (must stay in sync)

| File                          | Field       |
|-------------------------------|-------------|
| `src-tauri/Cargo.toml`       | `version`   |
| `package.json`               | `"version"` |
| `src-tauri/tauri.conf.json`  | `"version"` |

After bumping, run `cargo check` in `src-tauri/` so `Cargo.lock` picks up the
new version.

## Commit Message Rules

FlexMap uses **Conventional Commits**:

```
<type>(<scope>): <short summary>
```

### Types

| Type       | Meaning                                      |
|------------|----------------------------------------------|
| `feat`     | New user-facing feature                      |
| `fix`      | Bug fix                                      |
| `refactor` | Code restructuring, no behavior change       |
| `perf`     | Performance improvement                      |
| `chore`    | Config, deps, CI, tooling, release housework |
| `docs`     | Documentation only                           |

### Rules
- **Scope is optional** but encouraged when the change is localized
  (e.g., `fix(syphon):`, `feat(shader):`).
- **Summary** is imperative, lowercase, no period, under 72 chars.
- The release commit itself uses: `chore: release v0.x.y`

## Workflow

Run these steps in order. Stop and report if any step fails.

### Step 1 — Check CI

The `release-build.yml` workflow only triggers on `release` events or manual
dispatch — it does not run on every push. So checking CI here means checking
whether the *most recent* run (if any) passed, not expecting a run for HEAD.

```bash
gh run list --workflow=release-build.yml --limit 3 --json status,conclusion,name,headSha,createdAt
```

- If the latest run **failed**, warn the user and ask if they want to continue
  anyway (the failure may be unrelated to current changes).
- If there are **no runs at all**, that's normal — just note it and move on.
  The local build check in Step 3 is the real gate.
- If the latest run **passed**, report it as a green signal.

### Step 2 — Guard: Clean Working Tree

```bash
git status --porcelain
```

If there are uncommitted changes (ignoring `.claude/` which is gitignored),
stop and ask the user to commit or stash first. The version-bump commit should
be isolated so it can be tagged cleanly.

### Step 3 — Local Build Check

Run both builds to catch issues before bumping:

```bash
cd src-tauri && cargo build
```
```bash
npm run build
```

Both must succeed. If either fails, stop and report the error.

### Step 4 — Determine Version Bump

First, detect the current state:

```bash
git describe --tags --abbrev=0          # latest tag, e.g. v0.2.0
node -p "require('./package.json').version"  # version in files, e.g. 0.2.1
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

**If the version in files is already ahead of the latest tag**, the bump was
done in a previous session but never tagged. Ask the user:
> "Version is already 0.2.1 but the latest tag is v0.2.0. Do you want to
> finalize 0.2.1 (skip the bump and go straight to changelog + tag), or
> bump again to 0.2.2?"

**Otherwise**, analyze the commits since the last tag:
- If any are `feat:` → suggest **minor**
- If all are `fix:`, `refactor:`, `chore:`, `perf:`, `docs:` → suggest **patch**

Present the suggestion and the commit list to the user. Let them confirm or
override.

### Step 5 — Bump Version

Skip this step if the user chose to finalize an existing bump (version files
are already ahead of the tag).

Otherwise, calculate the new version from the current one and the chosen bump
type. Update all three files:
1. `src-tauri/Cargo.toml` — the `version = "..."` line under `[package]`
2. `package.json` — the `"version": "..."` field
3. `src-tauri/tauri.conf.json` — the `"version": "..."` field

Then sync the Rust lockfile:

```bash
cd src-tauri && cargo check
```

### Step 6 — Write Changelog

Gather all commits since the last tag:

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

Then read `CHANGELOG.md` and check whether a section for the target version
already exists (e.g., `## [0.2.1]`).

**If a section already exists**, the version was bumped in a previous session
and some entries were already written. Compare the existing bullets against
the full commit list:
- Identify commits not yet covered by any bullet.
- If all commits are already covered, tell the user the changelog is up to date
  and skip to Step 7.
- If there are new commits, draft additional bullets and show them to the user.
  Merge them into the existing section (append to the right category) rather
  than creating a duplicate section.

**If no section exists**, create a new one from scratch.

**Denoising rules** — the changelog is for humans reading release notes,
not a git log dump:

1. **Group by category**: `### Added`, `### Changed`, `### Fixed`
   (only include categories that have entries).
2. **Merge related commits**: if three commits all fix the same subsystem,
   combine them into one bullet.
3. **Drop noise**: pure refactors, CI tweaks, typo fixes, and dependency bumps
   that don't affect users can be omitted or summarized as one line.
4. **Write for users**: describe *what changed* from the user's perspective,
   not implementation details. "Fixed crash when opening projector on second
   display" is better than "fix(projector): guard against nil surface".
5. **Bold the topic** at the start of each bullet, matching existing style
   (e.g., `- **Shader preview**: fixed compile errors for ISF shaders`).

New section format (insert below the header, above the previous version):
```markdown
## [0.x.y] - YYYY-MM-DD

### Added
- **Topic**: description

### Fixed
- **Topic**: description

---
```

Bottom of the file — add/update the comparison link:
```markdown
[0.x.y]: https://github.com/FlexusDev/flexmap/compare/v<previous>...v0.x.y
```

Show the draft changelog to the user and let them approve or edit before
committing.

### Step 7 — Commit and Tag

Stage the changed files and commit:

```bash
git add src-tauri/Cargo.toml package.json src-tauri/tauri.conf.json \
        src-tauri/Cargo.lock CHANGELOG.md
git commit -m "chore: release v0.x.y"
git tag v0.x.y
```

### Step 8 — Push (ask first)

Ask the user if they want to push now:

```bash
git push origin master --follow-tags
```

If they also want a GitHub release, run:

```bash
gh release create v0.x.y --title "v0.x.y" \
  --notes "FlexMap 0.x.y — see CHANGELOG.md for details."
```

This triggers the `release-build.yml` workflow which builds macOS + Windows
portable artifacts automatically.

## Error Recovery

- **CI failed**: Report which workflow failed and link to it. Do not proceed.
- **Build failed**: Show the error output. Do not proceed.
- **Dirty tree**: List the uncommitted files and suggest committing or stashing.
- **User cancels at any step**: Nothing destructive happens until Step 7. The
  user can re-run the skill later.

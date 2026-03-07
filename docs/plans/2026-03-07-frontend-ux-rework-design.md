# Frontend UX Rework Design

## Goals

1. Point selection + arrow key nudge for individual corners
2. Context-aware properties panel (less clutter, better discoverability)
3. Coordinate HUD + alignment guides on canvas
4. Magnifier mode for precision work on small screens
5. Purpose-built controls (blend mode picker, better sliders, compact fields)

## 1. Point Selection & Arrow Key Nudge

**State:** New `selectedPointIndex: number | null` in store. Clears on layer change, delete, Escape, or background click.

**Behavior:**
- Click a corner point to select it. One point at a time.
- Arrow keys nudge selected point by 0.5% (Shift = 0.1%).
- If no point selected but layer selected, arrow keys nudge whole layer (existing behavior).
- Point selection persists across Shape/UV mode toggle.

**Visuals:**
- Unselected: indigo circle outline (current)
- Hovered: lighter fill (current)
- Selected: solid white fill + indigo ring + subtle glow

## 2. Context-Aware Properties Panel

Replace 4 panes with 2 sections.

### "Layer" section (always visible)
- Source: compact pill (icon + name), click for popover grouped by protocol
- Blend mode: visual tile picker (2-col grid, color-coded by category), opens as popover
- Opacity slider: always visible
- Visibility + Lock toggles inline
- "Advanced Look" accordion (collapsed by default): Brightness, Contrast, Gamma, Feather, Beat Reactivity

### "Edit" section (context-dependent)

**Shape mode, no point selected:**
- Geometry type + point count
- Center position X/Y (pixels, editable)
- Rotation + Scale (compact row)
- Subdivide button (mesh only)

**Shape mode, point selected:**
- "Point 3 of 4" label
- Point X/Y (normalized, editable)
- Snap toggle inline

**UV/Input mode:**
- Input transform: offset X/Y, rotation, scale X/Y
- Reset button
- Per-face UV controls (mesh + faces selected only)

### Removed
- Joystick (replaced by magnifier + coordinate HUD)
- Geometry Transform relative/apply section (replaced by arrow keys + direct position fields)

## 3. Coordinate HUD & Alignment Guides

### HUD
- Floating tooltip near cursor during drag/nudge
- Dragging point: `x: 0.342  y: 0.518` (normalized)
- Dragging layer: `dx: +12px  dy: -8px` (delta)
- Dark semi-transparent pill, monospace, disappears ~500ms after interaction

### Alignment Guides
- Thin dashed cyan lines when point/edge aligns with another layer's point/edge
- Horizontal and vertical only
- Triggers within 2% threshold (tighter than snap grid for precision)
- Visual only (snap-to-grid controls actual locking)
- Only checks visible, non-locked layers

### Not doing
- Distribution guides, angle guides, input-mode guides

## 4. Magnifier Mode

- Toggle: `Z` key (tap on/off)
- 150px diameter circular lens, 3x zoom, follows cursor
- Interaction works through the magnifier (click/drag points while active)
- Visual: 1px indigo border, drop shadow, crosshair at center
- Status bar: "MAGNIFIER" badge when active
- Keyboard overlay: `Z` = "Toggle Magnifier"

## 5. Purpose-Built Controls

### Blend Mode Picker
- 2-column tile grid in popover
- Color-coded by category (darken=warm, lighten=cool, contrast=neutral, math=accent)
- Selected tile gets indigo ring

### Sliders
- Filled track (indigo) from left to value
- Inline value display at right
- Click value to type precise number
- Drag anywhere on track
- Compact height

### Source Dropdown
- Compact pill: protocol icon + name
- Popover with full list grouped by protocol
- Resolution as secondary text

### Numeric Fields
- Inline inputs with vertical drag-to-scrub
- Labels left of field (not above) to save vertical space

# Pixel Mapping Effect (Future Feature)

Inspired by DasLight 5 "mappings" feature.

## Concept

A shader-driven modulation mask applied to projected video content.

1. Select a shape (layer) or group of shapes
2. Apply a B&W pattern shader (stripes, chase, gradient, wave, etc.)
3. B&W value at each pixel modulates the video output:
   - White = full value, Black = zero
4. User selects what parameter the B&W controls (brightness, opacity, contrast, etc.)

## Key Requirements

- **Layer grouping**: multiple shapes share one modulation effect applied across them as a unit
- **B&W pattern shaders**: library of pattern generators (chase, gradient, wave, strobe, etc.)
- **Parameter binding**: user picks which video property the pattern drives
- **Per-shape and per-group**: works on single layers or grouped layers

## Notes

- This is NOT DMX/fixture pixel mapping — it modulates the projected video within FlexMap
- Unrelated to per-face UV overrides, face masking, or face groups (those operate on mesh cells within a single layer; this operates on whole layers/groups)
- Will need its own data model: layer groups, effect assignments, parameter bindings

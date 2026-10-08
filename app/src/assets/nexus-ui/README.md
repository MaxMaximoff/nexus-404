# NEXUS-404: shared hybrid pad system — stage 1

Open `http://localhost:5173/?demo`, then select A5. All occupied and empty pads in every bank now share the approved raster materials. `?demo&graphics=hybrid` also retains the existing inspector experiment; no panels were migrated in this stage.

The original three-component proof of concept is preserved in checkpoint `b07b226` on branch `codex/hybrid-pad-grid`. Its 166 tests passed before integration. Before/after screenshots use the same demo project, A5, the Sample tab, viewport and browser scale at 1440 × 900 and 1920 × 1080.

## Scope and layers

| Component | Raster material | Vector detail | Live content |
| --- | --- | --- | --- |
| All occupied pads | `pads/pad-light.webp` | `lighting/pad-emitter.svg` | Existing button, sample name, BPM, duration and badges |
| All empty pads | `pads/pad-graphite.webp` | Existing selection outline | Existing button, pad number and plus sign |
| Inspector (existing opt-in study) | `panels/panel-light.webp` | `details/panel-corners.svg` | Existing tabs, inputs, waveform, scroll area and transport |

The standard `.pad`, `.full`, `.empty`, `.selected`, `.picked` and `.drop*` rules in `src/ui/styles.css` provide the shared system. Pad-specific A5/A11 overrides were removed from `hybrid.css`. There is no parallel pad theme or duplicate asset per pad. No component contract, device, store, waveform, bank, pattern, import, keyboard, selection or drag handler changed during this integration.

Three independent transparent materials were created with the built-in `image_gen` tool, using the supplied render as a style reference. They contain no text, numbers, icons or controls. Full generation prompts are in `prompts.json`.

No image or SVG was regenerated or modified during stage 1; Git comparison against the checkpoint confirms all five graphic files are unchanged.

The final WebP files are 1024 × 1024 with alpha, encoded at quality 90 / alpha quality 100. Their combined size is 217,400 bytes (about 212 KiB). Both SVG files are small and are inlined by Vite. No runtime dependency was added.

## Scaling and states

`src/ui/styles.css` uses `border-image` with a filled center and 100 px source slices for pads. Painted corners stay 12 px; the layout border remains 1 px. This preserves the approved A5 geometry and original hit areas. The existing inspector study keeps its 96 px slices and 20 px painted corners in `hybrid.css`. SVG edge details use a separate nine-slice overlay with `pointer-events: none`.

CSS supplies selection, hover, pressed, focus and group-selection states; text and values remain real HTML. Occupied pads use SVG opacity .32 normally, .85 on hover, and 1 when selected. Selected pads retain the exact A5 halo from the checkpoint. Reduced-motion preferences disable transitions. Existing drag-operation outlines retain their priority; swap targets suppress the cyan emitter even on hover, keeping their orange cue distinct. Copy/swap operation labels remain visible and their corner badges are hidden as before. Loading progress remains live HTML. Offline pads retain the connection overlay, hidden labels and small status indicator, now on the shared graphite material.

Pad skins are included in the normal stylesheet and add 128,986 bytes (about 126 KiB) of shared WebP resources. Only the inspector study is dynamically imported with `graphics=hybrid`. All raster resources are shared URLs rather than separate copies for every pad.

## Verification

- Production build and TypeScript check passed.
- Existing test suite: 166 tests passed (`npm test -- --testTimeout=20000`).
- Stage 1 browser checks: 1440 × 900 and 1920 × 1080, plus 390 × 844.
- No horizontal page overflow at those widths. Corners and material remain usable across the tested sizes.
- Occupied/empty selection, group selection, keyboard selection and bank switching were exercised in demo mode; badges remain HTML.
- On narrow screens the existing compact badge row uses tighter spacing so mute, pattern and link badges fit together inside a pad without changing its size or the four-column grid.
- The disconnected view retains its message and actions; a wider light veil keeps the connection message readable over the newly shared dark empty-pad skin.
- A temporary CSS state fixture checked normal, selected, empty, picked, hovered swap, copy, move, loading and keyboard focus. It is not shipped with the app. This validates visual states, not the device transfer operation.
- A5 dimensions and selected halo match the checkpoint: 159.078 × 112 px at 1440 width and 166.281 × 112 px at 1920 width. Fractional grid rounding produces at most 0.016 px width difference between columns, as before.
- Hardware communication and physical-device transfers were not exercised. No continuous held-pointer capture of `:active` was performed. Existing invalid-target handling was not modified; it has no dedicated visual class.

## Visual assessment and limits

The grid now consistently shares A5's white/cyan reflections and the approved graphite material. Normal pads have quieter emitter intensity and no outer selection halo. No nine-slice seams were apparent at the tested sizes. The inspector is unchanged from the earlier experiment.

This is not a pixel-accurate reproduction of the full reference. The existing maximum app width, pad proportions, waveform height, typography and most control surfaces are unchanged. The generated material still has several fine rim reflections, and its broad illumination stretches with the center region. Extreme aspect ratios and arbitrary display scales beyond the checked sizes need further visual review.

Stage 2 (bank panel, grid panel, inspector sections, header and service panels) was deliberately not started. The complete pad grid is ready for visual review before any further integration.

# NEXUS-404: hybrid graphics proof of concept

Open `http://localhost:5173/?demo&graphics=hybrid`, then select A5.
Use `?demo` for the existing CSS version. The experiment is opt-in and deliberately stops at three components, as requested in the hybrid specification.

## Scope and layers

| Component | Raster material | Vector detail | Live content |
| --- | --- | --- | --- |
| Occupied A5 | `pads/pad-light.webp` | `lighting/pad-emitter.svg` | Existing button, sample name, BPM, duration and badges |
| Empty A11 | `pads/pad-graphite.webp` | Existing selection outline | Existing button, pad number and plus sign |
| Inspector | `panels/panel-light.webp` | `details/panel-corners.svg` | Existing tabs, inputs, waveform, scroll area and transport |

The other pads remain unchanged for comparison. The inspector's inner cards retain HTML/CSS and use a quieter translucent fill. No device, store, waveform or drag handlers were changed by this experiment.

Three independent transparent materials were created with the built-in `image_gen` tool, using the supplied render as a style reference. They contain no text, numbers, icons or controls. Full generation prompts are in `prompts.json`.

The final WebP files are 1024 × 1024 with alpha, encoded at quality 90 / alpha quality 100. Their combined size is 217,400 bytes (about 212 KiB). Both SVG files are small and are inlined by Vite. No runtime dependency was added.

## Scaling and states

`src/ui/hybrid.css` uses `border-image` with a filled center. Source slices are 100 px for pads and 96 px for the inspector. Painted corners stay 12 px and 20 px respectively; the layout border remains 1 px. This keeps the original hit areas and layout dimensions. SVG edge details use a separate nine-slice overlay with `pointer-events: none`.

CSS supplies selection, hover, pressed, focus and group-selection states; text and values remain real HTML. Selected A5 raises SVG opacity and adds a small cyan halo. Reduced-motion preferences disable transitions. Existing drag-operation outlines retain their priority.

The CSS is dynamically imported only when `graphics=hybrid`. The standard build entry does not link the hybrid stylesheet. All raster resources are shared URLs rather than separate copies for every pad.

## Verification

- Production build and TypeScript check passed.
- Existing test suite: 166 tests passed (`npm test -- --testTimeout=20000`).
- Browser checked at 390 × 844, 760 × 900, 1280 × 720 and 1774 × 887.
- No horizontal page overflow at those widths. Corners and material remain usable across the tested sizes.
- Occupied/empty selection, keyboard selection, inspector tabs and scrolling were exercised in demo mode.
- A5 layout bounds match the default mode; its existing `draggable` attribute remains present.
- Hardware communication and physical-device drag operations were not exercised. Hover/pressed rules are implemented; no continuous held-pointer capture was performed.

## Visual assessment and limits

A5 has more nuanced white/cyan reflections and a thinner luminous edge than the CSS-only neighboring pads. A11 has a smoother graphite surface. The inspector's material supplies local cyan bounce without embedding its controls into a screenshot. No nine-slice seams were apparent at the tested sizes.

This is not a pixel-accurate reproduction of the full reference. The existing maximum app width, pad proportions, waveform height, typography and most control surfaces are unchanged. The generated material still has several fine rim reflections, and its broad illumination stretches with the center region. Extreme aspect ratios and arbitrary display scales beyond the checked sizes need further visual review.

The approach is worth extending for material surfaces, provided the component geometry is agreed first. Reuse these few materials, then refine the shared vector contours; generating many state-specific bitmaps is unnecessary. A full migration is outside this experiment.

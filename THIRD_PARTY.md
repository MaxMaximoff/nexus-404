# Analysis dependencies

Third-party analysis code in the application. Everything else in `app/src` is our own.

| Tool | Pinned package | Declared license | Use |
|---|---|---|---|
| [Essentia.js](https://github.com/MTG/essentia.js) | `essentia.js@0.1.3` | AGPL-3.0 | Slicer: the track's key (tonic, major/minor) — `KeyExtractor`, EDMA profile, 36-bin HPCP; no ML model weights |

Essentia is pinned in `app/package-lock.json`. Only the analysis worker loads it (`app/src/sp404/essentiaKey.ts`, dynamic import from `app/src/ui/gridWorker.ts`), on the first key asked for; the build puts it in chunks of its own (`essentia-wasm.es-*.js` ≈ 2.5 MB with the WASM inlined, `essentia.js-core.es-*.js`). The browser ES modules are imported directly; the package's `node-wav@0.0.2` dependency (MIT) is installed but not bundled.

**License:** Nexus-404 as a whole is under the GNU AGPL-3.0 (`LICENSE`), since Essentia (AGPL-3.0) is in the bundle. The app offers its source: "Source" in the header and the footer link to the commit the build was made from (`__SOURCE_COMMIT__`, set by `app/vite.config.ts`; `npm run ship` builds only from committed source). Next to the build: `LICENSE.txt` and `THIRD-PARTY-LICENSES.txt` — the license texts of every runtime package in `package-lock.json` (Essentia.js AGPL-3.0; Preact, @preact/signals MIT; Inter and IBM Plex Mono fonts OFL-1.1; node-wav MIT, installed with Essentia but not bundled). Deployment: `DEPLOY.md`.

Essentia's own source: https://github.com/MTG/essentia.js (the package `essentia.js@0.1.3` on npm). Before this change the key was found by our own detector (commit `997667e`, `app/src/sp404/key.ts`).

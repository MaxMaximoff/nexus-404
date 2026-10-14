# Nexus-404

Browser-only sample uploader for the Roland SP-404MKII: Chrome or Edge on a desktop, no install.
The interface, tooltips, confirmations and operation messages are in English.
It talks to the unit over Web Serial (its CDC-ACM port, USB `0582:02E7`). Protocol notes and
hardware test results: `../SP404MKII-browser-feasibility.md`.

```bash
npm install
npm run dev      # http://localhost:5173/nexus-404/ (no hot reload: press F5 after edits)
npm test         # protocol codecs, guard, import against a scripted SP
npm run build    # static files in dist/, serve over HTTPS
npm run ship     # build + stage dist/ for deployment through Git
```

Timeweb deployment: [../DEPLOY.md](../DEPLOY.md). Production URL:
https://soundplayground.twc1.net/nexus-404/.

Close the official SP-404MKII App first: only one program can open the port.

Slicer's **Export loops** panel has three destinations: **SD card**, **Pads**, or **Both**.
Only checked loops are exported; unchecked rows stay available for listening. The count, size
and pad preview follow this selection, and filenames retain the original loop numbers.
Each exported loop mixes the audible stems, following stem/group Mute and Solo, stem
volume and per-loop volume; stems with No group are included. Files use
`<name>_<number>_<bpm>bpm.wav` in a new `IMPORT/<name>/`
folder, numbered if already present. Pads are assigned in order from the selected starting pad,
skipping occupied pads and protected banks. Both validates pad capacity before writing, then
writes the full set to the card and assigns it to pads; a failed or stopped card write prevents
pad assignment. Current-loop export remains in the backend for a later UI, without a visible
selector or per-loop export button for now.

Pad sample names include the loop length: `<name>_<number>_<bars>bars_<bpm>bpm`.
Pad exports set Gate off, BPM Sync on, Vinyl off and VARI MODE Ensemble. **Create patterns**
adds one pattern in the same slot as each sample (B1 → B1), with one full-velocity trigger
at the start and the loop's length/time signature. The editor and saving support up to
64 bars. With this option, occupied pattern slots and browser drafts are also skipped.
On a connected SP, record one reference pattern in the project and refresh it first;
its verified file supplies the pattern skeleton. All new patterns are transferred as
one batch, the project is reloaded once, and files are checked again after reload.

License: GNU AGPL-3.0 ([../LICENSE](../LICENSE)); third-party code: [../THIRD_PARTY.md](../THIRD_PARTY.md).
The app links to the source of the very build it is (header "Source", page footer), so deploy
only through `npm run ship` from committed source.

`src/sp404/` is the protocol library (`SP404Device`, `WebSerialTransport`, `SampleUploader`, SMP and
audio helpers). Every outgoing message passes `guard.ts`, which only lets through reads, preview,
pad selection, set-BPM and the import sequence for the pad being imported; Init, delete, move and
renames cannot be sent. Imports go to empty pads only.

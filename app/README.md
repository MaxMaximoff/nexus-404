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

`src/sp404/` is the protocol library (`SP404Device`, `WebSerialTransport`, `SampleUploader`, SMP and
audio helpers). Every outgoing message passes `guard.ts`, which only lets through reads, preview,
pad selection, set-BPM and the import sequence for the pad being imported; Init, delete, move and
renames cannot be sent. Imports go to empty pads only.

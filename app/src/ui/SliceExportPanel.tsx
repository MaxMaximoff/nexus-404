import { BANKS, padName, trackName } from "../sp404";
import { cancelWrite, slBusy, slLoops } from "./slice";
import { exportBlock, exportBytes, exportCount, exportFileName, exportFolder, exportLoops, exportMakePatterns, exportPadCells, exportRunning, exportStartPad, exportTarget, runExport } from "./sliceExport";
import { pads, patterns } from "./store";
import { drafts } from "./patternDraft";
import { IconUpload } from "./icons";

export function ExportPanel() {
  const target = exportTarget.value, working = exportRunning.value || !!slBusy.value;
  const loops = exportLoops.value, count = exportCount.value, block = exportBlock.value, start = exportStartPad.value;
  const at = new Map((exportPadCells.value ?? []).map((cell) => [cell.pad, slLoops.value.findIndex((loop) => loop.bar === loops[cell.loop]?.bar) + 1]));
  const banks = [...new Set((exportPadCells.value ?? []).map((cell) => cell.pad >> 4))];
  return (
    <div class="sl-groups sl-export-panel" aria-label="Export selected loops">
      <div class="sl-groups-head"><b>Export loops</b><span class="muted small">Checked loops only · Solo, Mute and all volumes applied</span></div>
      <div class="sl-bar">
        <span class="muted">Assign to pads</span>
        <span class="segmented" role="group" aria-label="Assign to pads">
          <button type="button" disabled={working} class={target === "card" ? "on" : ""} aria-pressed={target === "card"} onClick={() => (exportTarget.value = "card")}>SD card</button>
          <button type="button" disabled={working} class={target === "pads" ? "on" : ""} aria-pressed={target === "pads"} onClick={() => (exportTarget.value = "pads")}>Pads</button>
          <button type="button" disabled={working} class={target === "both" ? "on" : ""} aria-pressed={target === "both"} onClick={() => (exportTarget.value = "both")}>Both</button>
        </span>
        <label class="sl-field"><span class="muted">{target === "pads" ? "Name" : "Folder"}</span>
          <input class="value-field sl-export-folder" disabled={working} type="text" spellcheck={false} maxLength={32} value={exportFolder.value}
            aria-label="Export name" onInput={(e) => (exportFolder.value = (e.target as HTMLInputElement).value)} />
        </label>
        {target !== "card" && <>
          <label class="sl-field"><span class="muted">From bank</span>
            <select disabled={working} value={start >> 4} onChange={(e) => (exportStartPad.value = +(e.target as HTMLSelectElement).value * 16 + start % 16)}>
              {[...BANKS].map((bank, i) => <option key={bank} value={i}>{bank}</option>)}
            </select>
          </label>
          <label class="sl-field"><span class="muted">Pad</span>
            <select disabled={working} value={start % 16} onChange={(e) => (exportStartPad.value = (start >> 4) * 16 + +(e.target as HTMLSelectElement).value)}>
              {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
            </select>
          </label>
          <label class="sl-check"><input type="checkbox" disabled={working} checked={exportMakePatterns.value}
            onChange={(e) => (exportMakePatterns.value = (e.target as HTMLInputElement).checked)} /> Create patterns</label>
        </>}
      </div>
      {target !== "card" && <div class="muted small sl-export-file-preview">
        {loops.length > 0 && <code>{exportFileName(loops[0]!, "pads").replace(/\.wav$/, "")}</code>}
        <span>Gate off · BPM Sync on · Vinyl off · Ensemble</span>
        {exportMakePatterns.value && <span>Sample → same pattern slot · loop length · up to 64 bars · occupied patterns skipped</span>}
      </div>}
      {!working && target !== "pads" && loops.length > 0 && <div class="sl-export-file-preview"><code>IMPORT/{trackName(exportFolder.value)}/{exportFileName(loops[0]!)}</code><span class="muted">New folder, numbered if already present</span></div>}
      {!working && target !== "card" && banks.length > 0 && <div class="sl-maps sl-export-pad-map" aria-label="Loop pad layout preview">
        {banks.map((bank) => <div key={bank} class="sl-map"><span class="sl-map-bank">{BANKS[bank]}</span>
          <div class="sl-map-grid">{Array.from({ length: 16 }, (_, i) => {
            const pad = bank * 16 + i, number = at.get(pad), full = !!pads.value[pad]?.size || (exportMakePatterns.value && (!!patterns.value?.has(pad) || drafts.value.has(pad)));
            return <i key={pad} class={`${number ? "on" : ""} ${full ? "full" : ""}`} title={`${padName(pad)}: ${number ? `loop ${number}${exportMakePatterns.value ? ` → pattern ${padName(pad)}` : ""}` : full ? "occupied — skipped" : "unused"}`}>{number ?? ""}</i>;
          })}</div>
        </div>)}
      </div>}
      <div class="sl-write">
        {working ? <>
          <div class="sl-progress" role="progressbar" aria-valuenow={Math.round((slBusy.value?.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${(slBusy.value?.progress ?? 0) * 100}%` }} /></div>
          <span class="small sl-write-text">{slBusy.value?.text ?? "Preparing export…"}</span><button class="btn btn-stop" onClick={cancelWrite}>Stop</button>
        </> : <>
          <span class={`small sl-write-text ${block ? "muted" : ""}`} title={block ?? undefined}>{block ?? <><b>{count}</b> loop{count === 1 ? "" : "s"} · {(exportBytes.value / 1048576).toFixed(1)} MB{target === "both" ? " → SD card + pads" : ""}</>}</span>
          <button type="button" class="btn btn-primary" disabled={!!block} title={block ?? "Export checked loops"} onClick={() => void runExport()}><IconUpload /> Export {count} loops</button>
        </>}
      </div>
    </div>
  );
}

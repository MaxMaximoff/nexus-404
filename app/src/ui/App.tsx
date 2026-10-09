import { BankRail } from "./BankRail";
import { ImportPanel, LogPanel } from "./BottomPanels";
import { Inspector } from "./Inspector";
import { CardBrowser } from "./CardBrowser";
import { Recorder } from "./Recorder";
import { canUploadHere, cardBusy, cardConfirm, cardEdit, cardSel, sideTab } from "./card";
import { PadGrid } from "./PadGrid";
import { PatternsPane, mainView } from "./Patterns";
import { editingSlot } from "./patternDraft";
import { TopBar } from "./TopBar";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { dragCopy, draggedPad, groupDrop, clearPicked, confirmDelete, confirmGroupDelete, groupProgress, notice, pads, pickBank, pickedList, selectedBank, selectedPad, writeBlockReason } from "./store";
import { IconX } from "./icons";

export function App() {
  const n = notice.value, ptn = mainView.value === "patterns";
  // The patterns take the whole width: the pad inspector steps aside (the SD card and the recorder stay when picked).
  const solo = ptn && sideTab.value === "pad";
  // While the pads and the patterns trade width, the slots clip their content (not otherwise: pad glows reach out).
  const [switching, setSwitching] = useState(false), lastPtn = useRef(ptn);
  useLayoutEffect(() => {
    if (lastPtn.current === ptn) return;
    lastPtn.current = ptn;
    setSwitching(true);
    const t = setTimeout(() => setSwitching(false), 520);
    return () => clearTimeout(t);
  }, [ptn]);
  useEffect(() => {
    // Delete on the selected pad asks for confirmation in the inspector (not while typing in a field).
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      // On the patterns screen the pad inspector is hidden, so its Delete confirmation would be invisible; while a pattern is edited the keys are the editor's.
      if (mainView.value === "patterns" && (editingSlot.value !== null || sideTab.value !== "card")) return;
      if (sideTab.value === "card" && (e.key === "Delete" || e.key === "Escape" || e.key === "F2")) {
        // The card browser is shown: Delete / Esc act on the files picked there, not on pads.
        if (e.key === "Delete" && cardSel.value.size && canUploadHere.value && !cardBusy.value) cardConfirm.value = true;
        else if (e.key === "F2" && cardSel.value.size === 1 && canUploadHere.value && !cardBusy.value) { e.preventDefault(); cardEdit.value = { kind: "rename", name: [...cardSel.value][0] }; }
        else if (e.key === "Escape") { if (cardConfirm.value) cardConfirm.value = false; else cardSel.value = new Set(); }
        return;
      }
      if (e.key === "Delete" && !writeBlockReason.value && !groupProgress.value) {
        if (pickedList.value.length) confirmGroupDelete.value = true;
        else if (pads.value[selectedPad.value]?.size) confirmDelete.value = selectedPad.value;
      } else if (e.key === "Escape") {
        if (confirmDelete.value !== null || confirmGroupDelete.value) { confirmDelete.value = null; confirmGroupDelete.value = false; }
        else clearPicked();
      } else if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        pickBank(selectedBank.value);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return (
    <div
      class="app"
      // Files dropped outside a pad must not make the browser navigate away to them.
      onDragOver={(e) => {
        e.preventDefault();
        if (draggedPad.value !== null && dragCopy.value !== e.ctrlKey) dragCopy.value = e.ctrlKey; // Ctrl: copy instead of move
        if (groupDrop.value && !(e.target as Element).closest?.(".pad, .bank-tile")) groupDrop.value = null;
      }}
      onDrop={(e) => e.preventDefault()}
    >
      {/* The first screen: top bar and the work area fill the window; import and log are below it. */}
      <div class="screen">
        <TopBar />
        {n && (
          <div class={`notice notice-${n.kind} glass`} role={n.kind === "error" ? "alert" : "status"}>
            <span>{n.text}</span>
            <button class="icon-btn" onClick={() => (notice.value = null)} aria-label="Close"><IconX /></button>
          </div>
        )}
        <main class={`layout ${ptn ? "layout-ptn" : ""} ${solo ? "layout-solo" : ""} ${switching ? "switching" : ""}`}>
          {/* Both blocks stay mounted: switching view only moves their widths. The hidden one is inert and collapses. */}
          <div class="workspace slot" inert={ptn} aria-hidden={ptn}>
            <BankRail /><PadGrid />
          </div>
          <div class="ptn-col slot" inert={!ptn} aria-hidden={!ptn}>
            <PatternsPane />
          </div>
          {sideTab.value === "card" ? <CardBrowser /> : sideTab.value === "rec" ? <Recorder /> : (
            <div class="side slot" inert={solo} aria-hidden={solo}><Inspector /></div>
          )}
        </main>
      </div>
      <div class="bottom">
        <ImportPanel />
        <LogPanel />
      </div>
    </div>
  );
}

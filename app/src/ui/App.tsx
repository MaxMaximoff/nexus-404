import { BankRail } from "./BankRail";
import { ImportPanel, LogPanel } from "./BottomPanels";
import { Inspector } from "./Inspector";
import { PadGrid } from "./PadGrid";
import { TopBar } from "./TopBar";
import { useEffect } from "preact/hooks";
import { dragCopy, draggedPad, groupDrop, clearPicked, confirmDelete, confirmGroupDelete, groupProgress, notice, pads, pickBank, pickedList, selectedBank, selectedPad, writeBlockReason } from "./store";
import { IconX } from "./icons";

export function App() {
  const n = notice.value;
  useEffect(() => {
    // Delete on the selected pad asks for confirmation in the inspector (not while typing in a field).
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
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
      <TopBar />
      {n && (
        <div class={`notice notice-${n.kind} glass`} role={n.kind === "error" ? "alert" : "status"}>
          <span>{n.text}</span>
          <button class="icon-btn" onClick={() => (notice.value = null)} aria-label="Закрыть"><IconX /></button>
        </div>
      )}
      <main class="layout">
        <div class="workspace">
          <BankRail />
          <PadGrid />
        </div>
        <Inspector />
      </main>
      <div class="bottom">
        <ImportPanel />
        <LogPanel />
      </div>
    </div>
  );
}

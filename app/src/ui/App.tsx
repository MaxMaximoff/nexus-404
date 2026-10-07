import { BankRail } from "./BankRail";
import { ImportPanel, LogPanel } from "./BottomPanels";
import { Inspector } from "./Inspector";
import { PadGrid } from "./PadGrid";
import { TopBar } from "./TopBar";
import { notice } from "./store";
import { IconX } from "./icons";

export function App() {
  const n = notice.value;
  return (
    <div
      class="app"
      // Files dropped outside a pad must not make the browser navigate away to them.
      onDragOver={(e) => e.preventDefault()}
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

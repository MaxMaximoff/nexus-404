import { BANKS, formatBpm } from "../sp404";
import { PAD_DRAG, pads, project, selectPad, selectedBank, selectedPad, status } from "./store";
import { IconLock } from "./icons";

/** While a pad is dragged, resting on a bank shows that bank's pads, so a pad can move across banks. */
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
function dragHover(e: DragEvent, bank: number): void {
  if (!e.dataTransfer?.types.includes(PAD_DRAG) || selectedBank.value === bank || hoverTimer) return;
  hoverTimer = setTimeout(() => { hoverTimer = null; selectedBank.value = bank; }, 450);
}
function dragAway(): void {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = null;
}

export function BankRail() {
  const ps = project.value;
  const all = pads.value;
  return (
    <nav class="bank-rail glass" aria-label="Банки">
      <div class="panel-title">Банки</div>
      <div class="bank-list">
        {[...BANKS].map((letter, b) => {
          const bank = ps?.banks[b];
          const filled = all.slice(b * 16, b * 16 + 16).filter((p) => p?.size).length;
          const deviceHere = status.value?.bank === b;
          return (
            <button
              key={letter}
              class={`bank-tile ${selectedBank.value === b ? "active" : ""}`}
              onClick={() => selectPad(b * 16 + (selectedPad.value & 15))} // the same pad of that bank, selected on the SP too
              onDragEnter={(e) => dragHover(e, b)}
              onDragLeave={dragAway}
              onDrop={dragAway}
              title={`Банк ${letter}: ${filled} из 16${bank?.protected ? ", защищён" : ""}`}
            >
              <span class="mini-grid">
                {Array.from({ length: 16 }, (_, i) => <i key={i} class={all[b * 16 + i]?.size ? "on" : ""} />)}
              </span>
              <span class="bank-meta">
                <span class="bank-letter">{letter}{deviceHere && <span class="here" title="Этот банк выбран на SP" />}</span>
                <span class="muted">{bank ? formatBpm(bank.tempoX100) : "—"}</span>
                {bank?.protected && <span class="lock" title="BANK Protect"><IconLock /></span>}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

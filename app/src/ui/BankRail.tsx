import { BANKS, formatBpm, padName } from "../sp404";
import { useState } from "preact/hooks";
import { PAD_DRAG, dragOverBank, draggedPad, firstEmptyPad, moveSpeedChange, movePad, pads, project, selectPad, selectedBank, selectedPad, status } from "./store";
import { IconLock } from "./icons";

/**
 * While a pad is dragged, resting on a bank shows that bank's pads, so a pad can move across banks.
 * Started from dragover, not dragenter: the tile has children, and moving onto one of them sends
 * the tile a dragleave, which must not count as leaving the bank.
 */
let hover: { bank: number; timer: ReturnType<typeof setTimeout> } | null = null;
function dragHover(e: DragEvent, bank: number): void {
  if (!e.dataTransfer?.types.includes(PAD_DRAG) || selectedBank.value === bank || hover?.bank === bank) return;
  dragAway();
  hover = { bank, timer: setTimeout(() => { hover = null; selectedBank.value = bank; }, 450) };
}
function dragAway(e?: DragEvent): void {
  if (e && (e.currentTarget as Node).contains(e.relatedTarget as Node | null)) return;
  if (hover) clearTimeout(hover.timer);
  hover = null;
}

export function BankRail() {
  const ps = project.value;
  const all = pads.value;
  const [dropOn, setDropOn] = useState<number | null>(null);
  const dragged = draggedPad.value;
  return (
    <nav class="bank-rail glass" aria-label="Банки">
      <div class="panel-title">Банки</div>
      <div class="bank-list">
        {[...BANKS].map((letter, b) => {
          const bank = ps?.banks[b];
          const filled = all.slice(b * 16, b * 16 + 16).filter((p) => p?.size).length;
          const deviceHere = status.value?.bank === b;
          // While a pad is dragged, another bank's tile takes it onto its first empty pad.
          const target = dragged !== null && dragged >> 4 !== b ? firstEmptyPad(b) : null;
          const speed = target !== null ? moveSpeedChange(dragged!, b) : null;
          const dragCls = dragged === null || dragged >> 4 === b ? "" : target === null ? "drop-full" : dropOn === b ? "drop-target drop" : "drop-target";
          return (
            <button
              key={letter}
              class={`bank-tile ${selectedBank.value === b ? "active" : ""} ${dragCls}`}
              onClick={() => selectPad(b * 16 + (selectedPad.value & 15))} // the same pad of that bank, selected on the SP too
              onDragOver={(e) => {
                dragHover(e, b);
                if (dragged !== null) dragOverBank.value = b;
                if (target === null) return;
                e.preventDefault();
                e.dataTransfer!.dropEffect = "move";
                setDropOn(b);
              }}
              onDragLeave={(e) => {
                dragAway(e);
                if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) { setDropOn(null); dragOverBank.value = null; }
              }}
              onDrop={(e) => {
                dragAway();
                setDropOn(null);
                const src = e.dataTransfer?.getData(PAD_DRAG);
                if (!src || target === null) return;
                e.preventDefault();
                void movePad(+src, target, true);
              }}
              title={target !== null ? `Бросьте сюда — pad ляжет на ${padName(target)} (свободно ${16 - filled} из 16)`
                : `Банк ${letter}: ${filled} из 16${bank?.protected ? ", защищён" : ""}`}
            >
              <span class="mini-grid">
                {Array.from({ length: 16 }, (_, i) => <i key={i} class={b * 16 + i === target ? "target" : all[b * 16 + i]?.size ? "on" : ""} />)}
              </span>
              <span class="bank-meta">
                <span class="bank-letter">{letter}{deviceHere && <span class="here" title="Этот банк выбран на SP" />}</span>
                {target !== null ? <span class="free">→ {padName(target)}{speed && <em> ×{speed.to.toFixed(2)}</em>}</span> : <span class="muted">{bank ? formatBpm(bank.tempoX100) : "—"}</span>}
                {bank?.protected && <span class="lock" title="BANK Protect"><IconLock /></span>}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

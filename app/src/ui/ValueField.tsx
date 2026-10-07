import { useEffect, useState } from "preact/hooks";
import { writeBlockReason } from "./store";

export type Parse = (text: string) => { value: number } | { error: string } | null;

/**
 * Inline number field that writes to the SP: Enter saves, Esc or leaving the field puts the saved
 * value back. `parse` turns the text into the value sent (or an error shown in red).
 */
export function ValueField({ value, format, parse, label, dim, hint, disabled, width = 64, placeholder, onSave }: {
  value: number; format: (v: number) => string; parse: Parse; label: string;
  dim?: boolean; hint?: string; disabled?: string | null; width?: number; placeholder?: string; onSave: (v: number) => Promise<boolean>;
}) {
  // NaN = no common value (several pads): the field starts empty and shows the placeholder.
  const saved = Number.isNaN(value) ? "" : format(value);
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(saved), [saved]);
  const blocked = writeBlockReason.value ?? disabled ?? null;
  const parsed = parse(text);
  const error = parsed && "error" in parsed ? parsed.error : null;

  const save = async () => {
    if (!parsed || !("value" in parsed) || parsed.value === value || blocked || busy) return;
    setBusy(true);
    if (!(await onSave(parsed.value))) setText(saved);
    setBusy(false);
  };

  return (
    <input
      class={`value-field ${dim ? "dim" : ""} ${error ? "invalid" : ""}`}
      style={{ width: `${width}px` }}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellcheck={false}
      aria-label={label}
      title={blocked ?? error ?? `${label}: Enter — сохранить на SP, Esc — отменить${hint ? `. ${hint}` : ""}`}
      disabled={!!blocked || busy}
      value={text}
      placeholder={placeholder}
      onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") { setText(saved); (e.target as HTMLInputElement).blur(); }
      }}
      onFocus={(e) => (e.target as HTMLInputElement).select()}
      onBlur={() => !busy && setText(saved)}
    />
  );
}

/** Integer in [min, max]; accepts a leading "+" and the Unicode minus. */
export const intIn = (min: number, max: number): Parse => (text) => {
  const t = text.trim().replace("−", "-").replace(/^\+/, "");
  if (!t) return null;
  if (!/^-?\d+$/.test(t)) return { error: "целое число" };
  const v = parseInt(t, 10);
  return v < min || v > max ? { error: `от ${min} до ${max}` } : { value: v };
};

/** Signed display: "+3", "0", "−12". */
export const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");

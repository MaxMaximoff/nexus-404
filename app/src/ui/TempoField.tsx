import { formatBpm, parseBpmInput } from "../sp404";
import { ValueField, type Parse } from "./ValueField";

const parseBpm: Parse = (text) => {
  const r = parseBpmInput(text);
  return r && "x100" in r ? { value: r.x100 } : r;
};

/** Inline BPM field (BPM × 100): Enter writes to the SP, Esc or leaving the field puts the saved value back. */
export function TempoField(props: { value: number; label: string; dim?: boolean; hint?: string; onSave: (x100: number) => Promise<boolean> }) {
  return <ValueField {...props} format={formatBpm} parse={parseBpm} />;
}

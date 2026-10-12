// Stems of one track (split by UVR, Demucs…): which kind each file is, from its name; the track's
// own name without the stem tag; which stem the beat grid is best built from.

/** What a stem is in the end: voice, drums, bass or the rest (groups on pads start from it). */
export type StemFamily = "vocal" | "drums" | "bass" | "others";

export interface StemKind {
  /** Card subfolder name: "vocals", "inst", "drums"… */
  label: string;
  /** Short tag for loop file names (they become pad names, 23 characters at most): "vox", "inst"… */
  tag: string;
  /** How good a source of the beat grid it is; the highest goes first, 0 never by itself. */
  grid: number;
  family: StemFamily;
}

// "No Vocals" is the instrumental, so the instrumental is tried first; but "Backing Vocals" is a
// voice, so the voices with a word before them go before both.
const KINDS: [RegExp, StemKind][] = [
  [/\b(backing|back|bg|backup|harmony|harmonies) ?(vocals?|vox)\b/i, { label: "backvox", tag: "bvx", grid: 0, family: "vocal" }],
  [/\blead ?(vocals?|vox)\b/i, { label: "vocals", tag: "vox", grid: 0, family: "vocal" }],
  [/\b(no vocals?|instrumental|inst|karaoke|accompaniment|backing|minus)\b/i, { label: "inst", tag: "inst", grid: 3, family: "others" }],
  [/\b(vocals?|vox|voice|acapella|a ?cappella|choir)\b/i, { label: "vocals", tag: "vox", grid: 0, family: "vocal" }],
  [/\b(drums?|percussion|perc)\b/i, { label: "drums", tag: "drm", grid: 4, family: "drums" }],
  [/\b(kick|kicks|kik|bass ?drum)\b/i, { label: "kick", tag: "kck", grid: 3.5, family: "drums" }],
  [/\b(snares?|claps?)\b/i, { label: "snare", tag: "snr", grid: 2.5, family: "drums" }],
  [/\b(hi ?hats?|hats?|hh)\b/i, { label: "hihat", tag: "hat", grid: 1, family: "drums" }],
  [/\b(cymbals?|overheads?|crash|ride)\b/i, { label: "cymbals", tag: "cym", grid: 1, family: "drums" }],
  [/\btoms?\b/i, { label: "toms", tag: "tom", grid: 1, family: "drums" }],
  [/\b(bass|808|sub ?bass)\b/i, { label: "bass", tag: "bass", grid: 2, family: "bass" }],
  [/\b(piano|keys)\b/i, { label: "piano", tag: "pno", grid: 1, family: "others" }],
  [/\bguitars?\b/i, { label: "guitar", tag: "gtr", grid: 1, family: "others" }],
  [/\b(synths?|leads?|pads?)\b/i, { label: "synth", tag: "syn", grid: 1, family: "others" }],
  [/\b(strings?|orchestra|violins?)\b/i, { label: "strings", tag: "str", grid: 1, family: "others" }],
  [/\b(brass|horns?|winds?|sax)\b/i, { label: "brass", tag: "brs", grid: 1, family: "others" }],
  [/\b(fx|sfx|effects?)\b/i, { label: "fx", tag: "fx", grid: 1, family: "others" }],
  [/\b(other|others)\b/i, { label: "other", tag: "oth", grid: 1, family: "others" }],
];

const words = (s: string) => s.replace(/[_\-.()[\]]+/g, " ").trim();
const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");
/** Where a stem's kind is written, most telling first: a bracketed tag (UVR's "(Vocals)"), the last word (Demucs' "vocals"), the whole name. */
const tagPlaces = (name: string) => {
  const base = stripExt(name);
  const bracketed = [...base.matchAll(/[([]([^)\]]+)[)\]]/g)].map((m) => m[1]!).reverse();
  const w = words(base).split(" ");
  return [...bracketed, w.slice(-2).join(" "), w.at(-1) ?? "", words(base)];
};

/** The kind of stem a file is by its name, or null when the name does not say. */
export function stemKind(fileName: string): StemKind | null {
  const places = tagPlaces(fileName), pair = places.length - 3;
  for (const [i, place] of places.entries())
    for (const [re, kind] of KINDS) {
      const m = re.exec(words(place));
      // The last two words count only as a pair ("…_backing_vocals"); one of them alone is the next place's.
      if (m && (i !== pair || m[0].includes(" "))) return kind;
    }
  return null;
}

/** The track's name without the stem tag and UVR's leading number: "1_Kein Wiedersehen_(Vocals).wav" → "Kein Wiedersehen". */
export function stemBase(fileName: string): string {
  return stripExt(fileName)
    .replace(/[([][^)\]]*[)\]]/g, (m) => (stemKind(m) ? " " : m))
    .replace(/^\d+[_ ]+/, "")
    .replace(/[_ -]+$/, "")
    .replace(/(^|[_ -])((backing|lead)[_ -])?(vocals?|vox|instrumental|inst|drums?|bass|other|piano|guitar|kick|snare|hihat|hats?|cymbals|toms|synth|strings|brass|fx)$/i, "")
    .replace(/^[_ -]+|[_ -]+$/g, "");
}

/**
 * Kinds for a set of stems, each label used once (a second "vocals" becomes "vocals_2", tag "vox2");
 * a name that does not say gets "track1", "track2"… by its place.
 */
export function stemKinds(fileNames: string[]): StemKind[] {
  const seen = new Map<string, number>();
  return fileNames.map((n, i) => {
    const k = stemKind(n) ?? { label: `track${i + 1}`, tag: `t${i + 1}`, grid: 1, family: "others" as const };
    const c = (seen.get(k.label) ?? 0) + 1;
    seen.set(k.label, c);
    return c === 1 ? k : { ...k, label: `${k.label}_${c}`, tag: `${k.tag}${c}` };
  });
}

/** The stem to build the grid from by its kind (drums, then the instrumental, then bass), or -1 when no name says. */
export function gridStem(kinds: StemKind[]): number {
  let best = -1;
  kinds.forEach((k, i) => { if (k.grid >= 2 && (best < 0 || k.grid > kinds[best]!.grid)) best = i; });
  return best;
}

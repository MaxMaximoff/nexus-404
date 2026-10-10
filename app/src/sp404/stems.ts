// Stems of one track (split by UVR, Demucs…): which kind each file is, from its name; the track's
// own name without the stem tag; which stem the beat grid is best built from.

export interface StemKind {
  /** Card subfolder name: "vocals", "inst", "drums"… */
  label: string;
  /** Short tag for loop file names (they become pad names, 23 characters at most): "vox", "inst"… */
  tag: string;
  /** How good a source of the beat grid it is; the highest goes first, 0 never by itself. */
  grid: number;
}

// "No Vocals" is the instrumental, so the instrumental is tried first.
const KINDS: [RegExp, StemKind][] = [
  [/\b(no vocals?|instrumental|inst|karaoke|accompaniment|backing|minus)\b/i, { label: "inst", tag: "inst", grid: 3 }],
  [/\b(vocals?|vox|voice|acapella|a ?cappella)\b/i, { label: "vocals", tag: "vox", grid: 0 }],
  [/\b(drums?|percussion|perc)\b/i, { label: "drums", tag: "drm", grid: 4 }],
  [/\bbass\b/i, { label: "bass", tag: "bass", grid: 2 }],
  [/\b(piano|keys)\b/i, { label: "piano", tag: "pno", grid: 1 }],
  [/\bguitars?\b/i, { label: "guitar", tag: "gtr", grid: 1 }],
  [/\b(other|others)\b/i, { label: "other", tag: "oth", grid: 1 }],
];

const words = (s: string) => s.replace(/[_\-.()[\]]+/g, " ").trim();
const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");
/** Where a stem's kind is written, most telling first: a bracketed tag (UVR's "(Vocals)"), the last word (Demucs' "vocals"), the whole name. */
const tagPlaces = (name: string) => {
  const base = stripExt(name);
  const bracketed = [...base.matchAll(/[([]([^)\]]+)[)\]]/g)].map((m) => m[1]!).reverse();
  return [...bracketed, words(base).split(" ").pop() ?? "", words(base)];
};

/** The kind of stem a file is by its name, or null when the name does not say. */
export function stemKind(fileName: string): StemKind | null {
  for (const place of tagPlaces(fileName)) for (const [re, kind] of KINDS) if (re.test(words(place))) return kind;
  return null;
}

/** The track's name without the stem tag and UVR's leading number: "1_Kein Wiedersehen_(Vocals).wav" → "Kein Wiedersehen". */
export function stemBase(fileName: string): string {
  return stripExt(fileName)
    .replace(/[([][^)\]]*[)\]]/g, (m) => (stemKind(m) ? " " : m))
    .replace(/^\d+[_ ]+/, "")
    .replace(/[_ -]+$/, "")
    .replace(/(^|[_ -])(vocals?|vox|instrumental|inst|drums?|bass|other|piano|guitar)$/i, "")
    .replace(/^[_ -]+|[_ -]+$/g, "");
}

/**
 * Kinds for a set of stems, each label used once (a second "vocals" becomes "vocals_2", tag "vox2");
 * a name that does not say gets "track1", "track2"… by its place.
 */
export function stemKinds(fileNames: string[]): StemKind[] {
  const seen = new Map<string, number>();
  return fileNames.map((n, i) => {
    const k = stemKind(n) ?? { label: `track${i + 1}`, tag: `t${i + 1}`, grid: 1 };
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

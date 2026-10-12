// How a key is shown. The key itself is found by Essentia (essentiaKey.ts, in the analysis worker);
// the SP keeps no key (its pad parameter 89 is accepted but not stored, firmware 5.52).

/** Tonic as a pitch class, C = 0 … B = 11, and major or minor. */
export interface Key { tonic: number; minor: boolean }

const NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

/** "Am", "F#m", "C", "Bb". */
export const keyName = (k: Key): string => (k.minor ? `${MINOR_NAMES[k.tonic]}m` : NAMES[k.tonic]!);

/** "A minor", "F# minor", "C major", "Bb major". */
export const keyFullName = (k: Key): string => `${(k.minor ? MINOR_NAMES : NAMES)[k.tonic]} ${k.minor ? "minor" : "major"}`;

/** The key on the Camelot wheel DJs use: "8A" = A minor, "8B" = C major; neighbours mix well. */
export function camelot(k: Key): string {
  const major = k.minor ? (k.tonic + 3) % 12 : k.tonic; // a minor key sits with its relative major
  return `${((major * 7 + 7) % 12) + 1}${k.minor ? "A" : "B"}`;
}

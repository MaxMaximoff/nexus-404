import { expect, it } from "vitest";
import { camelot, keyFullName, keyName } from "./key";

it("names major and minor keys and puts every one on the Camelot wheel", () => {
  const majorNames = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const minorNames = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
  const majorWheel = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
  const minorWheel = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
  for (let tonic = 0; tonic < 12; tonic++) {
    expect(keyName({ tonic, minor: false })).toBe(majorNames[tonic]);
    expect(keyName({ tonic, minor: true })).toBe(minorNames[tonic]);
    expect(camelot({ tonic, minor: false })).toBe(majorWheel[tonic]);
    expect(camelot({ tonic, minor: true })).toBe(minorWheel[tonic]);
  }
  expect(keyFullName({ tonic: 5, minor: true })).toBe("F minor");
  expect(keyFullName({ tonic: 1, minor: true })).toBe("C# minor");
  expect(keyFullName({ tonic: 10, minor: false })).toBe("Bb major");
});

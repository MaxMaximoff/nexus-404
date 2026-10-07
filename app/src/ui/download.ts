// Hand a file to the browser's downloads (to the computer).

/** Save `data` as a download named `name`. */
export function saveFile(name: string, data: BlobPart, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A file name Windows accepts. */
export const safeFileName = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim() || "sample";

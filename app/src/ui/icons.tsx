// Small inline icons (stroke = currentColor).

const svg = (d: string, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export const IconPlug = () => svg("M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v5");
export const IconUnplug = () => svg("M18 6 6 18M9 2v4M15 2v4M7 8h10v3a5 5 0 0 1-1 3M12 17v5");
export const IconRefresh = () => svg("M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5");
export const IconPlay = () => svg("M7 4.5v15l12-7.5-12-7.5z");
export const IconStop = () => svg("M6 6h12v12H6z");
export const IconUpload = () => svg("M12 16V4M6 10l6-6 6 6M4 20h16");
export const IconLock = () => svg("M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3", 12);
export const IconWave = () => svg("M2 12h2l2-6 3 12 3-15 3 18 3-12 2 3h2");
export const IconX = () => svg("M18 6 6 18M6 6l12 12", 14);
export const IconDownload = () => svg("M12 4v12M6 10l6 6 6-6M4 20h16", 14);
export const IconMic = () => svg("M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4", 14);
export const IconCard = () => svg("M7 3h8l4 4v14H7zM10 3v4M13 3v4M16 7v0", 14);
export const IconFolderPlus = () => svg("M3 6h6l2 2h10v11H3zM12 11v5M9.5 13.5h5", 14);
export const IconPencil = () => svg("M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4", 14);
export const IconFolder = () => svg("M3 6h6l2 2h10v11H3z", 14);
export const IconFile = () => svg("M6 3h8l4 4v14H6zM14 3v4h4", 14);
export const IconTrash = () => svg("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6", 14);
export const IconCheck = () => svg("M5 12l5 5 9-10", 14);

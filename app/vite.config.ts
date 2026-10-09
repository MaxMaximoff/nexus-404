import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

// Web Serial needs a secure context: http://localhost is one, a LAN address is not.
export default defineConfig({
  plugins: [preact()],
  base: "/nexus-404/",
  // hmr: false — files are still watched and served fresh, but the page is never hot-updated or
  // reloaded by itself: a reload would drop the serial connection mid-operation. Press F5 to pick up changes.
  server: { host: "localhost", port: 5173, strictPort: true, hmr: false },
  test: { environment: "node" },
});

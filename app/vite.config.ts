import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import preact from "@preact/preset-vite";

const APP = fileURLToPath(new URL(".", import.meta.url));
const git = (args: string) => { try { return execSync(`git ${args}`, { cwd: APP, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };

// AGPL-3.0 (Essentia is in the bundle): the app links to its own source. A build from committed
// source links to that very commit; with local changes (or outside Git) to the repository only.
// `npm run ship` refuses to build from uncommitted source (scripts/check-source.mjs).
const commit = git("rev-parse HEAD");
const dirty = !commit || git('status --porcelain -- ":/" ":(exclude,top)app/dist"') !== "";

/**
 * The license texts next to the built app: ours (LICENSE.txt) and every runtime dependency's
 * (THIRD-PARTY-LICENSES.txt, from package-lock.json: all non-dev packages).
 */
function licenses(): Plugin {
  return {
    name: "nexus-licenses",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "LICENSE.txt", source: readFileSync(join(APP, "../LICENSE"), "utf8") });
      const lock = JSON.parse(readFileSync(join(APP, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; license?: string; dev?: boolean }> };
      const parts: string[] = [];
      for (const [path, p] of Object.entries(lock.packages)) {
        if (!path || p.dev) continue;
        const dir = join(APP, path), name = path.replace(/^.*node_modules\//, "");
        const file = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)) : undefined;
        if (!p.license && !file) this.error(`${name}: no license declared or found in ${dir}`);
        const text = file ? readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim() : `The package ships no license file; its package.json declares ${p.license}.`;
        parts.push(`${"=".repeat(72)}\n${name}@${p.version} — ${p.license ?? "see below"}\n${"=".repeat(72)}\n\n${text}\n`);
      }
      const head = "Nexus-404 includes the following packages. Their licenses follow; Nexus-404 itself is under the GNU AGPL-3.0 (LICENSE.txt).\n\n";
      this.emitFile({ type: "asset", fileName: "THIRD-PARTY-LICENSES.txt", source: head + parts.join("\n") });
    },
  };
}

// Web Serial needs a secure context: http://localhost is one, a LAN address is not.
export default defineConfig({
  plugins: [preact(), licenses()],
  base: "/nexus-404/",
  define: { __SOURCE_COMMIT__: JSON.stringify(dirty ? "" : commit) },
  // ES workers: the analysis worker loads Essentia with a dynamic import, as a chunk of its own.
  worker: { format: "es" },
  // hmr: false — files are still watched and served fresh, but the page is never hot-updated or
  // reloaded by itself: a reload would drop the serial connection mid-operation. Press F5 to pick up changes.
  server: { host: "localhost", port: 5173, strictPort: true, hmr: false },
  test: { environment: "node" },
});

// Nexus-404 is free software under the GNU AGPL-3.0 (Essentia, in the bundle, is AGPL too): whoever
// uses the app on the site can get the source of exactly this build, and the app says so.

const REPO = "https://github.com/MaxMaximoff/nexus-404";
/** The source of this build: its commit, or the repository when built from uncommitted source. */
export const SOURCE_URL = __SOURCE_COMMIT__ ? `${REPO}/tree/${__SOURCE_COMMIT__}` : REPO;
const SHORT = __SOURCE_COMMIT__.slice(0, 7);
const asset = (name: string) => `${import.meta.env.BASE_URL}${name}`;

/** In the header: the way to the source, always in sight. */
export function SourceLink() {
  return (
    <a class="source-link" href={SOURCE_URL} target="_blank" rel="noopener"
      title={`Nexus-404 is free software under the GNU AGPL-3.0: the source code of this build${SHORT ? ` (commit ${SHORT})` : ""}`}>Source</a>
  );
}

/** At the foot of the page: the legal notices the AGPL asks an interactive program to show. */
export function LegalFooter() {
  return (
    <footer class="legal muted small">
      Nexus-404 © 2026 Максим Бугримов. Free software under the{" "}
      <a href={asset("LICENSE.txt")} target="_blank" rel="noopener">GNU Affero General Public License v3.0</a>, with no warranty.{" "}
      <a href={SOURCE_URL} target="_blank" rel="noopener">Source code{SHORT ? ` (${SHORT})` : ""}</a> ·{" "}
      <a href={asset("THIRD-PARTY-LICENSES.txt")} target="_blank" rel="noopener">Third-party licenses</a> (Essentia.js — AGPL-3.0, Preact — MIT, fonts — OFL-1.1).
    </footer>
  );
}

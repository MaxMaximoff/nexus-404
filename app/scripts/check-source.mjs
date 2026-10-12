// Before `npm run ship`: the source must be committed, so the build's "Source" link (AGPL-3.0)
// points to a commit that is exactly what was built. Only app/dist may differ.
import { execSync } from "node:child_process";

const changed = execSync('git status --porcelain -- ":/" ":(exclude,top)app/dist"', { encoding: "utf8" }).trim();
if (changed) {
  console.error(`Commit the source first; the deployed build links to its commit (AGPL-3.0).\n${changed}`);
  process.exit(1);
}

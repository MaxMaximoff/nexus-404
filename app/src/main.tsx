import { render } from "preact";
import { App } from "./ui/App";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./ui/styles.css";

// Only the inspector's inner-section study remains opt-in; shared shells live in styles.css.
async function mount() {
  if (new URLSearchParams(location.search).get("graphics") === "hybrid") {
    await import("./ui/hybrid.css");
    document.documentElement.classList.add("hybrid-poc");
  }
  render(<App />, document.getElementById("app")!);
}
void mount();

import { render } from "preact";
import { App } from "./ui/App";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./ui/styles.css";

// Opt-in material study: no device/store behavior changes, no extra assets in the default UI.
async function mount() {
  if (new URLSearchParams(location.search).get("graphics") === "hybrid") {
    await import("./ui/hybrid.css");
    document.documentElement.classList.add("hybrid-poc");
  }
  render(<App />, document.getElementById("app")!);
}
void mount();

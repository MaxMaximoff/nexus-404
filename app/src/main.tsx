import { render } from "preact";
import { App } from "./ui/App";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./ui/styles.css";
import "./ui/theme-matte.css";

render(<App />, document.getElementById("app")!);

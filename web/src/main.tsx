import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./store";

connect();
// Offline screen for page loads with no connection (web/public/app-sw.js). Push has its own workers.
if ("serviceWorker" in navigator)
  window.addEventListener("load", () => navigator.serviceWorker.register("/app-sw.js", { scope: "/" }).catch(() => {}));
createRoot(document.getElementById("root")!).render(
  <Theme theme={neutralTheme} mode="dark">
    <App />
  </Theme>,
);

import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./store";

connect();
createRoot(document.getElementById("root")!).render(
  <Theme theme={neutralTheme} mode="dark">
    <App />
  </Theme>,
);

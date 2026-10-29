import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./app.css";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { start } from "./store";

start();
createRoot(document.getElementById("root")!).render(
  <Theme theme={neutralTheme} mode="dark">
    <ErrorBoundary fallback={(e) => <div style={{ padding: 24 }}>Tether hit an error: {e.message}. <a href="">Reload</a></div>}>
      <App />
    </ErrorBoundary>
  </Theme>,
);

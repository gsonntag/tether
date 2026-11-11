import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const server = process.env.TETHER_SERVER ?? "http://127.0.0.1:8790";

/**
 * Each build's id, baked into the bundle and written beside it as build.json: an open page that
 * finds another id there runs an older build and offers a reload (src/build.ts). Dev has none.
 */
function buildId(): Plugin {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: "tether-build-id",
    config: (_, { command }) => ({ define: { __TETHER_BUILD__: JSON.stringify(command === "build" ? id : "dev") } }),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify({ build: id }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildId()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_PORT ?? 5180),
    strictPort: true,
    // shared/ lives beside web/
    fs: { allow: [".."] },
    proxy: { "/api": { target: server, ws: true } },
  },
});

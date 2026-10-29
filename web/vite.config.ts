import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = process.env.TETHER_SERVER ?? "http://127.0.0.1:8790";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_PORT ?? 5180),
    strictPort: true,
    // shared/ lives beside web/
    fs: { allow: [".."] },
    proxy: { "/api": { target: server, ws: true } },
  },
});

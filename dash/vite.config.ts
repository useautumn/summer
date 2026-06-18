import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Summer dash server (src/dash/server.ts) serves the built `dist/` and the `/api/*` routes.
// In dev (`vite`), proxy /api to that server so the UI works against real Autumn data.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:4321" }
  },
  build: { outDir: "dist", emptyOutDir: true }
});

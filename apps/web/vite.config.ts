import { defineConfig } from "vite";

// In dev, Vite serves the UI and forwards /api to `uv run misty serve` (port 4322).
// In production, `misty serve` serves the built dist/ itself, on one port.
export default defineConfig({
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4322" } },
});

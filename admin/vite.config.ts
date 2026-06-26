import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Admin runs on :5173 (matches the API's default CORS allowlist origin).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        // Keep the rarely-changing React/router/query runtime in its own chunk
        // so it stays cached across app deploys. Leaflet and Recharts split out
        // automatically via the dynamic imports in DashboardPage/ReportsPage.
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom", "@tanstack/react-query"],
        },
      },
    },
  },
});

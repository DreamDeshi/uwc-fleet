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
});

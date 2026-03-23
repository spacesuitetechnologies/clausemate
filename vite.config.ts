import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Build-time guard: reject any production build where VITE_USE_MOCK=true.
 * Runs during `vite build` before any code is emitted, so CI catches it
 * immediately rather than shipping a bundle with mock data.
 */
function mockSafetyGuard(): Plugin {
  return {
    name: "mock-safety-guard",
    configResolved(config) {
      if (config.command === "build" && config.env.VITE_USE_MOCK === "true") {
        throw new Error(
          "\n[mock-safety-guard] VITE_USE_MOCK=true is forbidden in production builds.\n" +
          "Remove VITE_USE_MOCK from .env.production or set it to false.\n",
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [mockSafetyGuard(), react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});

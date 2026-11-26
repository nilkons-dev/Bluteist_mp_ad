import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run android:*` sets BYTUNE_TARGET=android. Only then is the MediaSession polyfill (which replaces
// navigator.mediaSession) part of the bundle; the desktop build gets an empty module instead.
const android = process.env.BYTUNE_TARGET === "android";

export default defineConfig({
  plugins: [react()],
  // relative asset paths so the production build works under file:// in Electron (and in Capacitor)
  base: "./",
  clearScreen: false,
  resolve: {
    alias: android ? {} : { "@jofr/capacitor-media-session": fileURLToPath(new URL("./src/mobile/empty.ts", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
});

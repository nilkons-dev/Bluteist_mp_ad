import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.blutheist.music",
  appName: "Blutheist",
  webDir: "dist",
  backgroundColor: "#000000",
  server: {
    // The page is served from https://localhost; the loopback stream server it talks to is http://127.0.0.1.
    androidScheme: "https",
  },
  android: {
    allowMixedContent: true,
    backgroundColor: "#000000",
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    // The embedded Node.js that runs the music engine (YouTube Music, lyrics, downloads, local library ...).
    // Its project is dist/nodejs, produced by scripts/android/build-backend.mjs.
    CapacitorNodeJS: {
      nodeDir: "nodejs",
      startMode: "auto",
    },
  },
};

export default config;

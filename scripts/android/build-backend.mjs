/**
 * Bundles the Android Node.js backend into dist/nodejs/ (the folder capacitor-nodejs copies into the APK).
 *
 *   dist/nodejs/index.js        the whole backend, one CommonJS file (electron/*.ts + android-backend/src)
 *   dist/nodejs/package.json    {"main": "index.js", dependencies: jsdom}
 *   dist/nodejs/node_modules/   only jsdom (pruned) — everything else is bundled in index.js
 *
 * Run after `vite build` (which empties dist/).
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "dist", "nodejs");
const skipInstall = process.argv.includes("--no-install");

// jsdom 29 needs Node >= 20.19. The Node inside Android's nodejs-mobile can be older, so the Android
// build pins the last line that still supports Node 18. (The desktop build keeps its own jsdom.)
const JSDOM_FOR_ANDROID = "^26.1.0";

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const accountsOn = /ACCOUNTS_ENABLED\s*=\s*true/.test(readFileSync(join(root, "src/lib/config.ts"), "utf8"));
try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  /* no .env: fine, guest-only */
}
const url = process.env.BYTUNE_SUPABASE_URL ?? "";
const key = process.env.BYTUNE_SUPABASE_KEY ?? "";
if (accountsOn && (!url || !key)) console.warn("[android-backend] Accounts are on but no Supabase project is set: guest-only build.");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** Maps the package names the shims `require` to the real modules, and the app's imports to the shims. */
const aliasPlugin = {
  name: "android-aliases",
  setup(b) {
    const shim = (name) => join(root, "android-backend/src/shims", name);
    // electron/*.ts import "jsdom": hand them the lazy wrapper; the wrapper's own "jsdom-real" stays external.
    b.onResolve({ filter: /^jsdom$/ }, () => ({ path: shim("jsdom-lazy.ts") }));
    b.onResolve({ filter: /^jsdom-real$/ }, () => ({ path: "jsdom", external: true }));
    // supabase-js: lazy wrapper for the app, the real package (bundled, but only evaluated on first use) for the wrapper.
    b.onResolve({ filter: /^@supabase\/supabase-js$/ }, (args) => {
      if (args.pluginData === "real") return undefined; // the wrapper asked for the genuine package
      return { path: shim("supabase-lazy.ts") };
    });
    b.onResolve({ filter: /^supabase-real$/ }, async (args) => {
      const r = await b.resolve("@supabase/supabase-js", { resolveDir: root, kind: args.kind, pluginData: "real" });
      return r.errors.length ? { errors: r.errors } : { path: r.path };
    });
    // The Electron API surface the shared modules touch.
    b.onResolve({ filter: /^electron$/ }, () => ({ path: join(root, "android-backend/src/electron-shim.ts") }));
  },
};

await build({
  entryPoints: [join(root, "android-backend/src/main.ts")],
  outfile: join(out, "index.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  // "bridge" is injected by nodejs-mobile; the rest are optional native add-ons some libraries probe for.
  external: ["bridge", "canvas", "bufferutil", "utf-8-validate", "undici"],
  plugins: [aliasPlugin],
  define: {
    "process.env.BYTUNE_SUPABASE_URL": JSON.stringify(url),
    "process.env.BYTUNE_SUPABASE_KEY": JSON.stringify(key),
  },
  logLevel: "info",
  legalComments: "none",
  minify: false, // readable stack traces matter more than 1 MB here
});

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "blutheist-android-backend",
      version: pkg.version,
      private: true,
      main: "index.js",
      description: "Blutheist backend for Android (runs inside nodejs-mobile)",
      dependencies: { jsdom: JSDOM_FOR_ANDROID },
    },
    null,
    2
  )
);

if (!skipInstall) {
  console.log(`[android-backend] installing jsdom@${JSDOM_FOR_ANDROID} into dist/nodejs ...`);
  execFileSync("npm", ["install", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund", "--ignore-scripts", "--legacy-peer-deps"], {
    cwd: out,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  prune(join(out, "node_modules"));
}

/** Drop what a running jsdom never reads: docs, tests, type declarations, source maps, markdown. */
function prune(dir) {
  if (!existsSync(dir)) return;
  const dropDirs = new Set(["test", "tests", "__tests__", "docs", ".github", "example", "examples", "benchmark", "benchmarks"]);
  const dropFile = /(\.md|\.markdown|\.map|\.tsbuildinfo)$|\.d\.[mc]?ts$/i;
  let removedBytes = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (dropDirs.has(name)) {
          removedBytes += sizeOf(p);
          rmSync(p, { recursive: true, force: true });
        } else walk(p);
      } else if (dropFile.test(name) && !/^(license|licence|notice)/i.test(name)) {
        removedBytes += st.size;
        rmSync(p, { force: true });
      }
    }
  };
  walk(dir);
  console.log(`[android-backend] pruned ${(removedBytes / 1048576).toFixed(1)} MB from node_modules`);
}

function sizeOf(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, f) => n + sizeOf(join(p, f)), 0);
}

const size = statSync(join(out, "index.js")).size;
console.log(`[android-backend] dist/nodejs/index.js ${(size / 1048576).toFixed(2)} MB`);

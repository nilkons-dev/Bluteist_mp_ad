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
import * as acorn from "acorn";
import { collectPropertyNames, generateData, rewriteRegexLiterals } from "./unicode-compat.mjs";
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
    // Only the Windows installer path (never reached on Android) imports it.
    b.onResolve({ filter: /^electron-updater$/ }, () => ({ path: shim("empty.ts") }));
    // The Electron API surface the shared modules touch.
    b.onResolve({ filter: /^electron$/ }, () => ({ path: join(root, "android-backend/src/electron-shim.ts") }));
  },
};

await build({
  entryPoints: [join(root, "android-backend/src/main.ts")],
  outfile: join(out, "backend.js"),
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

/*
 * The Node inside Android is built without ICU: a regex literal with a property escape (\p{L}) is a SyntaxError there
 * and stops the whole file from loading. Rewrite them into `new RegExp(...)` calls (the runtime layer expands them),
 * then prove none are left.
 */
const propertyNames = new Set();
function rewriteFile(file) {
  const code = readFileSync(file, "utf8");
  if (!/\\[pP]\{/.test(code)) return 0;
  collectPropertyNames(code, propertyNames);
  const { code: out, count } = rewriteRegexLiterals(code, acorn);
  if (count) writeFileSync(file, out);
  // Idempotence check: a second pass must find nothing left to rewrite.
  if (rewriteRegexLiterals(out, acorn).count !== 0) throw new Error(`${file}: regex literals with \\p{...} remain after rewriting`);
  return count;
}
const bundleLiterals = rewriteFile(join(out, "backend.js"));
console.log(`[android-backend] rewrote ${bundleLiterals} regex literal(s) with Unicode property escapes in backend.js`);

/**
 * index.js is a tiny loader, the file nodejs-mobile actually starts. It exists so that a failure while the real
 * backend (backend.js) is being loaded — a library that dislikes this Node, a missing file — can never take the
 * whole app down: it is caught here and reported to the page, which shows it instead of vanishing.
 */
writeFileSync(
  join(out, "index.js"),
  `"use strict";
var loadError = null;
function describe(e) { return e && e.stack ? String(e.stack) : String(e); }
process.on("uncaughtException", function (e) { try { console.error("[blutheist] uncaught:", describe(e)); } catch (_) {} });
process.on("unhandledRejection", function (e) { try { console.warn("[blutheist] unhandled rejection:", describe(e)); } catch (_) {} });
try {
  require("./backend.js");
} catch (e) {
  loadError = describe(e);
  try { console.error("[blutheist] backend failed to load:", loadError); } catch (_) {}
}
if (loadError) {
  try {
    var bridge = require("bridge");
    var ch = bridge.channel || bridge;
    var add = ch.addListener || ch.on;
    var send = ch.send || ch.post;
    var tell = function () {
      try {
        send.call(ch, "msg", JSON.stringify({ t: "fatal", message: "The backend failed to load: " + loadError.slice(0, 1800) }));
      } catch (_) {}
    };
    add.call(ch, "msg", tell); // answers the page's first message, whenever it arrives
    tell();
  } catch (_) {}
}
`
);

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

/** Same rewrite for the libraries that ship as real files (jsdom and its dependencies). */
function rewriteTree(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) n += rewriteTree(p);
    else if (/\.(c|m)?js$/.test(name)) n += rewriteFile(p);
  }
  return n;
}
const treeLiterals = rewriteTree(join(out, "node_modules"));
console.log(`[android-backend] rewrote ${treeLiterals} regex literal(s) in node_modules`);

// Code-point ranges for the properties used (+ a standard set) and normalization tables, from this full-ICU Node.
const unicodeData = generateData([...propertyNames]);
writeFileSync(join(out, "unicode-data.json"), JSON.stringify(unicodeData));
console.log(
  `[android-backend] unicode-data.json: ${Object.keys(unicodeData.props).length} properties, ` +
    `${(statSync(join(out, "unicode-data.json")).size / 1024).toFixed(0)} KB`
);

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

const size = statSync(join(out, "backend.js")).size;
console.log(`[android-backend] dist/nodejs/backend.js ${(size / 1048576).toFixed(2)} MB (+ index.js loader)`);

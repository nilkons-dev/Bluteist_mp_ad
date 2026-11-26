/**
 * Boots the freshly built Android backend (dist/nodejs/index.js) and checks that it answers — BEFORE the long
 * Gradle build. It runs the real bundle through the same loader the phone uses, over the stdio transport, with
 * the ICU-less shims forced on (BLUTHEIST_FORCE_UNICODE_SHIM=1), so a library that can't load, a regex the shims
 * can't expand, or a boot step that throws is caught here instead of as a crash on a phone.
 *
 *   node scripts/android/smoke-backend.mjs            (set BLUTHEIST_SKIP_SMOKE=1 to skip)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = join(root, "dist", "nodejs", "index.js");

if (process.env.BLUTHEIST_SKIP_SMOKE === "1") {
  console.log("[smoke] skipped (BLUTHEIST_SKIP_SMOKE=1)");
  process.exit(0);
}
if (!existsSync(entry)) throw new Error(`${entry} not found — build the backend first`);

const work = mkdtempSync(join(tmpdir(), "blutheist-smoke-"));
const info = {
  dataDir: join(work, "files"),
  cacheDir: join(work, "cache"),
  musicDir: join(work, "Music"),
  downloadDir: join(work, "Download"),
  externalFilesDir: join(work, "ext"),
  storageRoot: work,
  locale: "en-US",
  region: "US",
  version: "0.0.0-smoke",
};

const child = spawn(process.execPath, [entry, "--stdio"], {
  cwd: join(root, "dist", "nodejs"),
  env: { ...process.env, BLUTHEIST_FORCE_UNICODE_SHIM: "1", NODE_ENV: "production" },
  stdio: ["pipe", "pipe", "pipe"],
});

const log = [];
child.stderr.on("data", (d) => log.push(String(d)));
let buf = "";
const waiters = [];
const messages = [];
child.stdout.on("data", (d) => {
  buf += String(d);
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith("{")) continue; // a library printing to stdout
    try {
      const msg = JSON.parse(line);
      messages.push(msg);
      for (const w of waiters.splice(0)) w();
    } catch {
      /* not ours */
    }
  }
});
let exited = null;
child.on("exit", (code, sig) => {
  exited = `exited (code ${code}, signal ${sig})`;
  for (const w of waiters.splice(0)) w();
});

function waitFor(pred, ms, what) {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`timed out after ${ms / 1000}s waiting for ${what}`)), ms);
    const check = () => {
      const hit = messages.find(pred);
      if (hit) {
        clearTimeout(timer);
        resolveP(hit);
      } else if (exited) {
        clearTimeout(timer);
        rejectP(new Error(`backend ${exited} while waiting for ${what}`));
      } else waiters.push(check);
    };
    check();
  });
}
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");

let ok = false;
try {
  send({ t: "init", info });
  const first = await waitFor((m) => m.t === "ready" || m.t === "fatal", 90_000, "ready");
  if (first.t === "fatal") throw new Error(`backend reported: ${first.message}`);
  console.log("[smoke] backend booted");

  let id = 1;
  const call = async (ch, ...args) => {
    const myId = id++;
    send({ t: "req", id: myId, ch, args });
    const res = await waitFor((m) => m.t === "res" && m.id === myId, 30_000, ch);
    if (!res.ok) throw new Error(`${ch} failed: ${res.error}`);
    return res.value;
  };
  await call("data:scope");
  const port = await call("android:proxyPort");
  if (!Number.isInteger(port) || port <= 0) throw new Error(`stream proxy gave no port (${port})`);
  await call("app:defaultDownloadDir");
  await call("library:get");
  await call("auth:getSession");
  console.log(`[smoke] data, library, session and the stream proxy (port ${port}) answer`);
  ok = true;
} catch (err) {
  console.error(`\n[smoke] FAILED: ${err instanceof Error ? err.message : err}`);
  if (log.length) console.error("[smoke] backend log:\n" + log.join("").split("\n").slice(-40).join("\n"));
} finally {
  child.kill();
  rmSync(work, { recursive: true, force: true });
}
if (!ok) process.exit(1);
console.log("[smoke] OK");
process.exit(0);

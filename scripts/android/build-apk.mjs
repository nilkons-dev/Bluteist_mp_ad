/**
 * One command from source to APK:   npm run android:build        (release-signed, what you install)
 *                                    npm run android:build:debug  (debuggable; slower, for development)
 *                                    npm run android:sync         (everything except Gradle)
 *
 * Steps: vite build → bundle the Node backend → `cap add android` (first time) → patch → `cap sync` → Gradle.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const debug = process.argv.includes("--debug");
const noGradle = process.argv.includes("--no-gradle");
const win = process.platform === "win32";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function run(cmd, args, cwd = root) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: win, env: process.env });
}
const npx = win ? "npx.cmd" : "npx";
process.env.BYTUNE_TARGET = "android";

// The real capacitor-nodejs comes from a GitHub release (npm's "latest" is a broken placeholder); vite needs it too.
run(process.execPath, [join(root, "scripts/android/install-nodejs-plugin.mjs")]);
run(npx, ["vite", "build"]);
run(process.execPath, [join(root, "scripts/android/build-backend.mjs")]);
if (!existsSync(join(root, "android", "app"))) run(npx, ["cap", "add", "android"]);
run(process.execPath, [join(root, "scripts/android/patch-android.mjs")]);
run(npx, ["cap", "sync", "android"]);
// cap sync can re-generate parts of the project; the patch is idempotent, so apply it again.
run(process.execPath, [join(root, "scripts/android/patch-android.mjs")]);

if (noGradle) {
  console.log("\nandroid/ is ready. Build with Android Studio (npm run android:open) or `cd android && ./gradlew assembleRelease`.");
  process.exit(0);
}

const gradlew = join(root, "android", win ? "gradlew.bat" : "gradlew");
run(gradlew, [debug ? "assembleDebug" : "assembleRelease", "--no-daemon", "--stacktrace"], join(root, "android"));

const outDir = join(root, "android/app/build/outputs/apk", debug ? "debug" : "release");
const apks = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".apk")) : [];
if (!apks.length) throw new Error(`No APK found in ${outDir}`);
const dest = join(root, "release");
mkdirSync(dest, { recursive: true });
for (const f of apks) {
  const name = `Blutheist-${pkg.version}-${debug ? "debug" : "release"}.apk`;
  copyFileSync(join(outDir, f), join(dest, apks.length === 1 ? name : f));
  console.log(`\n✔ ${join("release", apks.length === 1 ? name : f)}`);
}

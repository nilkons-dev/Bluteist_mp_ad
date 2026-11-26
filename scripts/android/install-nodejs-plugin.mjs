/**
 * Installs the real `capacitor-nodejs` plugin (hampoelz/Capacitor-NodeJS).
 *
 * npm's "latest" tag for that name points at an unrelated 0.0.x placeholder whose native code does not compile;
 * the working 1.0.0 betas are published as GitHub release tarballs. This finds the newest release that carries
 * a capacitor-nodejs .tgz and installs it (writing it into package.json of this checkout).
 *
 * Usage: node scripts/android/install-nodejs-plugin.mjs [--force]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = "hampoelz/Capacitor-NodeJS";
// Used only if the GitHub API can't be reached.
const FALLBACK = `https://github.com/${REPO}/releases/download/v1.0.0-beta.9/capacitor-nodejs.tgz`;

/** First (newest) release that has a capacitor-nodejs tarball asset. */
export function pickTarball(releases) {
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (rel?.draft) continue;
    const asset = (rel.assets ?? []).find((a) => /^capacitor-nodejs.*\.tgz$/i.test(a?.name ?? ""));
    if (asset?.browser_download_url) return { url: asset.browser_download_url, tag: rel.tag_name };
  }
  return null;
}

function installedVersion() {
  const p = join(root, "node_modules", "capacitor-nodejs", "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const force = process.argv.includes("--force");
  const have = installedVersion();
  // 0.0.x is the broken placeholder; anything 1.x is the real plugin.
  if (have && !/^0\./.test(have) && !force) {
    console.log(`[capacitor-nodejs] ${have} already installed`);
    return;
  }

  let url = FALLBACK;
  try {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "blutheist-build" };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const found = pickTarball(await res.json());
    if (found) {
      url = found.url;
      console.log(`[capacitor-nodejs] newest release: ${found.tag}`);
    } else {
      console.warn("[capacitor-nodejs] no release tarball found, using the pinned fallback");
    }
  } catch (err) {
    console.warn(`[capacitor-nodejs] couldn't query releases (${err instanceof Error ? err.message : err}); using the pinned fallback`);
  }

  console.log(`[capacitor-nodejs] npm install ${url}`);
  execFileSync("npm", ["install", url, "--legacy-peer-deps", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  console.log(`[capacitor-nodejs] installed ${installedVersion()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

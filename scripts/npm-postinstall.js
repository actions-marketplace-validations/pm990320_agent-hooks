#!/usr/bin/env node
// agent-hooks npm postinstall
//
// Downloads the native binary matching the user's platform from the
// GitHub release tagged with THIS package's version, places it next to
// the wrapper bin script, and re-signs on darwin so macOS Gatekeeper
// doesn't flag the cross-path signature as "modified".
//
// The published npm package is deliberately thin: no TypeScript
// compile, no Bun runtime bundle, no pre-shipped binary in the tarball
// — the binary is fetched at install time so the npm package itself
// stays ~10 KB and the same native binary that lives on the GitHub
// release is what you end up running.
//
// Opt-outs and failure modes:
//   * `npm install --ignore-scripts` — postinstall doesn't run. The
//     npm-bin.js wrapper prints a clear error on first invocation.
//   * Offline / corporate proxy blocks github.com — install fails
//     loudly with the download URL so you can mirror it.
//   * AGENT_HOOKS_SKIP_POSTINSTALL=1 — bypass entirely (useful for
//     reproducible installs where the caller pre-seeded the binary).
//   * Existing valid binary already at target — skipped (re-installs
//     from cache are instant).

import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const REPO = "pm990320/agent-hooks";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const BIN_DIR = path.join(PKG_ROOT, "bin");

function log(...args) {
  // Prefix all output so it's obvious where postinstall noise comes from
  // when interleaved with other packages' postinstalls.
  console.log("[agent-hooks postinstall]", ...args);
}

function warn(...args) {
  console.warn("[agent-hooks postinstall]", ...args);
}

function die(...args) {
  console.error("[agent-hooks postinstall] error:", ...args);
  process.exit(1);
}

// Translate Node's platform/arch names into the asset-naming convention
// used on the GitHub release. Returns the asset basename + whether this
// platform uses a .exe suffix.
function resolveTarget() {
  const platform = os.platform();
  const arch = os.arch();

  let osName;
  switch (platform) {
    case "linux":
      osName = "linux";
      break;
    case "darwin":
      osName = "darwin";
      break;
    case "win32":
      osName = "windows";
      break;
    default:
      die(
        `Unsupported OS: ${platform}. Supported: linux, darwin, windows.\n` +
          `Install manually via https://github.com/${REPO}/releases.`,
      );
  }

  let archName;
  switch (arch) {
    case "x64":
      archName = "x64";
      break;
    case "arm64":
      archName = "arm64";
      break;
    default:
      die(
        `Unsupported arch: ${arch}. Supported: x64, arm64.\n` +
          `Install manually via https://github.com/${REPO}/releases.`,
      );
  }

  // Windows only ships x64 binaries currently; reject arm64 Windows
  // explicitly rather than 404'ing on the download.
  if (osName === "windows" && archName !== "x64") {
    die(
      `Windows ${archName} is not shipped as a prebuilt binary.\n` +
        `Supported on Windows: x64 only.`,
    );
  }

  const ext = osName === "windows" ? ".exe" : "";
  const asset = `agent-hooks-${osName}-${archName}${ext}`;
  return { asset, ext };
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readPackageVersion() {
  const raw = await (await import("node:fs/promises")).readFile(
    path.join(PKG_ROOT, "package.json"),
    "utf8",
  );
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    die("package.json missing a version string");
  }
  return pkg.version;
}

// Download via Node 18+'s global fetch. Writes directly to disk via
// stream pipeline so even large (~100 MB) binaries don't hold the
// whole response in memory.
async function downloadTo(url, dest) {
  const res = await fetch(url, {
    redirect: "follow",
    // Ask for the raw binary; the server responds with
    // application/octet-stream but some CDNs get unhappy without
    // an explicit Accept.
    headers: { Accept: "application/octet-stream, */*;q=0.8" },
  });
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${res.statusText} while fetching ${url}`,
    );
  }
  if (!res.body) {
    throw new Error(`no response body for ${url}`);
  }
  // Node's Readable.fromWeb handles the conversion from the Web
  // ReadableStream that fetch returns.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// macOS only: re-sign the binary with a clean ad-hoc signature so
// Gatekeeper doesn't flag it as "code or signature have been
// modified" after the cross-path write. Same sequence the release
// CI and install.sh use. Silent no-op everywhere else.
function resignIfDarwin(binaryPath) {
  if (os.platform() !== "darwin") return;
  const run = (cmd, args) =>
    spawnSync(cmd, args, { stdio: "ignore" });
  // --remove-signature first so bun's linker-signed LC_CODE_SIGNATURE
  // load command doesn't confuse `codesign -fs -` on the next step.
  run("codesign", ["--remove-signature", binaryPath]);
  const result = run("codesign", [
    "-fs",
    "-",
    "--force",
    "--deep",
    binaryPath,
  ]);
  if (result.status !== 0) {
    warn(
      "codesign re-sign failed — binary may still run, but if macOS " +
        "reports 'killed: 9' try: codesign -fs - --force --deep " +
        binaryPath,
    );
  }
}

async function main() {
  if (process.env.AGENT_HOOKS_SKIP_POSTINSTALL === "1") {
    log("AGENT_HOOKS_SKIP_POSTINSTALL=1 — skipping binary download");
    return;
  }

  // When this script runs from a checkout of the agent-hooks repo
  // itself (bun install during development, npm install --from-source,
  // etc.), PKG_ROOT is the repo root — NOT inside a node_modules tree.
  // In that case, skip the download: contributors produce the binary
  // via `bun run build` instead, and we don't want `bun install` to
  // clobber their freshly-built local bin/agent-hooks with a release
  // download.
  const nodeModulesSep = `${path.sep}node_modules${path.sep}`;
  const isConsumerInstall = PKG_ROOT.includes(nodeModulesSep);
  if (!isConsumerInstall) {
    log(
      `development checkout detected at ${PKG_ROOT} — skipping binary ` +
        `download (use 'bun run build' to produce bin/agent-hooks locally)`,
    );
    return;
  }

  const { asset, ext } = resolveTarget();
  const version = await readPackageVersion();
  const tag = `v${version}`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  const target = path.join(BIN_DIR, `agent-hooks${ext}`);

  // If the binary is already present and executable, skip. Users who
  // reinstall or bump via `npm ci` on a populated node_modules get an
  // instant no-op; fresh installs hit the download path.
  if (await fileExists(target)) {
    try {
      const s = await stat(target);
      if (s.size > 0) {
        log(`${target} already present, skipping download`);
        return;
      }
    } catch {
      // Fall through and re-download.
    }
  }

  await mkdir(BIN_DIR, { recursive: true });

  log(`fetching ${asset} for ${os.platform()}/${os.arch()} from ${url}`);

  // Download to a temp file next to the final path, then move into
  // place. Avoids a partially-written binary at the final path if
  // the download errors out halfway.
  const tmp = `${target}.download.${process.pid}`;
  try {
    await downloadTo(url, tmp);
    await chmod(tmp, 0o755);
    await (await import("node:fs/promises")).rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    die(
      `failed to download ${url}: ${err.message}\n` +
        `If your network blocks github.com releases, you can:\n` +
        `  * set AGENT_HOOKS_SKIP_POSTINSTALL=1 and install manually, or\n` +
        `  * mirror the asset and set AGENT_HOOKS_BINARY to its local path.`,
    );
  }

  resignIfDarwin(target);

  // Record what version the downloaded binary corresponds to so the
  // wrapper can sanity-check on exec. Useful if npm ever loses the
  // binary for a partial-sync reason and we need to know what to
  // re-download without re-reading package.json.
  await writeFile(
    path.join(BIN_DIR, "agent-hooks.version"),
    `${tag}\n`,
    "utf8",
  );

  log(`installed agent-hooks ${tag} to ${target}`);
}

main().catch((err) => {
  die(err.stack || err.message || String(err));
});

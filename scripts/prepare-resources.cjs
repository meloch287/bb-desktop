"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { execFileSync } = require("node:child_process");
const assets = require("./resources.json");
const root = path.resolve(__dirname, "..");

async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function verifiedArchive(asset, cache, provided) {
  await fsp.mkdir(cache, { recursive: true });
  const destination = provided || path.join(cache, asset.file);
  if (fs.existsSync(destination)) {
    if (await hash(destination) !== asset.sha256) throw new Error(`SHA256 mismatch: ${destination}`);
    return destination;
  }
  if (provided) throw new Error(`Official archive does not exist: ${provided}`);
  const partial = destination + ".part";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const offset = fs.existsSync(partial) ? (await fsp.stat(partial)).size : 0;
      const urls = [asset.url, ...(asset.mirrors || [])];
      const response = await fetch(urls[attempt % urls.length], {
        headers: offset ? { Range: `bytes=${offset}-` } : {},
        signal: AbortSignal.timeout(300_000)
      });
      if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${asset.file}`);
      const append = offset > 0 && response.status === 206;
      if (append && !response.headers.get("content-range")?.startsWith(`bytes ${offset}-`)) {
        await response.body.cancel();
        throw new Error("Server returned an invalid download range");
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, { flags: append ? "a" : "w" }));
      break;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  if (await hash(partial) !== asset.sha256) {
    await fsp.rm(partial, { force: true });
    throw new Error(`SHA256 mismatch: ${asset.file}`);
  }
  await fsp.rename(partial, destination);
  return destination;
}

async function sevenZip(cache) {
  if (process.env.BB_7ZIP) return process.env.BB_7ZIP;
  if (process.platform === "darwin") {
    const archive = await verifiedArchive(assets["7zip-darwin"], cache);
    const tools = path.join(cache, "7zip");
    await fsp.mkdir(tools, { recursive: true });
    execFileSync("tar", ["-xf", archive, "-C", tools]);
    return path.join(tools, "7zz");
  }
  const installed = path.join(process.env.ProgramFiles || "C:\\Program Files", "7-Zip", "7z.exe");
  return fs.existsSync(installed) ? installed : "7z";
}

async function prepare(platform, arch) {
  const key = `${platform}-${arch}`;
  const asset = assets[key];
  if (!asset || !/^https:\/\//.test(asset.url) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`No pinned official resource archive for ${key}`);
  const cache = process.env.BB_ASSET_CACHE || path.join(root, "build", "cache");
  const archive = await verifiedArchive(asset, cache, process.env.BB_OFFICIAL_ARCHIVE);
  const destination = path.join(root, "build", "resources", key);
  const temporary = await fsp.mkdtemp(path.join(cache, `extract-${key}-`));
  try {
    let resources;
    if (platform === "darwin") {
      if (process.platform !== "darwin") throw new Error("Mac resources are prepared on macOS");
      execFileSync("ditto", ["-x", "-k", archive, temporary]);
      resources = path.join(temporary, "bb.app", "Contents", "Resources");
    } else {
      const tool = await sevenZip(cache);
      execFileSync(tool, ["x", "-y", `-o${temporary}`, archive], { stdio: "ignore" });
      const app = path.join(temporary, "app");
      execFileSync(tool, ["x", "-y", `-o${app}`, path.join(temporary, "$PLUGINSDIR", "app-64.7z")], { stdio: "ignore" });
      resources = path.join(app, "resources");
    }
    await fsp.mkdir(destination, { recursive: true });
    await fsp.cp(path.join(resources, "xray"), path.join(destination, "xray"), { recursive: true, force: true });
    if (platform === "darwin") {
      await fsp.copyFile(path.join(resources, "icon.icns"), path.join(destination, "icon.icns"));
      await fsp.chmod(path.join(destination, "xray", "xray"), 0o755);
    } else {
      const { NtExecutable, NtExecutableResource, Resource, Data } = await import("resedit");
      const executable = NtExecutable.from(await fsp.readFile(path.join(resources, "..", "bb.exe")), { ignoreCert: true });
      const entries = NtExecutableResource.from(executable).entries;
      const group = Resource.IconGroupEntry.fromEntries(entries)[0];
      if (!group) throw new Error("Official executable contains no icon");
      const icon = new Data.IconFile();
      icon.icons = group.getIconItemsFromEntries(entries).map(data => ({ data }));
      await fsp.writeFile(path.join(destination, "icon.ico"), Buffer.from(icon.generate()));
    }
    await fsp.writeFile(path.join(destination, "provenance.json"), JSON.stringify({ ...asset, platform, arch }, null, 2) + "\n");
    console.log(`Prepared verified official resources: ${key}`);
    return destination;
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = { hash, verifiedArchive, prepare };
if (require.main === module) {
  const [platform = process.platform, arch = process.arch] = process.argv.slice(2);
  prepare(platform, arch).catch(error => { console.error(error.message); process.exitCode = 1; });
}

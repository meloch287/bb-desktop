"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const http = require("node:http");
const script = path.join(__dirname, "prepare-resources.cjs");

test("download verifies cached files and rejects a corrupt official archive", async (t) => {
  assert.ok(require("node:fs").existsSync(script), "verified resource downloader must exist");
  const { verifiedArchive } = require(script);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-build-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "official.zip");
  await fs.writeFile(archive, "official bytes");
  const sha256 = createHash("sha256").update("official bytes").digest("hex");
  assert.equal(await verifiedArchive({ file: "official.zip", sha256 }, dir, archive), archive);
  await fs.writeFile(archive, "corrupt bytes");
  await assert.rejects(verifiedArchive({ file: "official.zip", sha256 }, dir, archive), /SHA256/);
});

test("download resumes a partial response and publishes only verified bytes", async (t) => {
  assert.ok(require("node:fs").existsSync(script), "verified resource downloader must exist");
  const { verifiedArchive } = require(script);
  const bytes = Buffer.from("official archive content");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-build-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let requestedRange;
  const server = http.createServer((req, res) => {
    requestedRange = req.headers.range;
    res.writeHead(206, { "Content-Range": `bytes 8-${bytes.length - 1}/${bytes.length}` });
    res.end(bytes.subarray(8));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fs.writeFile(path.join(dir, "official.zip.part"), bytes.subarray(0, 8));
  const asset = { file: "official.zip", url: `http://127.0.0.1:${server.address().port}/archive`, sha256: createHash("sha256").update(bytes).digest("hex") };
  assert.deepEqual(await fs.readFile(await verifiedArchive(asset, dir)), bytes);
  assert.equal(requestedRange, "bytes=8-");
});

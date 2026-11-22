"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { parseHTML } = require("linkedom");

const sourceRoot = path.resolve(__dirname, "..");
const PRIMARY = "https://bb.2.29.166.225.sslip.io";
const LEGACY = "https://www.daktntgos.ru";
const CONFIGURED_PROXY = "http://proxy.fixture.invalid:8083";
const { parseLink } = require(path.join(sourceRoot, "src/link.js"));
const canonical = parseLink(`https://u123.bb.200-165-236-8.sslip.io/__app/${"a".repeat(64)}/`);

function section(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section ${start}`);
  return text.slice(from, to);
}

const HEALTHY_HTML = '<div id="root"><main>Workspace</main></div>';
const BOOT_HTML = '<div id="root"><div class="bb-boot">Открываю bb…</div></div>';
const CHUNK_PATH = "/assets/SplitWorkspaceRoute-C2pcDePu-terminal-b2924be27c8c.js";
function boundaryHtml(error = `TypeError: Failed to fetch dynamically imported module: ${PRIMARY}${CHUNK_PATH}`) {
  return `<div id="root"><div class="w-full max-w-md rounded-lg border border-border bg-card p-6"><h1 class="text-base font-medium">В bb произошла ошибка</h1><p>Можно безопасно обновить страницу. Диалоги хранятся на сервере.</p><details class="mt-4"><summary class="cursor-pointer text-sm text-muted-foreground">Подробности ошибки </summary><pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-xs">${error}</pre></details><button type="button" class="mt-4 w-full cursor-pointer rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">Перезагрузить bb </button></div></div>`;
}

// Execute production routing and renderer inspection against parsed DOM fixtures.
function routing({ direct = [], proxied = [], configured = [], networkConfig = null, edgeOverride = null, failConfiguredApply = false, daemonEnabled = false } = {}) {
  const text = fs.readFileSync(path.join(sourceRoot, "src/main.js"), "utf8");
  let usingProxy = null;
  let ownedProxyStops = 0;
  let proxyGeneration = 0;
  let daemonStartWork = async () => {};
  let inspectionWork = async (inspect) => inspect();
  let windowUrl;
  let html = BOOT_HTML;
  let now = 0, nextTimer = 0;
  const timers = new Map();
  const daemonStarts = [];
  const daemonProxyUrls = [];
  const handlers = new Map();
  const writes = [];
  const proxyChanges = [];
  const loads = [];
  const logs = [];
  const preloadWrites = [];
  const contents = new EventEmitter();
  contents.getURL = () => windowUrl ?? context.connection.url;
  contents.executeJavaScript = async (script) => {
    const { document } = parseHTML(html);
    // Match Chromium visibility: closed details hide pre.innerText, but retain textContent.
    for (const pre of document.querySelectorAll("details:not([open]) pre"))
      Object.defineProperty(pre, "innerText", { value: "" });
    return inspectionWork(() => vm.runInNewContext(script, {
      document, location: new URL(contents.getURL()), URL,
    }));
  };
  const context = vm.createContext({
    connection: structuredClone(canonical),
    route: null,
    proxy: null,
    fetch: async () => {},
    sesFetch: async () => {},
    AbortSignal, URL,
    __dirname: path.join(sourceRoot, "src"),
    join: path.join,
    readFileSync: fs.readFileSync,
    writeFileSync: (file, bytes) => preloadWrites.push({ file, bytes }),
    localRoot: () => "/isolated-host",
    readJson: name => name === "network.json" ? networkConfig : null,
    overrideEdge: () => edgeOverride,
    Date: class extends Date { static now() { return now; } },
    fromLocalPage: () => true,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    edge: { reachable: async (link) => (usingProxy === CONFIGURED_PROXY ? configured : usingProxy ? proxied : direct).includes(link.origin) },
    applyProxy: async (url) => {
      usingProxy = url;
      proxyChanges.push(url);
      if (failConfiguredApply && url === CONFIGURED_PROXY) throw new Error("Fixture proxy setup failure");
    },
    startProxy: async () => {
      context.proxy?.stop();
      context.proxy = { url: `http://127.0.0.1:${10000 + ++proxyGeneration}`, stop() { ownedProxyStops++; } };
      await context.applyProxy(context.proxy.url);
    },
    writeJson: (file, value) => writes.push({ file, value }),
    logLocal: line => logs.push(line),
    clearTimeout: (id) => timers.delete(id),
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    showConnect() {},
    showLocal() { windowUrl = "file:///isolated-offline-fixture.html"; },
    win: { isDestroyed: () => false, webContents: contents,
      loadURL(url) { loads.push(url); windowUrl = url; html = HEALTHY_HTML; },
    },
    localHost: {
      state: () => ({ enabled: daemonEnabled }),
      stop: async () => {},
      start: async (link) => {
        daemonStarts.push(structuredClone(link));
        daemonProxyUrls.push(context.proxy?.url ?? null);
        await daemonStartWork(link);
      },
    },
  });
  vm.runInContext(
    section(text, "const MIRRORS =", "async function openWorkspace(") +
      section(text, "async function openWorkspace(", "function createWindow()") +
      section(text, "async function deviceRequest(method, path)", "function logLocal(line)") +
      section(text, 'ipcMain.handle("bb:retry"', "// ---------- старт"),
    context,
  );
  function nextWatch() {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(next, "Expected an active startup observation");
    timers.delete(next[0]);
    now = next[1].at;
    return next[1].callback();
  }
  async function advance(ms) {
    const until = now + ms;
    while ([...timers.values()].some(timer => timer.at <= until)) await nextWatch();
    now = until;
  }
  const waitForDaemon = () => vm.runInContext('typeof hostRouteChange === "undefined" ? Promise.resolve() : hostRouteChange', context);
  return {
    async choose() {
      await vm.runInContext("ensureRoute()", context);
      return context.connection;
    },
    async failBoot() {
      html = BOOT_HTML;
      vm.runInContext("watchWorkspace()", context);
      await advance(30_000);
      await waitForDaemon();
      return context.connection;
    },
    setReachability(nextDirect, nextProxied = proxied, nextConfigured = configured) { direct = nextDirect; proxied = nextProxied; configured = nextConfigured; },
    async retry() { await handlers.get("bb:retry")({}); return context.connection; },
    setWindowUrl(url) { windowUrl = url; },
    async failNavigation() {
      html = HEALTHY_HTML;
      vm.runInContext("watchWorkspace()", context);
      contents.emit("did-fail-load", {}, -105, "fixture failure", context.connection.url, true);
      await advance(30_000);
      await waitForDaemon();
      return context.connection;
    },
    startWatching() { html = HEALTHY_HTML; vm.runInContext("watchWorkspace()", context); },
    setHtml(value) { html = value; },
    setInspectionWork(value) { inspectionWork = value; },
    nextWatch,
    advance,
    loads,
    contents,
    get currentOrigin() { return context.connection.origin; },
    get currentProxy() { return context.proxy?.url ?? null; },
    get ownedProxyStarts() { return proxyGeneration; },
    get ownedProxyStops() { return ownedProxyStops; },
    get currentMode() { return writes.filter(entry => entry.file === "route.json").at(-1)?.value.mode; },
    localProxy: () => vm.runInContext("localProxy()", context),
    stopSelectedProxy() { context.proxy?.stop(); },
    logs,
    preloadWrites,
    get currentUrl() { return contents.getURL(); },
    get pendingWatches() { return timers.size; },
    waitForDaemon,
    setDaemonStartWork(work) { daemonStartWork = work; },
    async recoverDeviceRequest() {
      let first = true;
      context.sesFetch = async (url) => {
        if (first) { first = false; throw new Error("Fixture transport failed"); }
        return { ok: true, text: async () => JSON.stringify({ origin: new URL(url).origin }) };
      };
      return vm.runInContext('deviceRequest("GET", "/api/v1/hosts")', context);
    },
    daemonStarts,
    daemonProxyUrls,
    writes,
    proxyChanges,
  };
}

test("new VPS is preferred even while canonical and legacy endpoints are healthy", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY, canonical.origin] });
  assert.equal((await app.choose()).origin, PRIMARY);
  assert.deepEqual(app.proxyChanges, [null]);
});

test("optional configured HTTP proxy takes priority for the primary mirror", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], configured: [PRIMARY], networkConfig: { mirrorProxy: CONFIGURED_PROXY } });
  const selected = await app.choose();
  assert.equal(selected.origin, PRIMARY);
  assert.equal(selected.home.url, canonical.url);
  assert.equal(app.currentMode, "configured-mirror");
  assert.deepEqual(app.proxyChanges, [CONFIGURED_PROXY]);
  assert.equal(app.localProxy().url, CONFIGURED_PROXY);
  assert.equal(app.preloadWrites.length, 1);
  assert.equal(app.ownedProxyStarts, 0, "external proxy must not create an owned process");
  app.stopSelectedProxy();
  assert.equal(app.ownedProxyStops, 0);
  assert.ok(app.logs.every(line => !line.includes("proxy.fixture.invalid")), "do not log local proxy configuration");
});

test("supported HTTP proxy URLs normalize root paths and accept DNS names or IPv4", async () => {
  for (const mirrorProxy of [CONFIGURED_PROXY + "/", "HTTP://PROXY.FIXTURE.INVALID:8083/", "http://127.0.0.1:8083", "http://localhost:8083"]) {
    const app = routing({ configured: [PRIMARY], proxied: [PRIMARY], networkConfig: { mirrorProxy } });
    await app.choose();
    assert.equal(app.currentMode, "configured-mirror");
    assert.equal(app.currentProxy, new URL(mirrorProxy).origin);
  }
});

test("an unreachable configured proxy falls back to the direct primary mirror", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], networkConfig: { mirrorProxy: CONFIGURED_PROXY } });
  assert.equal((await app.choose()).origin, PRIMARY);
  assert.deepEqual(app.proxyChanges, [CONFIGURED_PROXY, null]);
  assert.equal(app.currentProxy, null);
  assert.equal(app.currentMode, "mirror");
});

test("a rejected configured session proxy does not disrupt direct fallback", async () => {
  const app = routing({ direct: [LEGACY], failConfiguredApply: true, networkConfig: { mirrorProxy: CONFIGURED_PROXY } });
  assert.equal((await app.choose()).origin, LEGACY);
  assert.deepEqual(app.proxyChanges, [CONFIGURED_PROXY, null]);
  assert.equal(app.localProxy(), null);
});

test("unsupported or unsafe local proxy settings are ignored without disclosure", async () => {
  const invalid = [null, true, 42, {}, [], "", "https://proxy.fixture.invalid:8083", "socks5://proxy.fixture.invalid", "http://user:fixture-secret@proxy.fixture.invalid", "http://@proxy.fixture.invalid", "http://proxy.fixture.invalid/path", "http://proxy.fixture.invalid?", "http://proxy.fixture.invalid#", "http://proxy.fixture.invalid?q=fixture-secret", "http://proxy.fixture.invalid/#fixture-secret", "http://[::1]:8083", "http://proxy.fixture.invalid;https=direct", "http://proxy.fixture.invalid,other.invalid", "http://proxy=fixture.invalid", "http://proxy.fixture.invalid\n"];
  for (const mirrorProxy of invalid) {
    const app = routing({ direct: [PRIMARY], configured: [PRIMARY], networkConfig: { mirrorProxy } });
    assert.equal((await app.choose()).origin, PRIMARY);
    assert.deepEqual(app.proxyChanges, [null]);
    assert.equal(app.localProxy(), null);
    assert.ok(app.logs.every(line => !line.includes("fixture-secret") && !line.includes("proxy.fixture.invalid")));
  }
});

test("a stuck configured route falls back to direct at the same origin and migrates the daemon", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], configured: [PRIMARY], networkConfig: { mirrorProxy: CONFIGURED_PROXY }, daemonEnabled: true });
  await app.choose();
  assert.equal((await app.failBoot()).origin, PRIMARY);
  assert.equal(app.currentMode, "mirror");
  assert.deepEqual(app.daemonProxyUrls, [null]);
  assert.equal(app.daemonStarts[0].home.url, canonical.url);
  assert.equal(app.ownedProxyStarts, 0);
});

test("switching from owned proxy to configured proxy stops only the owned process", async () => {
  const app = routing({ proxied: [PRIMARY], networkConfig: { mirrorProxy: CONFIGURED_PROXY }, daemonEnabled: true });
  await app.choose();
  assert.equal(app.currentProxy, "http://127.0.0.1:10001");
  app.setReachability([], [PRIMARY], [PRIMARY]);
  await app.retry();
  await app.waitForDaemon();
  assert.equal(app.currentMode, "configured-mirror");
  assert.equal(app.ownedProxyStarts, 1);
  assert.equal(app.ownedProxyStops, 1);
  assert.deepEqual(app.daemonProxyUrls, [CONFIGURED_PROXY]);
  app.stopSelectedProxy();
  assert.equal(app.ownedProxyStops, 1, "external proxy has no owned process to terminate");
});

test("configured chunk recovery excludes that origin on every transport", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], configured: [PRIMARY], networkConfig: { mirrorProxy: CONFIGURED_PROXY } });
  await app.choose();
  app.startWatching();
  app.setHtml(boundaryHtml());
  await app.advance(30_000);
  app.setHtml(boundaryHtml());
  await app.advance(30_000);
  assert.deepEqual(app.loads.map(url => new URL(url).origin), [PRIMARY, LEGACY]);
  assert.equal(app.currentProxy, null);
});

test("a partial Electron proxy rejection does not leave a stale direct-mode cache", async () => {
  const source = fs.readFileSync(path.join(sourceRoot, "src/main.js"), "utf8");
  const applied = [];
  let rejectConfigured = true;
  const sessions = [0, 1, 2].map(index => ({
    async setProxy(config) {
      applied.push({ index, config });
      if (index === 1 && config.proxyRules === CONFIGURED_PROXY && rejectConfigured) {
        rejectConfigured = false;
        throw new Error("Fixture session configuration rejected");
      }
    },
    async closeAllConnections() {},
  }));
  const context = vm.createContext({ bbSession: () => sessions[0], session: { defaultSession: sessions[1], fromPartition: () => sessions[2] } });
  vm.runInContext(section(source, "let appliedProxy;", "function savedOutbound()"), context);
  await vm.runInContext("applyProxy(null)", context);
  await assert.rejects(vm.runInContext(`applyProxy(${JSON.stringify(CONFIGURED_PROXY)})`, context));
  await vm.runInContext("applyProxy(null)", context);
  assert.deepEqual(applied.slice(-3).map(item => [item.index, item.config.mode]), [[0, "direct"], [1, "direct"], [2, "direct"]]);
});

test("update metadata and feed selection prefer the new relay while retaining fallback order", async () => {
  const source = fs.readFileSync(path.join(sourceRoot, "src/main.js"), "utf8");
  const bases = [PRIMARY + "/download/desktop/", "https://ai-bot-miniapp.miniapp-edge.workers.dev/download/desktop/", LEGACY + "/download/desktop/"];
  for (let successful = 0; successful < bases.length; successful++) {
    const calls = [];
    const context = vm.createContext({
      MIRRORS: [PRIMARY, LEGACY], AbortSignal,
      sesFetch: async (url, options) => {
        calls.push(url);
        assert.equal(options.cache, "no-store");
        return { ok: url.startsWith(bases[successful]), status: 503, json: async () => ({ version: "fixture" }) };
      },
    });
    vm.runInContext(section(source, "const FEED_BASES =", "function older("), context);
    assert.equal((await vm.runInContext('feedJson("mac/latest.json")', context)).version, "fixture");
    assert.deepEqual(calls, bases.slice(0, successful + 1).map(base => base + "mac/latest.json"));
    calls.length = 0;
    assert.equal(await vm.runInContext('pickFeed("latest.yml")', context), bases[successful]);
    assert.deepEqual(calls, bases.slice(0, successful + 1).map(base => base + "latest.yml"));
  }
});

test("Windows updater uses the selected first feed instead of its packaged legacy default", async () => {
  const source = fs.readFileSync(path.join(sourceRoot, "src/main.js"), "utf8");
  const selected = [];
  const base = PRIMARY + "/download/desktop/";
  const context = vm.createContext({
    app: { isPackaged: true }, IS_MAC: false, FEED_BASES: [base],
    pickFeed: async () => base,
    setupUpdater: () => ({ setFeedURL: config => selected.push(config.url), checkForUpdates: async () => ({}) }),
  });
  vm.runInContext(section(source, "let updater =", "const FEED_BASES ="), context);
  vm.runInContext("checkUpdates()", context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(selected, [base]);
});

test("proxy bootstrap prefers the new relay, preserves fallback URLs and leaves the profile unchanged", async () => {
  const source = fs.readFileSync(path.join(sourceRoot, "src/main.js"), "utf8");
  const realEdge = require(path.join(sourceRoot, "src/edge.js"));
  const bases = [PRIMARY + "/__edge/proxy?d=", ...realEdge.EDGE_URLS];
  for (const successful of [0, 1, bases.length - 1]) {
    const calls = [], writes = [], started = [];
    const outbound = { protocol: "fixture", settings: { marker: "fixture-profile-secret" } };
    const context = vm.createContext({
      MIRRORS: [PRIMARY, LEGACY], connection: { ...canonical, origin: PRIMARY, home: canonical },
      proxy: null, join: path.join,
      edge: { ...realEdge, startXray: async options => { started.push(options.outbound); return { url: "http://127.0.0.1:10001", stop() {} }; } },
      sesFetch: async url => {
        calls.push(url);
        return { ok: url.startsWith(bases[successful]), status: 503, json: async () => ({ outbound }) };
      },
      safeStorage: { isEncryptionAvailable: () => false },
      writeJson: (...args) => writes.push(args),
      savedOutbound: () => null, overrideEdge: () => null,
      xrayExe: () => "/isolated-xray", app: { getPath: () => "/isolated-data" },
      applyProxy: async () => {}, logLocal() {},
    });
    vm.runInContext(section(source, "async function startProxy()", "// HTTPS-входы"), context);
    await vm.runInContext("startProxy()", context);
    assert.deepEqual(calls, bases.slice(0, successful + 1).map(base => base + "a".repeat(64)));
    assert.equal(started[0], outbound, "bootstrap must forward the server profile unchanged");
    assert.deepEqual(writes, [], "without encryption, profile secrets must not be persisted");
  }
});

test("legacy HTTPS mirror is used when the new VPS is unavailable", async () => {
  const app = routing({ direct: [LEGACY, canonical.origin] });
  assert.equal((await app.choose()).origin, LEGACY);
});

test("canonical endpoint remains a fallback if both mirrors are unavailable", async () => {
  const app = routing({ direct: [canonical.origin] });
  assert.equal((await app.choose()).origin, canonical.origin);
});

test("mirror selection preserves canonical device identity without persisting a replacement login", async () => {
  const app = routing({ direct: [PRIMARY] });
  const selected = await app.choose();
  assert.equal(selected.origin, PRIMARY);
  assert.equal(selected.prefix, canonical.prefix);
  assert.equal(selected.home.url, canonical.url);
  assert.equal(selected.home.origin, canonical.origin);
  assert.ok(app.writes.every(({ file }) => file === "route.json"));
});

test("a stuck new mirror falls back to the legacy mirror and moves the local daemon with it", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY, canonical.origin], daemonEnabled: true });
  assert.equal((await app.choose()).origin, PRIMARY);
  assert.equal((await app.failBoot()).origin, LEGACY);
  assert.equal(app.daemonStarts.length, 1);
  assert.equal(app.daemonStarts[0].origin, LEGACY);
  assert.equal(app.daemonStarts[0].home.url, canonical.url);
});

test("boot fallback tries each mirror independently through direct and existing proxy transport", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY, canonical.origin], proxied: [PRIMARY, LEGACY, canonical.origin] });
  const observed = [(await app.choose()).origin];
  for (let i = 0; i < 6; i++) observed.push((await app.failBoot()).origin);
  assert.deepEqual(observed, [PRIMARY, LEGACY, canonical.origin, PRIMARY, LEGACY, canonical.origin, PRIMARY]);
});

test("manual retry moves a running daemon to the newly selected mirror", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], daemonEnabled: true });
  await app.choose();
  app.setReachability([LEGACY]);
  assert.equal((await app.retry()).origin, LEGACY);
  await app.waitForDaemon();
  assert.equal(app.daemonStarts.length, 1);
  assert.equal(app.daemonStarts[0].origin, LEGACY);
});

test("device request recovery moves the daemon with the recovered transport", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], daemonEnabled: true });
  await app.choose();
  app.setReachability([LEGACY]);
  assert.equal((await app.recoverDeviceRequest()).origin, LEGACY);
  await app.waitForDaemon();
  assert.equal(app.daemonStarts.length, 1);
  assert.equal(app.daemonStarts[0].origin, LEGACY);
});

test("fallback cycle recovers to a mirror when canonical is permanently unreachable", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], proxied: [PRIMARY, LEGACY] });
  const observed = [(await app.choose()).origin];
  for (let i = 0; i < 4; i++) observed.push((await app.failBoot()).origin);
  assert.deepEqual(observed, [PRIMARY, LEGACY, PRIMARY, LEGACY, PRIMARY]);
});

test("unreachable transports report an offline error instead of selecting a dead proxy route", async () => {
  const app = routing();
  await assert.rejects(app.choose(), /подключиться/);
});

test("a recreated local proxy updates the daemon even when the mirror origin stays the same", async () => {
  const app = routing({ proxied: [PRIMARY], daemonEnabled: true });
  assert.equal((await app.choose()).origin, PRIMARY);
  assert.equal((await app.retry()).origin, PRIMARY);
  await app.waitForDaemon();
  assert.equal(app.daemonStarts.length, 1);
  assert.deepEqual(app.daemonProxyUrls, ["http://127.0.0.1:10002"]);
});

test("a slow daemon preparation does not block selecting a healthy replacement mirror", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], daemonEnabled: true });
  await app.choose();
  app.setReachability([LEGACY]);
  let release;
  app.setDaemonStartWork(() => new Promise(resolve => { release = resolve; }));
  let completed = false;
  const choice = app.retry().then(link => { completed = true; return link; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, true, "window must not wait for runtime download or daemon startup");
    assert.equal((await choice).origin, LEGACY);
  } finally {
    release?.();
    await choice;
    await app.waitForDaemon();
  }
});

test("official 1.4.1 navigation failure detection still falls back from the primary mirror", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY, canonical.origin] });
  assert.equal((await app.choose()).origin, PRIMARY);
  assert.equal((await app.failNavigation()).origin, LEGACY);
});

test("official 1.4.1 local offline page does not trigger a background route change", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY, canonical.origin] });
  const selected = (await app.choose()).origin;
  app.setWindowUrl("file:///isolated-offline-fixture.html");
  assert.equal((await app.failBoot()).origin, selected);
});

test("a late failed dynamic import in closed error details reloads the same route once", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], daemonEnabled: true });
  await app.choose();
  app.startWatching();
  await app.advance(49_000);
  assert.equal(app.loads.length, 0, "healthy 30-second check must keep observing");
  app.setHtml(boundaryHtml());
  await app.advance(1_000);
  assert.deepEqual(app.loads.map(url => new URL(url).origin), [PRIMARY]);
  assert.equal(app.daemonStarts.length, 0, "retrying the same route preserves the daemon");
});

test("a second chunk failure moves to another origin and exhausts automatic recovery", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY], daemonEnabled: true });
  await app.choose();
  app.startWatching();
  app.setHtml(boundaryHtml());
  await app.advance(30_000);
  app.setHtml(boundaryHtml());
  await app.advance(30_000);
  assert.deepEqual(app.loads.map(url => new URL(url).origin), [PRIMARY, LEGACY]);
  await app.waitForDaemon();
  assert.equal(app.daemonStarts.length, 1);
  assert.equal(app.daemonStarts[0].home.url, canonical.url);
  app.setHtml(boundaryHtml(`TypeError: Failed to fetch dynamically imported module: ${LEGACY}${CHUNK_PATH}`));
  await app.advance(180_000);
  assert.equal(app.loads.length, 2, "persistent error must not create a reload loop");
  assert.equal(app.pendingWatches, 0);
});

test("chunk recovery excludes the failed origin even when its proxy route is reachable", async () => {
  const app = routing({ direct: [PRIMARY], proxied: [PRIMARY] });
  await app.choose();
  app.startWatching();
  app.setHtml(boundaryHtml());
  await app.advance(30_000);
  app.setHtml(boundaryHtml());
  await app.advance(30_000);
  assert.equal(app.loads.length, 1, "no alternate origin means no second same-origin navigation");
  assert.match(app.currentUrl, /^file:/);
});

test("ordinary application errors, other origins, and quoted chat failures do not reload", async () => {
  const examples = [
    boundaryHtml("TypeError: Cannot read properties of undefined"),
    boundaryHtml(`TypeError: Failed to fetch dynamically imported module: https://example.invalid${CHUNK_PATH}`),
    boundaryHtml(`TypeError: Failed to fetch dynamically imported module: ${PRIMARY}/api/v1/example.js`),
    `<div id="root"><main><p>В bb произошла ошибка</p><details><summary>Подробности ошибки</summary><pre>TypeError: Failed to fetch dynamically imported module: ${PRIMARY}${CHUNK_PATH}</pre></details><p>Перезагрузить bb</p></main></div>`,
  ];
  for (const html of examples) {
    const app = routing({ direct: [PRIMARY, LEGACY] });
    await app.choose();
    app.startWatching();
    app.setHtml(html);
    await app.advance(120_000);
    assert.equal(app.loads.length, 0);
    assert.equal(app.pendingWatches, 0);
  }
});

test("startup observation stops at 90 seconds and removes its failure listener", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY] });
  await app.choose();
  app.startWatching();
  await app.advance(90_000);
  assert.equal(app.pendingWatches, 0);
  assert.equal(app.contents.listenerCount("did-fail-load"), 0);
  app.setHtml(boundaryHtml());
  await app.advance(120_000);
  assert.equal(app.loads.length, 0);
});

test("the 90-second deadline cleans up even if renderer inspection never settles", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY] });
  await app.choose();
  app.startWatching();
  app.setHtml(boundaryHtml());
  let release;
  app.setInspectionWork(inspect => new Promise(resolve => { release = () => resolve(inspect()); }));
  const pendingCheck = app.nextWatch();
  await new Promise(resolve => setImmediate(resolve));
  await app.advance(90_000);
  assert.equal(app.contents.listenerCount("did-fail-load"), 0);
  assert.equal(app.pendingWatches, 0);
  release();
  await pendingCheck;
  assert.equal(app.loads.length, 0, "an expired inspection must not recover later");
});

test("an old asynchronous inspection cannot reload a newer same-route navigation", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY] });
  await app.choose();
  app.startWatching();
  app.setHtml(boundaryHtml());
  let release;
  app.setInspectionWork(inspect => new Promise(resolve => { release = () => resolve(inspect()); }));
  const oldCheck = app.nextWatch();
  await new Promise(resolve => setImmediate(resolve));
  app.startWatching();
  app.setInspectionWork(async inspect => inspect());
  release();
  await oldCheck;
  assert.equal(app.loads.length, 0);
  assert.equal(app.pendingWatches, 2, "one observation and its independent deadline");
  assert.equal(app.contents.listenerCount("did-fail-load"), 1);
});

test("a route change during inspection removes the obsolete navigation listener", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY] });
  await app.choose();
  app.startWatching();
  let release;
  app.setInspectionWork(inspect => new Promise(resolve => { release = () => resolve(inspect()); }));
  const oldCheck = app.nextWatch();
  await new Promise(resolve => setImmediate(resolve));
  app.setReachability([LEGACY]);
  await app.recoverDeviceRequest();
  release();
  await oldCheck;
  assert.equal(app.loads.length, 0);
  assert.equal(app.contents.listenerCount("did-fail-load"), 0);
});

test("subframe failures do not consume the main-frame navigation failure observer", async () => {
  const app = routing({ direct: [PRIMARY, LEGACY] });
  await app.choose();
  app.startWatching();
  app.contents.emit("did-fail-load", {}, -105, "subframe fixture", `${PRIMARY}/frame`, false);
  app.contents.emit("did-fail-load", {}, -105, "main-frame fixture", app.currentUrl, true);
  await app.advance(30_000);
  assert.equal(app.currentOrigin, LEGACY);
});

for (const configured of [false, true]) test(configured
  ? "the real host daemon receives the configured HTTP proxy without changing its identity"
  : "existing host identity resumes on selected mirror without enrollment or real processes", async (t) => {
  const fixturePrefix = path.resolve(__dirname, "../.test-artifacts/host-fixture-");
  fs.mkdirSync(path.dirname(fixturePrefix), { recursive: true });
  const fixture = fs.mkdtempSync(fixturePrefix);
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "data"));
  const originalState = { enabled: true, hostId: "host_fixture", origin: canonical.origin, port: 47123 };
  fs.writeFileSync(path.join(fixture, "state.json"), JSON.stringify(originalState));
  fs.writeFileSync(path.join(fixture, "data/host-id"), "host_fixture");
  fs.writeFileSync(path.join(fixture, "data/auth.json"), '{"fixture":true}');
  const invocations = [];
  const originalRequire = createRequire(path.join(sourceRoot, "src/local-host.js"));
  const child = new EventEmitter();
  Object.assign(child, { pid: 123456789, exitCode: null });
  const context = vm.createContext({
    module: { exports: {} },
    require(name) {
      if (name === "node:child_process") return {
        spawn: (command, args, options) => { invocations.push({ command, args, options }); return child; },
        spawnSync: () => ({ status: 0 }),
      };
      if (name === "node:net") return {
        createServer: () => {
          const server = { once() { return server; }, listen(_port, _host, done) { done(); }, close(done) { done?.(); } };
          return server;
        },
      };
      return originalRequire(name);
    },
    process: { env: {}, platform: "darwin", arch: "arm64", execPath: process.execPath, kill() { throw new Error("No live fixture process"); } },
    Buffer, URL, AbortSignal, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, "src/local-host.js"), "utf8"), context);
  const app = routing(configured ? { configured: [PRIMARY], networkConfig: { mirrorProxy: CONFIGURED_PROXY } } : { direct: [PRIMARY] });
  const selected = await app.choose();
  const selectedProxy = app.localProxy();
  const host = context.module.exports.createLocalHost({
    proxy: () => selectedProxy,
    root: fixture,
    request: async () => { throw new Error("Enrollment must not be called"); },
    fetchFn: async () => { throw new Error("Offline runtime fixture"); },
  });
  assert.equal(await host.start(selected), true);
  assert.equal(invocations.length, 1);
  const launch = invocations[0];
  assert.ok(launch.args.includes("--supervise"));
  assert.ok(!launch.args.includes("join"));
  assert.equal(launch.args[launch.args.indexOf("--server-url") + 1], PRIMARY + canonical.prefix);
  assert.equal(launch.options.env.ANTHROPIC_BASE_URL, PRIMARY + "/__anthropic");
  if (configured) {
    assert.equal(launch.options.env.HTTP_PROXY, CONFIGURED_PROXY);
    assert.equal(launch.options.env.HTTPS_PROXY, CONFIGURED_PROXY);
    assert.equal(launch.options.env.BB_TUNNEL_PROXY, CONFIGURED_PROXY);
    assert.equal(launch.options.env.NODE_USE_ENV_PROXY, "1");
    assert.match(launch.options.env.NODE_OPTIONS, /proxy-tls\.cjs/);
    assert.ok(new RegExp(launch.options.env.BB_TUNNEL_HOSTS).test(new URL(PRIMARY).hostname));
  } else {
    assert.equal(launch.options.env.BB_TUNNEL_PROXY, undefined);
  }
  assert.equal(JSON.parse(launch.options.env.BB_SERVER_HEADERS)["x-ai-device"], "a".repeat(64));
  const state = JSON.parse(fs.readFileSync(path.join(fixture, "state.json"), "utf8"));
  assert.equal(state.hostId, originalState.hostId);
  assert.equal(state.origin, canonical.origin);
  assert.equal(fs.readFileSync(path.join(fixture, "data/auth.json"), "utf8"), '{"fixture":true}');
  assert.match(fs.readFileSync(path.join(fixture, "codex-home/config.toml"), "utf8"), /bb\.2\.29\.166\.225\.sslip\.io\/__inference\/v1/);
});

test("Windows 1.4.2 explicit edge override keeps proxy priority over direct and configured routes", async () => {
  const app = routing({
    edgeOverride: { outbound: { protocol: "fixture" } },
    direct: [PRIMARY, LEGACY, canonical.origin], proxied: [PRIMARY, LEGACY],
    configured: [PRIMARY], networkConfig: { mirrorProxy: CONFIGURED_PROXY },
  });
  assert.equal((await app.choose()).origin, PRIMARY);
  assert.equal(app.currentMode, "proxy-mirror");
  assert.equal(app.ownedProxyStarts, 1);
  assert.equal((await app.failBoot()).origin, LEGACY);
  assert.equal(app.currentMode, "proxy-mirror");
});

test("Windows override reads executable directory first and falls back to user data", () => {
  const source = fs.readFileSync(path.join(sourceRoot, "src/main.js"), "utf8");
  for (const first of [null, "broken", { outbound: { protocol: "first" } }]) {
    const context = vm.createContext({
      dirname: path.dirname, join: path.join, process: { execPath: "/installed/bb.exe" },
      app: { getPath: () => "/data" },
      readFileSync(file) {
        const data = file.startsWith("/installed/") ? first : { outbound: { protocol: "second" } };
        if (data === null) throw new Error("not found");
        return data === "broken" ? "{" : JSON.stringify(data);
      },
    });
    vm.runInContext(section(source, "function overrideEdge()", "async function startProxy()"), context);
    assert.equal(vm.runInContext("overrideEdge().outbound.protocol", context), first?.outbound ? "first" : "second");
  }
});

test("explicit edge profile reaches Xray unchanged without remote bootstrap or persistence", async () => {
  const source = fs.readFileSync(path.join(sourceRoot, "src/main.js"), "utf8");
  const outbound = { protocol: "fixture", settings: { marker: "fixture-secret" } };
  const started = [], applied = [];
  const context = vm.createContext({
    overrideEdge: () => ({ outbound }), proxy: null, join: path.join,
    app: { getPath: () => "/data" }, xrayExe: () => "/xray", logLocal() {},
    edge: { startXray: async options => { started.push(options.outbound); return { url: "http://127.0.0.1:10001" }; },
      fetchOutbound: async () => { throw new Error("unexpected remote bootstrap"); } },
    applyProxy: async url => applied.push(url),
  });
  vm.runInContext(section(source, "async function startProxy()", "// HTTPS-входы"), context);
  await vm.runInContext("startProxy()", context);
  assert.equal(started[0], outbound);
  assert.deepEqual(applied, ["http://127.0.0.1:10001"]);
});

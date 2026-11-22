// «Работать на этом компьютере»: ПК или Mac становится машиной bb пользователя.
// Всё нужное (Node, bb-app, Codex, Claude Code, на Windows ещё Git Bash) качается только с нашего
// сервера и сверяется по sha256. Модели на ПК ходят на сервер с токеном
// устройства: GPT — /__inference (общая подписка, лимиты), Claude — /__anthropic
// (строго через прокси сервера). Своих входов в ChatGPT/Claude на ПК не нужно.
// Без Electron: модуль проверяется под обычным Node (test/local-host.test.js).
"use strict";

const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");

const RUNTIME_URL = "https://aibot.200.165.236.8.sslip.io/download/desktop/runtime/";
const MIRROR_RUNTIME_URL = "https://www.daktntgos.ru/download/desktop/runtime/";
/**
 * Откуда качать компоненты, по порядку: при работе через зеркало — с него, иначе напрямую,
 * а если сервер напрямую не отвечает (из-за границы, с VPN) — через зеркало.
 */
const runtimeBase = (link) => {
  const mirror = link?.home ? `${link.origin}/download/desktop/runtime/` : MIRROR_RUNTIME_URL;
  return link?.home ? [mirror, RUNTIME_URL] : [RUNTIME_URL, mirror];
};

const CODEX_TRIPLE = { win32: "x86_64-pc-windows-msvc", "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin" };

/** Пути и исполняемые файлы на этой ОС (на Linux — для проверки). */
function layout(root, platform = process.platform, arch = process.arch) {
  const win = platform === "win32", mac = platform === "darwin";
  const rt = path.join(root, "runtime");
  return {
    root, rt, win, mac, arch,
    // Список компонентов на сервере: у Windows — прежний runtime.json (его читают и старые версии).
    manifest: mac ? `runtime-darwin-${arch === "arm64" ? "arm64" : "x64"}.json` : "runtime.json",
    data: path.join(root, "data"),
    codexHome: path.join(root, "codex-home"),
    claudeHome: path.join(root, "claude-home"),
    bin: path.join(root, "bin"),
    state: path.join(root, "state.json"),
    log: path.join(root, "daemon.log"),
    node: win ? path.join(rt, "node", "node.exe") : mac ? path.join(rt, "node", "bin", "node") : process.execPath,
    bbApp: path.join(rt, "bb", "node_modules", "bb-app", "dist", "bb-app.js"),
    bbCli: path.join(rt, "bb", "node_modules", "bb-app", "dist", "bb.js"),
    claude: path.join(rt, "claude", "package", win ? "claude.exe" : "claude"),
    codexVendor: path.join(rt, "codex", "package", "vendor", CODEX_TRIPLE[win ? "win32" : mac ? `darwin-${arch === "arm64" ? "arm64" : "x64"}` : ""] || "x86_64-unknown-linux-musl"),
    git: path.join(rt, "git"),
  };
}

function readState(L) {
  try { return JSON.parse(fs.readFileSync(L.state, "utf8")); } catch { return {}; }
}
function writeState(L, patch) {
  const next = { ...readState(L), ...patch };
  fs.mkdirSync(L.root, { recursive: true });
  fs.writeFileSync(L.state + ".tmp", JSON.stringify(next, null, 1));
  fs.renameSync(L.state + ".tmp", L.state);
  return next;
}

async function sha256(file) {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

/** Скачивание со сверкой sha256: до 5 попыток, после обрыва — докачка с места (Range). */
async function download(url, file, expect, onProgress, fetchFn = fetch, attempts = 5) {
  if (fs.existsSync(file) && (await sha256(file)) === expect.sha256) return file;
  const part = file + ".part";
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (have >= (expect.size || Infinity)) { await fsp.rm(part, { force: true }); have = 0; }
      const res = await fetchFn(url, have ? { headers: { range: `bytes=${have}-` } } : undefined);
      if (have && res.status !== 206) have = 0; // сервер начал сначала
      if (!(res.ok || res.status === 206) || !res.body) throw new Error(`сервер ответил ${res.status}`);
      const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
      let got = have;
      try {
        for await (const chunk of res.body) {
          got += chunk.length;
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
          onProgress?.(got / (expect.size || got));
        }
      } finally {
        await new Promise((resolve) => out.end(resolve));
      }
      if ((await sha256(part)) !== expect.sha256) {
        await fsp.rm(part, { force: true });
        throw new Error("контрольная сумма не сошлась");
      }
      await fsp.rename(part, file);
      return file;
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, Math.min(15000, 1500 * attempt)));
    }
  }
  if (/контрольная сумма/.test(last?.message || "")) throw new Error(`Файл ${path.basename(file)} повреждён при скачивании — попробуй ещё раз`);
  throw new Error(`Не удалось скачать ${path.basename(file)} за ${attempts} попыток (${last?.message || "нет связи"}). Проверь интернет и нажми «Работать на этом компьютере» ещё раз — скачанное продолжится с места.`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...opts });
    let err = "";
    child.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
    child.stdout.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)}: код ${code}. ${err.trim()}`))));
  });
}

/** tar.exe есть в Windows 10/11 и распаковывает и .tgz, и .zip. */
async function extract(L, archive, dest, { strip = 0 } = {}) {
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  if (archive.endsWith(".7z.exe")) return run(archive, ["-y", `-o${dest}`]);
  const tar = L.win ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  await run(tar, ["-xf", archive, "-C", dest, ...(strip ? [`--strip-components=${strip}`] : [])]);
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Сервер не ответил вовремя")), ms).unref?.())]);

/** Ставит или обновляет то, что изменилось в runtime.json сервера. */
async function installRuntime(L, { onStep = () => {}, fetchFn = (...a) => fetch(...a), fetchJson = (u) => fetchFn(u).then((r) => { if (!r.ok) throw new Error("Сервер не отдал список файлов"); return r.json(); }), base = RUNTIME_URL } = {}) {
  const bases = [...new Set([].concat(base))];
  let manifest, lastError;
  for (const b of bases) {
    try { manifest = await withTimeout(fetchJson(b + L.manifest), 20000); base = b; break; }
    catch (error) { lastError = error; }
  }
  if (!manifest) throw lastError;
  const order = [base, ...bases.filter((b) => b !== base)];
  const state = readState(L);
  const installed = { ...(state.runtime || {}) };
  await fsp.mkdir(path.join(L.rt, "downloads"), { recursive: true });
  const parts = [
    ["bb", "Служба bb", path.join(L.rt, "bb")],
    ["codex", "GPT (Codex)", path.join(L.rt, "codex")],
    ["claude", "Claude Code", path.join(L.rt, "claude")],
    ...(L.win || L.mac ? [["node", "Node.js", path.join(L.rt, "node")]] : []),
    ...(L.win ? [["git", "Git Bash", L.git]] : []),
  ];
  for (const [name, label, dest] of parts) {
    const item = manifest.files?.[name];
    if (!item) throw new Error(`На сервере нет компонента «${label}»`);
    if (installed[name] === item.sha256 && fs.existsSync(dest)) continue;
    const file = path.join(L.rt, "downloads", item.file);
    onStep({ label: `Скачиваю: ${label}`, progress: 0 });
    for (let i = 0; i < order.length; i++) {
      try { await download(order[i] + item.file, file, item, (p) => onStep({ label: `Скачиваю: ${label}`, progress: p }), fetchFn, i + 1 < order.length ? 2 : 5); break; }
      catch (error) { if (i + 1 >= order.length) throw error; }
    }
    onStep({ label: `Распаковываю: ${label}`, progress: 1 });
    await extract(L, file, dest, { strip: name === "node" ? 1 : 0 });
    installed[name] = item.sha256;
    writeState(L, { runtime: installed });
    await fsp.rm(file, { force: true });
  }
  return installed;
}

/** Codex на ПК — только через шлюз сервера; свой вход в ChatGPT не используется. */
function writeCodexConfig(L, link, token) {
  fs.mkdirSync(L.codexHome, { recursive: true });
  const config = [
    'model = "gpt-6-sol"',
    'model_reasoning_effort = "medium"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'model_provider = "owner_gateway"',
    "[model_providers.owner_gateway]",
    'name = "GPT subscription"',
    `base_url = "${link.origin}/__inference/v1"`,
    'wire_api = "responses"',
    'env_key = "GPT_BROKER_TOKEN"',
    "supports_websockets = false",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(L.codexHome, "config.toml"), config, { mode: 0o600 });
  fs.writeFileSync(path.join(L.codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: token }), { mode: 0o600 });
}

/** Обёртка `bb` для агентов на ПК (команда bb в задачах). */
function writeShims(L) {
  fs.mkdirSync(L.bin, { recursive: true });
  if (L.win) fs.writeFileSync(path.join(L.bin, "bb.cmd"), `@echo off\r\n"${L.node}" "${L.bbCli}" %*\r\n`);
  else {
    fs.writeFileSync(path.join(L.bin, "bb"), `#!/bin/sh\nexec "${L.node}" "${L.bbCli}" "$@"\n`, { mode: 0o755 });
  }
}

const tokenOf = (link) => link.prefix.split("/").pop();

/**
 * Браузер человека (/webext) для агентов на этом компьютере: команда bbrowser и навык
 * «browser» в папке данных bb (bb подкладывает его агентам). Берутся с сервера; ключ — токен
 * устройства из окружения службы (GPT_BROKER_TOKEN), адрес — из ANTHROPIC_BASE_URL.
 */
async function installBrowserTools(L, link, fetchFn = fetch) {
  const get = async (name) => {
    const res = await fetchFn(`${link.origin}/__browser/${name}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`${name}: сервер ответил ${res.status}`);
    return res.text();
  };
  const cli = await get("cli.mjs");
  fs.mkdirSync(L.bin, { recursive: true });
  const cliFile = path.join(L.root, "bbrowser.mjs");
  fs.writeFileSync(cliFile, cli);
  // Обёртка с NODE_USE_ENV_PROXY: в песочнице агента сеть только через прокси.
  if (L.win) fs.writeFileSync(path.join(L.bin, "bbrowser.cmd"), `@echo off\r\nset NODE_USE_ENV_PROXY=1\r\n"${L.node}" "${cliFile}" %*\r\n`);
  else fs.writeFileSync(path.join(L.bin, "bbrowser"), `#!/bin/sh\nexec "${L.node}" "${cliFile}" "$@"\n`, { mode: 0o755 });
  // Навык и инструкции агентам (Claude Code, Codex, bb) — список с сервера, меняется без новой версии приложения.
  let files;
  try { files = JSON.parse(await get("agent-files.json")).files; }
  catch { files = [{ root: "data", path: "skills/browser/SKILL.md", content: await get("skill.md") }]; }
  const roots = { data: L.data, claudeHome: L.claudeHome, codexHome: L.codexHome, root: L.root };
  for (const f of files || []) {
    const base = roots[f.root];
    const rel = String(f.path || "");
    if (!base || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || typeof f.content !== "string") continue;
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, f.content);
  }
}

/**
 * Окружение службы bb: модели — через сервер, чужие ключи из системы убраны.
 * proxy — локальный Xray, если сервер напрямую не открывается (edge.js):
 * fetch идёт через NODE_USE_ENV_PROXY, WebSocket службы — через proxy-tls.cjs,
 * Codex и Claude Code сами понимают HTTPS_PROXY.
 */
function daemonEnv(L, link, base = process.env, proxy = null) {
  const token = tokenOf(link);
  const env = { ...base };
  for (const key of Object.keys(env))
    if (/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_|CODEX_|BB_|NODE_OPTIONS$|NODE_USE_ENV_PROXY$|(HTTPS?|ALL|NO)_PROXY$)/i.test(key)) delete env[key];
  const sep = L.win ? ";" : ":";
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  // codex.exe и его rg.exe (поиск по файлам) — из пакета @openai/codex для этой ОС.
  // Mac: приложение из Finder получает урезанный PATH — добавляем Homebrew и /usr/local/bin.
  const extra = [L.bin, path.dirname(L.node), path.join(L.codexVendor, "bin"), path.join(L.codexVendor, "codex-path"), ...(L.win ? [path.join(L.git, "cmd")] : []), ...(L.mac ? ["/opt/homebrew/bin", "/usr/local/bin"] : [])];
  env[pathKey] = [...extra, env[pathKey] || ""].join(sep);
  Object.assign(env, {
    BB_DATA_DIR: L.data,
    BB_TELEMETRY: "false",
    BB_SERVER_HEADERS: JSON.stringify({ "x-ai-device": token }),
    CODEX_HOME: L.codexHome,
    GPT_BROKER_TOKEN: token,
    OPENAI_API_KEY: token,
    BB_CLAUDE_CODE_EXECUTABLE: L.claude,
    CLAUDE_CONFIG_DIR: L.claudeHome,
    ANTHROPIC_BASE_URL: `${link.origin}/__anthropic`,
    // Доверять сертификатам системы (в т.ч. антивируса, проверяющего HTTPS), а не только своим.
    NODE_USE_SYSTEM_CA: "1",
    ANTHROPIC_AUTH_TOKEN: token,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    ENABLE_TOOL_SEARCH: "true",
    DISABLE_AUTOUPDATER: "1",
    ...(L.win ? { CLAUDE_CODE_GIT_BASH_PATH: path.join(L.git, "bin", "bash.exe") } : {}),
  });
  if (proxy) Object.assign(env, {
    HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1", BB_TUNNEL_PROXY: proxy.url,
    // WebSocket службы — туннелем и к нашему серверу, и к зеркалу, если окно идёт через него.
    BB_TUNNEL_HOSTS: `\\.sslip\\.io$|^${new URL(link.origin).hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    // В NODE_OPTIONS обратная косая — экранирование: C:\Users\… превращался в C:Users…
    // и служба падала (MODULE_NOT_FOUND). Прямые косые Windows понимает.
    NODE_OPTIONS: `--require "${proxy.preload.replace(/\\/g, "/")}"`,
  });
  return env;
}

/** Остановить процесс со всеми дочерними: в Windows дети сами не умирают. */
function killTree(pid, win) {
  if (!pid) return;
  if (win) {
    try { require("node:child_process").spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15000 }); } catch { /* уже нет */ }
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* уже нет */ }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function freePort(preferred) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => { probe.close(); const any = net.createServer(); any.listen(0, "127.0.0.1", () => { const p = any.address().port; any.close(() => resolve(p)); }); });
    probe.listen(preferred, "127.0.0.1", () => probe.close(() => resolve(preferred)));
  });
}

/**
 * Управление службой bb на ПК. join — подключить заново (код от сервера),
 * start — запустить уже подключённую; служба живёт, пока работает приложение.
 */
/** Последние строки журнала службы — чтобы в окне ошибки было видно причину. */
function logTail(L, chars = 1200) {
  try {
    const text = fs.readFileSync(L.log, "utf8").slice(-chars);
    return text.split(/\r?\n/).filter((line) => line.trim()).slice(-12).join("\n");
  } catch { return ""; }
}

/** Службы bb, оставшиеся от прошлых запусков с этой же папкой данных (держат её замок). */
function killOrphans(L) {
  const { spawnSync } = require("node:child_process");
  if (L.win) {
    // node.exe с нашей папкой данных в командной строке — дерево целиком (служба и её дочерние процессы).
    const data = L.data.replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${data}') } | ForEach-Object { taskkill /pid $_.ProcessId /T /F | Out-Null }`;
    try { spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true, timeout: 20000 }); } catch { /* нет PowerShell */ }
    return;
  }
  try { spawnSync("pkill", ["-f", L.data], { timeout: 10000 }); } catch { /* нет pkill */ }
}

/** Служба уже подключалась с этой папкой данных: есть её машина и ключ — можно вернуться на ту же машину. */
function joinedBefore(L) {
  return fs.existsSync(path.join(L.data, "host-id")) && fs.existsSync(path.join(L.data, "auth.json"));
}

function createLocalHost({ root, platform, request, log = () => {}, fetchFn = (...a) => fetch(...a), proxy = () => null, connectTimeoutMs = 120000 }) {
  const L = layout(root, platform);
  let child = null;

  function spawnDaemon(link, args) {
    fs.mkdirSync(L.data, { recursive: true });
    const out = fs.openSync(L.log, "a");
    const proc = spawn(L.node, [L.bbApp, "--data-dir", L.data, "host-daemon", ...args], {
      env: daemonEnv(L, link, process.env, proxy()), windowsHide: true, stdio: ["ignore", out, out], cwd: L.root,
    });
    fs.closeSync(out);
    proc.on("exit", (code) => { log(`служба bb завершилась (${code})`); if (child === proc) child = null; });
    child = proc;
    writeState(L, { pid: proc.pid });
    return proc;
  }

  return {
    layout: L,
    state: () => readState(L),
    running: () => Boolean(child && child.exitCode === null),

    /** Полная настройка: файлы, конфиги, подключение к серверу, запуск. */
    async enable(link, { onStep = () => {} } = {}) {
      await installRuntime(L, { onStep, fetchFn, base: runtimeBase(link) });
      onStep({ label: "Настраиваю GPT и Claude через сервер", progress: 1 });
      writeCodexConfig(L, link, tokenOf(link));
      writeShims(L);
      await installBrowserTools(L, link, fetchFn).catch((error) => log(`браузер для агентов: ${error.message}`));
      fs.mkdirSync(L.claudeHome, { recursive: true });
      await this.stop();
      killOrphans(L);
      const origin = link.home?.origin ?? link.origin;
      const serverUrl = link.origin + link.prefix;
      // Ждём, пока сервер увидит машину: без этого галочка «подключён» могла стоять, а машины не было.
      const waitConnected = async (proc, hostId) => {
        onStep({ label: "Жду, пока сервер увидит этот компьютер", progress: 1 });
        const deadline = Date.now() + connectTimeoutMs;
        while (Date.now() < deadline) {
          if (proc.exitCode !== null) return false;
          const host = await request("GET", `/api/v1/hosts/${encodeURIComponent(hostId)}`).catch(() => null);
          if (host?.status === "connected") return true;
          await new Promise((r) => setTimeout(r, Math.min(3000, connectTimeoutMs / 10)));
        }
        return false;
      };
      // Галочку сняли и поставили снова — возвращаемся на ту же машину: чаты привязаны к ней.
      // Новая машина нужна, только если прежнюю удалили на сервере (404) или служба не вернулась.
      const prev = readState(L);
      if (prev.hostId && joinedBefore(L)) {
        const known = await request("GET", `/api/v1/hosts/${encodeURIComponent(prev.hostId)}`).catch(() => null);
        if (known?.id === prev.hostId) {
          onStep({ label: "Возвращаю этот компьютер в рабочую зону", progress: 1 });
          const port = await freePort(prev.port || 47123);
          try { fs.writeFileSync(L.log, ""); } catch { /* нет файла */ }
          const proc = spawnDaemon(link, ["--supervise", "--server-url", serverUrl, "--host-daemon-port", String(port)]);
          writeState(L, { enabled: false, port, origin });
          if (await waitConnected(proc, prev.hostId)) {
            writeState(L, { enabled: true });
            return prev.hostId;
          }
          log(`прежняя машина ${prev.hostId} не вернулась — подключаю заново:\n${logTail(L)}`);
          await this.stop();
        }
      }
      onStep({ label: "Подключаю компьютер к рабочей зоне", progress: 1 });
      const join = await request("POST", "/__web/machines/join");
      const port = await freePort(readState(L).port || 47123);
      try { fs.writeFileSync(L.log, ""); } catch { /* нет файла */ }
      const proc = spawnDaemon(link, ["join", "--server-url", serverUrl, "--join-code", join.joinCode, "--host-id", join.hostId, "--host-daemon-port", String(port)]);
      writeState(L, { enabled: false, hostId: join.hostId, port, origin, joinedAt: Date.now() });
      if (!(await waitConnected(proc, join.hostId))) {
        const exited = proc.exitCode !== null;
        const tail = logTail(L);
        log(`служба не подключилась (${exited ? `завершилась с кодом ${proc.exitCode}` : "нет ответа"}):\n${tail}`);
        await this.stop();
        throw new Error(`${exited ? "Служба bb на этом компьютере сразу завершилась." : "Служба bb запустилась, но сервер её так и не увидел."}${tail ? `\n\nЖурнал службы:\n${tail}` : ""}`);
      }
      writeState(L, { enabled: true });
      return join.hostId;
    },

    /** Запуск при старте приложения (уже подключён). Обновляет файлы, если сервер выложил новые. */
    async start(link, { onStep } = {}) {
      const s = readState(L);
      if (!s.enabled || s.origin !== (link.home?.origin ?? link.origin)) return false;
      if (this.running()) return true;
      await this.stop();
      killOrphans(L);
      try { await installRuntime(L, { onStep, fetchFn, base: runtimeBase(link) }); } catch (error) { log(`обновление компонентов отложено: ${error.message}`); }
      writeCodexConfig(L, link, tokenOf(link));
      writeShims(L);
      await installBrowserTools(L, link, fetchFn).catch((error) => log(`браузер для агентов: ${error.message}`));
      const port = await freePort(s.port || 47123);
      if (port !== s.port) writeState(L, { port });
      // --server-url: служба идёт тем же путём, что и окно (напрямую, зеркало, зеркало через прокси),
      // а не адресом, с которым когда-то подключалась.
      spawnDaemon(link, ["--supervise", "--server-url", link.origin + link.prefix, "--host-daemon-port", String(port)]);
      return true;
    },

    async stop() {
      const proc = child;
      child = null;
      // Служба от прошлого запуска приложения (упало или выключили свет).
      const stale = readState(L).pid;
      if ((!proc || proc.pid !== stale) && alive(stale)) killTree(stale, L.win);
      if (!proc || proc.exitCode !== null) return;
      if (L.win) {
        killTree(proc.pid, true);
        await new Promise((resolve) => { if (proc.exitCode !== null) return resolve(); const t = setTimeout(resolve, 5000); proc.once("exit", () => { clearTimeout(t); resolve(); }); });
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* уже нет */ } resolve(); }, 8000);
        proc.once("exit", () => { clearTimeout(timer); resolve(); });
        try { proc.kill(); } catch { clearTimeout(timer); resolve(); }
      });
    },

    /** Немедленная остановка при выходе из приложения (в том числе для установки обновления). */
    stopSync() {
      const proc = child;
      child = null;
      if (proc && proc.exitCode === null) killTree(proc.pid, L.win);
      const stale = readState(L).pid;
      if (stale && (!proc || stale !== proc.pid) && alive(stale)) killTree(stale, L.win);
    },

    /** Отключить: служба остановлена, машина удалена из рабочей зоны, файлы ПК не трогаем. */
    async disable({ removeMachine = true } = {}) {
      const s = readState(L);
      await this.stop();
      // Просто сняли галочку: служба остановлена, машина и её ключ остаются — при повторном
      // включении вернётся та же машина, и чаты не теряют её («Machine removed»).
      if (!removeMachine) { writeState(L, { enabled: false, pid: null }); return; }
      if (s.hostId) await request("DELETE", `/api/v1/hosts/${encodeURIComponent(s.hostId)}`).catch((error) => log(`машину не удалил: ${error.message}`));
      await fsp.rm(L.data, { recursive: true, force: true }).catch((error) => log(`папку службы удалю позже: ${error.message}`));
      writeState(L, { enabled: false, hostId: null, pid: null });
    },
  };
}

module.exports = { MIRROR_RUNTIME_URL, installBrowserTools, createLocalHost, layout, daemonEnv, installRuntime, writeCodexConfig, download, RUNTIME_URL, runtimeBase };

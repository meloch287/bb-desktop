// bb для Windows и Mac: окно с личной рабочей зоной bb на нашем сервере.
// Приложение хранит личную ссылку подключения (зашифрованно, через safeStorage)
// и открывает bb в окне. По желанию — «Работать на этом компьютере»: ПК
// становится машиной bb (local-host.js), модели при этом идут через сервер.
"use strict";

const { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, safeStorage, session, shell } = require("electron");
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { parseLink, isOwn, isExternalWeb } = require("./link");
const { createLocalHost } = require("./local-host");
const edge = require("./edge");
const appSettings = require("./settings");
const look = require("./look");

const APP_ID = "ru.aibot.bb";
const IS_MAC = process.platform === "darwin";
const TRAY_WORD = IS_MAC ? "в строке меню" : "в трее";
const PARTITION = "persist:bb";
const BG = "#101319";

let win = null;
let connection = null; // { origin, url, prefix }
let tray = null;
let quitting = false;
// Автозапуск после входа в систему — сразу в фон (Windows: --hidden, Mac: признак входа).
const hidden = process.argv.includes("--hidden") || (IS_MAC && (() => { try { return app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; } })());
let localHost = null;
let proxy = null; // { url, stop } - встроенный Xray или внешний HTTP-прокси с пустым stop
let route = null; // Promise текущей проверки пути до сервера

app.setAppUserModelId(APP_ID);

// Настройки читаются до запуска Chromium: флаги ускорения действуют только с самого старта.
const support = appSettings.glassSupport();
let settings = appSettings.load(app.getPath("userData"), support);
const startSettings = { ...settings };
if (settings.gpu) {
  // На части ПК видеокарта в «чёрном списке» Chromium, и всё рисуется процессором — отсюда подтормаживания.
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
} else {
  app.disableHardwareAcceleration();
}
if (settings.smoothScroll) app.commandLine.appendSwitch("enable-smooth-scrolling");
else app.commandLine.appendSwitch("disable-smooth-scrolling");
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// ---------- хранение ----------

const dataFile = (name) => join(app.getPath("userData"), name);

function readJson(name) {
  try {
    return JSON.parse(readFileSync(dataFile(name), "utf8"));
  } catch {
    return null;
  }
}

function writeJson(name, value) {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(dataFile(name), JSON.stringify(value), { mode: 0o600 });
}

function loadConnection() {
  const saved = readJson("connection.json");
  if (!saved) return null;
  try {
    const text = saved.enc && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(saved.enc, "base64"))
      : saved.plain;
    return parseLink(text);
  } catch {
    return null;
  }
}

function saveConnection(link) {
  writeJson("connection.json", safeStorage.isEncryptionAvailable()
    ? { enc: safeStorage.encryptString(link.url).toString("base64") }
    : { plain: link.url });
  connection = link;
}

async function forgetConnection() {
  // Смена подключения — машину на прежнем сервере удаляем, даже если галочку уже сняли.
  if (localHost?.state().enabled || localHost?.state().hostId) await localHost.disable().catch(() => {});
  setAutostart(false);
  connection = null;
  rmSync(dataFile("connection.json"), { force: true });
  await session.fromPartition(PARTITION).clearStorageData();
}

// ---------- окно ----------

function windowState() {
  const s = readJson("window.json") || {};
  return { width: s.width || 1360, height: s.height || 880, x: s.x, y: s.y, maximized: !!s.maximized };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  writeJson("window.json", { ...b, maximized: win.isMaximized() });
}

function showLocal(page, query = {}) {
  win.loadFile(join(__dirname, page), { query });
}

function showConnect(message = "") {
  showLocal("connect.html", message ? { message } : {});
}

// ---------- путь до сервера: напрямую или через встроенный прокси ----------

const bbSession = () => session.fromPartition(PARTITION);
const sesFetch = (url, options) => bbSession().fetch(url, options);

function xrayExe() {
  const name = IS_MAC ? "xray" : "xray.exe";
  return app.isPackaged ? join(process.resourcesPath, "xray", name) : join(__dirname, "..", "build", IS_MAC ? `xray-darwin-${process.arch}` : "xray", name);
}

let appliedProxy;
async function applyProxy(url) {
  // Не трогаем соединения, если способ не поменялся: closeAllConnections рвал бы идущие
  // загрузки компонентов (net::ERR_ABORTED при «Работать на этом компьютере»).
  if (appliedProxy === (url || null)) return;
  appliedProxy = url || null;
  const config = url ? { proxyRules: url, proxyBypassRules: "<local>" } : { mode: "direct" };
  for (const ses of [bbSession(), session.defaultSession, session.fromPartition("setup")]) await ses.setProxy(config);
  for (const ses of [bbSession(), session.defaultSession]) await ses.closeAllConnections?.();
}

function savedOutbound() {
  const saved = readJson("edge.json");
  if (!saved?.enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(saved.enc, "base64"))); } catch { return null; }
}

// Сохраняем поддержку локального профиля из Windows 1.4.2.
function overrideEdge() {
  for (const dir of [dirname(process.execPath), app.getPath("userData")]) {
    try {
      const data = JSON.parse(readFileSync(join(dir, "edge-override.json"), "utf8"));
      if (data?.outbound?.protocol) return data;
    } catch { /* нет файла */ }
  }
  return null;
}

async function startProxy() {
  let outbound;
  const override = overrideEdge();
  if (override) {
    outbound = override.outbound;
    logLocal("настройки прокси - из файла edge-override.json");
    proxy?.stop();
    proxy = await edge.startXray({ exe: xrayExe(), outbound, dir: join(app.getPath("userData"), "edge"), log: logLocal });
    await applyProxy(proxy.url);
    return;
  }
  try {
    // Через Chromium окна: Node на ПК с антивирусом, проверяющим HTTPS, не доверяет его сертификату.
    outbound = await edge.fetchOutbound(connection.home || connection, (u, o) => sesFetch(u, o), [`${MIRRORS[0]}/__edge/proxy?d=`, ...edge.EDGE_URLS]);
    if (safeStorage.isEncryptionAvailable()) writeJson("edge.json", { enc: safeStorage.encryptString(JSON.stringify(outbound)).toString("base64") });
  } catch (error) {
    if (error.fatal) throw error;
    outbound = savedOutbound(); // Cloudflare тоже недоступен — берём сохранённые настройки
    if (!outbound) throw error;
  }
  proxy?.stop();
  proxy = await edge.startXray({ exe: xrayExe(), outbound, dir: join(app.getPath("userData"), "edge"), log: logLocal });
  await applyProxy(proxy.url);
  logLocal(`сервер напрямую недоступен — работаю через встроенный прокси ${proxy.url}`);
}

// HTTPS-входы bb в порядке приоритета. Прежнее зеркало остается запасным.
const MIRRORS = ["https://bb.2.29.166.225.sslip.io", "https://www.daktntgos.ru"];
// Необязательная настройка только этого приложения; перечитывается при запуске.
function readMirrorProxy() {
  const value = readJson("network.json")?.mirrorProxy;
  if (value == null) return null;
  try {
    // Preload службы поддерживает HTTP CONNECT к DNS-имени или IPv4, без авторизации.
    if (typeof value !== "string" || !/^http:\/\/[^\u0000-\u0020\u007f/?#@\\]+\/?$/i.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== "http:" || !url.hostname || url.hostname.startsWith("[") ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    // Chromium разбирает proxyRules отдельно от URL: разделители правил не являются DNS-именем.
    const hostname = url.hostname.replace(/\.$/, "");
    if (hostname.length > 253 || !hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error();
    return url.origin;
  } catch {
    logLocal("Некорректный mirrorProxy в network.json: использую обычные маршруты");
    return null;
  }
}
const mirrorProxy = readMirrorProxy();
/** Та же ссылка устройства, но через зеркало. home — прямая ссылка, к ней возвращаемся. */
function viaMirror(home, origin) {
  return { origin, url: `${origin}${home.prefix}/`, prefix: home.prefix, home };
}

/**
 * Открывается ли адрес в окне (Chromium). Проверку через Node (как ходят служба и агенты)
 * только пишем в журнал: на Windows с антивирусом, который проверяет HTTPS (Касперский, ESET…),
 * Node не доверяет его сертификату — и 1.3.8–1.3.9 из-за этого уходили с рабочего прямого
 * адреса на зеркало через Cloudflare, которое у российских провайдеров бывает урезано.
 */
async function reachableUi(link, label) {
  const [ui, agent] = await Promise.all([
    edge.reachable(link, (u, o) => sesFetch(u, o)),
    edge.reachable(link, (u, o) => fetch(u, o)),
  ]);
  if (ui && !agent) logLocal(`${label}: окно открывает, проверка Node — нет (антивирус/прокси?)`);
  return ui;
}

// Пути, на которых bb в этот запуск не открылся (застрял на заставке) — их пропускаем.
const skippedRoutes = new Set();
let routeMode = null;
let activeRouteId = null;
let hostRouteChange = Promise.resolve();
const routeId = (mode, link) => ["mirror", "proxy-mirror", "configured-mirror"].includes(mode) ? `${mode}:${link.origin}` : mode;
const routeIds = ["direct", "proxy", ...MIRRORS.flatMap((origin) => [routeId("mirror", { origin }), routeId("proxy-mirror", { origin })]), ...(mirrorProxy ? [routeId("configured-mirror", { origin: MIRRORS[0] })] : [])];

/**
 * Выбирает путь до сервера: новый VPS → прежнее зеркало → напрямую → встроенный прокси.
 * Прокси — последний вариант: его выход за границей до сервера рвётся через раз (18.11).
 * Путь, на котором bb не открылся за 30 с (см. watchWorkspace), в этот запуск пропускается.
 */
function ensureRoute(force = false, avoidOrigin = null) {
  if (route && !force) return route;
  if (force) skippedRoutes.clear();
  route = (async () => {
    if (!connection) return;
    if (connection.home) connection = connection.home;
    const home = connection;
    const previousProxyUrl = proxy?.url ?? null;
    const use = (mode, link, note) => {
      const previousRouteId = activeRouteId;
      routeMode = mode;
      activeRouteId = routeId(mode, link);
      connection = link;
      writeJson("route.json", { mode, at: Date.now() });
      if (note) logLocal(note);
      // Ручной повтор, запрос устройства и проверка окна меняют один транспорт.
      const transport = { id: activeRouteId, proxyUrl: proxy?.url ?? null };
      if (previousRouteId && (previousRouteId !== activeRouteId || previousProxyUrl !== transport.proxyUrl) && localHost?.state().enabled) {
        const stillSelected = () => activeRouteId === transport.id && (proxy?.url ?? null) === transport.proxyUrl;
        // Загрузки компонентов не задерживают окно; переносы службы идут последовательно.
        hostRouteChange = hostRouteChange.catch(() => {}).then(async () => {
          if (!stillSelected() || !localHost.state().enabled) return;
          await localHost.stop();
          if (stillSelected() && localHost.state().enabled) await localHost.start(link);
        }).catch((error) => logLocal(`служба не перезапустилась: ${error.message}`));
      }
    };
    const mirrors = MIRRORS.map((origin) => viaMirror(home, origin));
    const explicitEdge = !!overrideEdge();
    for (let pass = 0; pass < 2; pass++) {
      const hadSkippedRoutes = skippedRoutes.size > 0;
      const primary = mirrors[0], configuredId = routeId("configured-mirror", primary);
      if (!explicitEdge && mirrorProxy && primary.origin !== avoidOrigin && !skippedRoutes.has(configuredId)) {
        let available = false;
        try {
          await applyProxy(mirrorProxy);
          available = await edge.reachable(primary, (u, o) => sesFetch(u, o));
        } catch { /* необязательный прокси не должен блокировать обычные маршруты */ }
        if (available) {
          proxy?.stop();
          // Внешний процесс не принадлежит bb: при смене пути останавливать нечего.
          proxy = { url: mirrorProxy, stop() {} };
          return use("configured-mirror", primary, "работаю через настроенный HTTP-прокси и основное зеркало");
        }
        skippedRoutes.add(configuredId);
        logLocal("Настроенный HTTP-прокси недоступен: проверяю обычные маршруты");
      }
      await applyProxy(null);
      const [direct, ...viaMirrors] = await Promise.all([
        explicitEdge || home.origin === avoidOrigin || skippedRoutes.has("direct") ? false : reachableUi(home, "напрямую"),
        ...mirrors.map((m) => (explicitEdge || m.origin === avoidOrigin || skippedRoutes.has(routeId("mirror", m)) ? false : reachableUi(m, `зеркало ${m.origin}`))),
      ]);
      if (!direct) skippedRoutes.add("direct");
      mirrors.forEach((m, index) => { if (!viaMirrors[index]) skippedRoutes.add(routeId("mirror", m)); });
      const m = mirrors[viaMirrors.indexOf(true)];
      if (m) { proxy?.stop(); proxy = null; return use("mirror", m, `работаю через зеркало ${m.origin}`); }
      if (direct) { proxy?.stop(); proxy = null; return use("direct", home); }
      await startProxy();
      for (const pm of mirrors) {
        const id = routeId("proxy-mirror", pm);
        if (pm.origin !== avoidOrigin && !skippedRoutes.has(id) && await edge.reachable(pm, (u, o) => sesFetch(u, o)))
          return use("proxy-mirror", pm, `работаю через встроенный прокси и зеркало ${pm.origin}`);
        skippedRoutes.add(id);
      }
      if (home.origin !== avoidOrigin && !skippedRoutes.has("proxy") && await edge.reachable(home, (u, o) => sesFetch(u, o))) return use("proxy", home);
      skippedRoutes.add("proxy");
      skippedRoutes.clear();
      if (!hadSkippedRoutes || pass === 1) break;
    }
    throw new Error("Не удалось подключиться к bb. Повторите подключение чуть позже.");
  })().catch((error) => { route = null; throw error; });
  return route;
}

/** Для службы bb на ПК: прокси и модуль туннеля (копия из asar — его читает обычный node.exe). */
function localProxy() {
  if (!proxy) return null;
  const preload = join(localRoot(), "proxy-tls.cjs");
  try { writeFileSync(preload, readFileSync(join(__dirname, "proxy-tls.cjs"))); } catch { /* уже есть */ }
  return { url: proxy.url, preload };
}

async function openWorkspace(recovery) {
  stopWorkspaceWatch();
  if (!connection) return showConnect();
  try {
    await ensureRoute(false, recovery?.failedOrigin);
  } catch (error) {
    if (/отозвана/.test(error.message)) { await forgetConnection(); return showConnect(error.message); }
    return showLocal("offline.html", { error: error.message });
  }
  if (win && connection) { win.loadURL(connection.url); watchWorkspace(recovery); }
}

/**
 * Наблюдаем старт 90 с: загрузка модулей может оборваться уже после первой отрисовки.
 * Сетевой сбой модуля: один повтор того же адреса, затем один переход на другой origin.
 * Общий лимит сохраняется между автоматическими загрузками; ошибки приложения не трогаем.
 */
let watchTimer = null;
let stopWorkspaceWatch = () => {};
function workspaceLoadState(origin) {
  const root = document.querySelector("#root");
  if (!root || root.querySelector(".bb-boot")) return "stuck";
  for (const details of root.querySelectorAll("details")) {
    const boundary = details.parentElement;
    if (boundary.querySelector(":scope > h1")?.textContent.trim() !== "В bb произошла ошибка" ||
        boundary.querySelector(":scope > button")?.textContent.trim() !== "Перезагрузить bb" ||
        details.querySelector(":scope > summary")?.textContent.trim() !== "Подробности ошибки") continue;
    // details закрыт по умолчанию: innerText не содержит текст ошибки.
    const text = details.querySelector(":scope > pre")?.textContent.trim() || "";
    const match = /^TypeError: Failed to fetch dynamically imported module: (https?:\/\/\S+)$/.exec(text);
    if (!match) continue;
    try {
      const asset = new URL(match[1]);
      if (asset.origin === origin && asset.origin === location.origin && /^\/assets\/[^/?#]+\.js$/.test(asset.pathname)) return "import-error";
    } catch { /* другая ошибка или некорректный URL */ }
  }
  return "ready";
}
function watchWorkspace(recovery = { retries: 0, failedOrigin: null }) {
  stopWorkspaceWatch();
  const mode = activeRouteId, contents = win?.webContents;
  if (!contents) return;
  const started = Date.now();
  let stopped = false, loadFailed = false;
  const failed = (_e, code, _d, _u, isMainFrame) => { if (isMainFrame && code !== -3) loadFailed = true; };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(watchTimer);
    clearTimeout(deadlineTimer);
    contents.removeListener("did-fail-load", failed);
  };
  const deadlineTimer = setTimeout(stop, 90_000);
  stopWorkspaceWatch = stop;
  const current = () => !stopped && win && !win.isDestroyed() && win.webContents === contents && connection && activeRouteId === mode;
  contents.on("did-fail-load", failed);
  const check = async () => {
    if (!current() || !/^https?:/.test(contents.getURL())) return stop();
    const state = loadFailed ? "stuck" : await contents
      .executeJavaScript(`(${workspaceLoadState.toString()})(${JSON.stringify(connection.origin)})`, true)
      .catch(() => "stuck");
    // Старая проверка может завершиться после новой загрузки на том же origin.
    if (!current()) return stop();
    const elapsed = Date.now() - started;
    if (!/^https?:/.test(contents.getURL()) || elapsed > 90_000) return stop();
    if (state === "import-error" || (state === "stuck" && recovery.retries > 0)) {
      stop();
      if (recovery.retries >= 2) return;
      recovery.retries++;
      if (recovery.retries === 1) {
        logLocal("Сетевой сбой загрузки модуля bb: один раз повторяю текущий адрес");
      } else {
        recovery.failedOrigin = connection.origin;
        skippedRoutes.add(mode);
        route = null;
        logLocal("Повторный сбой загрузки bb: пробую другой адрес");
      }
      await openWorkspace(recovery);
      return;
    }
    if (state === "stuck") {
      stop();
      skippedRoutes.add(mode);
      logLocal(`bb не открылся за 30 с (путь ${mode}) - пробую следующий`);
      if (routeIds.every((r) => skippedRoutes.has(r))) skippedRoutes.clear();
      route = null;
      await openWorkspace(recovery);
      return;
    }
    skippedRoutes.clear();
    if (elapsed >= 90_000) return stop();
    watchTimer = setTimeout(check, Math.min(5_000, 90_000 - elapsed));
  };
  watchTimer = setTimeout(check, 30_000);
}

function createWindow() {
  const state = windowState();
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 880,
    minHeight: 560,
    title: "bb",
    backgroundColor: settings.glass ? "#00000000" : BG,
    ...(settings.glass ? (IS_MAC ? { vibrancy: "under-window", visualEffectState: "active" } : { backgroundMaterial: settings.material }) : {}),
    show: false,
    icon: join(__dirname, "icon.png"),
    autoHideMenuBar: false,
    webPreferences: {
      partition: PARTITION,
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: settings.spellcheck,
    },
  });
  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => { if (!(hidden && localHost?.state().enabled)) win.show(); });
  win.on("close", (event) => {
    saveWindowState();
    // Пока ПК работает машиной bb, окно прячется в трей: агенты продолжают.
    if (!quitting && localHost?.running()) {
      event.preventDefault();
      win.hide();
      notifyOnce("tray", "bb работает в фоне", `Агенты продолжают работать на этом компьютере. Открыть или выйти — значок bb ${TRAY_WORD}.`);
    }
  });
  win.on("closed", () => { win = null; });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (connection && isOwn(url, connection.origin)) {
      return { action: "allow", overrideBrowserWindowOptions: { backgroundColor: BG, autoHideMenuBar: true } };
    }
    if (isExternalWeb(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    if (url.startsWith("file://")) return;
    if (connection && isOwn(url, connection.origin)) return;
    event.preventDefault();
    if (isExternalWeb(url)) shell.openExternal(url);
  });
  wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED: обычная смена страницы */) return;
    if (url.startsWith("file://")) return;
    showLocal("offline.html", { error: description || String(code) });
  });
  wc.on("context-menu", (_e, params) => contextMenu(params));
  wc.on("page-title-updated", (event, title) => {
    event.preventDefault();
    win.setTitle(title && title !== "bb" ? `${title} — bb` : "bb");
  });
  openWorkspace();
}

// Ссылку отозвали в профиле или она истекла: шлюз отвечает 401 на /__app/…
function watchRevocation(ses) {
  ses.webRequest.onCompleted({ urls: ["https://*/__app/*"] }, (details) => {
    if (details.resourceType !== "mainFrame" || details.statusCode !== 401) return;
    if (!connection || !isOwn(details.url, connection.origin)) return;
    forgetConnection().then(() => win && showConnect("Ссылка подключения отозвана или истекла. Получи новую командой /desktop в боте."));
  });
}

// ---------- скачивание файлов ----------

function watchDownloads(ses) {
  ses.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({
      title: "Сохранить файл",
      buttonLabel: "Сохранить",
      defaultPath: join(app.getPath("downloads"), item.getFilename()),
    });
    item.once("done", (_e, state) => {
      if (state !== "completed" || !Notification.isSupported()) return;
      const path = item.getSavePath();
      const note = new Notification({ title: "Файл сохранён", body: item.getFilename() });
      note.on("click", () => shell.showItemInFolder(path));
      note.show();
    });
  });
}

// ---------- разрешения ----------

function watchPermissions(ses) {
  const allowed = new Set(["notifications", "clipboard-sanitized-write", "clipboard-read", "media", "fullscreen"]);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(Boolean(connection) && allowed.has(permission) && isOwn(details.requestingUrl || wc.getURL(), connection.origin));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => Boolean(connection) && allowed.has(permission) && isOwn(origin, connection.origin));
}

// ---------- меню ----------

function contextMenu(params) {
  const items = [];
  for (const word of params.dictionarySuggestions.slice(0, 5))
    items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
  if (params.misspelledWord) items.push({ type: "separator" });
  if (params.linkURL) {
    items.push({ label: "Копировать ссылку", click: () => clipboard.writeText(params.linkURL) });
    if (isExternalWeb(params.linkURL) && !(connection && isOwn(params.linkURL, connection.origin)))
      items.push({ label: "Открыть в браузере", click: () => shell.openExternal(params.linkURL) });
    items.push({ type: "separator" });
  }
  if (params.isEditable) items.push({ label: "Вырезать", role: "cut" }, { label: "Копировать", role: "copy" }, { label: "Вставить", role: "paste" }, { type: "separator" }, { label: "Выделить всё", role: "selectAll" });
  else if (params.selectionText) items.push({ label: "Копировать", role: "copy" });
  if (params.mediaType === "image" && params.srcURL) items.push({ label: "Сохранить картинку…", click: () => win.webContents.downloadURL(params.srcURL) });
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

function buildMenu() {
  const own = (path) => () => connection && win.loadURL(connection.origin + connection.prefix + path);
  const template = [
    {
      label: "Файл",
      submenu: [
        { label: "Рабочая зона", accelerator: "CmdOrCtrl+Shift+H", click: () => openWorkspace() },
        { label: "Мой профиль и устройства", click: own("/__web/profile") },
        { type: "separator" },
        { label: "Работать на этом компьютере", type: "checkbox", checked: Boolean(localHost?.state().enabled), click: (item) => toggleLocal(item.checked) },
        { type: "separator" },
        ...(IS_MAC ? [] : [{ label: "Настройки приложения…", accelerator: "CmdOrCtrl+,", click: openSettings }, { type: "separator" }]),
        { label: "Сменить подключение…", click: changeConnection },
        { label: "Открыть папку загрузок", click: () => shell.openPath(app.getPath("downloads")) },
        ...(IS_MAC ? [] : [{ type: "separator" }, { label: "Выход", click: quitApp }]),
      ],
    },
    {
      label: "Правка",
      submenu: [
        { label: "Отменить", role: "undo" }, { label: "Повторить", role: "redo" }, { type: "separator" },
        { label: "Вырезать", role: "cut" }, { label: "Копировать", role: "copy" }, { label: "Вставить", role: "paste" },
        { label: "Выделить всё", role: "selectAll" },
      ],
    },
    {
      label: "Вид",
      submenu: [
        { label: "Обновить", accelerator: "F5", click: () => win.webContents.reload() },
        { label: "Обновить полностью", accelerator: "CmdOrCtrl+F5", click: () => win.webContents.reloadIgnoringCache() },
        { type: "separator" },
        { label: "Крупнее", role: "zoomIn" }, { label: "Мельче", role: "zoomOut" }, { label: "Обычный масштаб", role: "resetZoom" },
        { type: "separator" },
        { label: "Во весь экран", role: "togglefullscreen" },
        { label: "Инструменты разработчика", accelerator: "CmdOrCtrl+Shift+I", role: "toggleDevTools" },
      ],
    },
    {
      label: "Справка",
      submenu: [
        { label: "Проверить обновления", click: () => checkUpdates(true) },
        { label: `О приложении (версия ${app.getVersion()})`, click: about },
      ],
    },
  ];
  // Mac: первое меню — меню приложения (bb), там же настройки (⌘,) и выход (⌘Q); плюс меню «Окно».
  if (IS_MAC) {
    template.unshift({
      label: app.name,
      submenu: [
        { label: "О приложении bb", click: about },
        { label: "Проверить обновления", click: () => checkUpdates(true) },
        { type: "separator" },
        { label: "Настройки приложения…", accelerator: "Cmd+,", click: openSettings },
        { type: "separator" },
        { label: "Скрыть bb", role: "hide" }, { label: "Скрыть остальные", role: "hideOthers" }, { label: "Показать все", role: "unhide" },
        { type: "separator" },
        { label: "Выйти из bb", accelerator: "Cmd+Q", click: quitApp },
      ],
    });
    template.splice(template.length - 1, 0, {
      label: "Окно",
      submenu: [{ label: "Свернуть", role: "minimize" }, { label: "Масштаб", role: "zoom" }, { type: "separator" }, { label: "Все окна — вперёд", role: "front" }],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function changeConnection() {
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Сменить", "Отмена"],
    defaultId: 1,
    cancelId: 1,
    title: "Сменить подключение",
    message: "Отключить это приложение от текущей рабочей зоны?",
    detail: "Сохранённая ссылка и вход будут удалены с этого компьютера. Файлы на сервере не пострадают.",
  });
  if (response !== 0) return;
  await forgetConnection();
  showConnect();
}

function about() {
  dialog.showMessageBox(win, {
    type: "info",
    title: "О приложении",
    message: `bb для ${IS_MAC ? "Mac" : "Windows"} ${app.getVersion()}`,
    detail: "Рабочая зона GPT и Claude на нашем сервере: диалоги, проекты и файлы.\nФайлы и задачи выполняются на сервере, а не на этом компьютере.",
  });
}

// ---------- обновления ----------

let updater = null;
function checkUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox(win, { message: "Обновления проверяются только в установленном приложении." });
    return;
  }
  if (IS_MAC) return checkMacUpdate(manual);
  try {
    updater ||= setupUpdater();
  } catch {
    return;
  }
  pickFeed("latest.yml").then((base) => {
    updater.setFeedURL({ provider: "generic", url: base });
    return updater.checkForUpdates();
  }).then((r) => {
    if (manual && !r?.isUpdateAvailable) dialog.showMessageBox(win, { message: "У тебя последняя версия." });
  }).catch((error) => {
    if (manual) dialog.showMessageBox(win, { type: "warning", message: "Не удалось проверить обновления.", detail: String(error?.message || error) });
  });
}

// Откуда брать обновления: обычный адрес, а если он не отвечает (из-за границы, с VPN) — зеркало.
const FEED_BASES = [`${MIRRORS[0]}/download/desktop/`, "https://ai-bot-miniapp.miniapp-edge.workers.dev/download/desktop/", "https://www.daktntgos.ru/download/desktop/"];
async function pickFeed(file) {
  for (const base of FEED_BASES) {
    try {
      const res = await sesFetch(base + file, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (res.ok) return base;
    } catch { /* следующий адрес */ }
  }
  return FEED_BASES[0];
}
async function feedJson(file) {
  let last;
  for (const base of FEED_BASES) {
    try {
      const res = await sesFetch(base + file, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
      return await res.json();
    } catch (error) { last = error; }
  }
  throw last;
}

function older(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

/** Обязательная ли новая версия: на сервере min-version.json { "min": "1.3.0" }. */
async function mandatoryUpdate() {
  try {
    const { min } = await feedJson("min-version.json");
    return typeof min === "string" && older(app.getVersion(), min);
  } catch { return false; }
}

let asking = false, postponedVersion = null;
function setupUpdater() {
  const { autoUpdater } = require("electron-updater");
  // Сначала спрашиваем, потом качаем: обновление не приходит «молча».
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", async (info) => {
    if (asking) return;
    const must = await mandatoryUpdate();
    if (!must && postponedVersion === info.version) return; // уже отложили в этот запуск
    asking = true;
    const { response } = await dialog.showMessageBox(win, {
      type: must ? "warning" : "info",
      buttons: must ? ["Обновить"] : ["Обновить сейчас", "Позже"],
      defaultId: 0, cancelId: must ? 0 : 1, noLink: true,
      title: "Обновление bb",
      message: must ? `Нужно обновить bb до версии ${info.version}` : `Вышла новая версия bb ${info.version}`,
      detail: must
        ? "Эта версия устарела и может работать неправильно. Обновление займёт около минуты, потом bb перезапустится сам."
        : `У тебя ${app.getVersion()}. Обновление займёт около минуты, потом bb перезапустится сам.`,
    }).finally(() => { asking = false; });
    if (response !== 0 && !must) { postponedVersion = info.version; return; }
    win?.setProgressBar(0.02);
    autoUpdater.downloadUpdate().catch((error) => {
      win?.setProgressBar(-1);
      dialog.showMessageBox(win, { type: "warning", message: "Не удалось скачать обновление.", detail: String(error?.message || error) });
    });
  });
  autoUpdater.on("download-progress", (p) => win?.setProgressBar(Math.max(0.02, (p.percent || 0) / 100)));
  autoUpdater.on("update-downloaded", () => {
    win?.setProgressBar(-1);
    quitting = true;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  });
  return autoUpdater;
}

// Mac: приложение без подписи Apple, сам себя заменить не может (electron-updater требует
// подпись). Поэтому — предложение скачать новую версию: mac/latest.json { version, arm64, x64 }.
async function checkMacUpdate(manual) {
  try {
    const info = await feedJson("mac/latest.json");
    if (!info?.version || !older(app.getVersion(), info.version)) {
      if (manual) dialog.showMessageBox(win, { message: "У тебя последняя версия." });
      return;
    }
    const must = await mandatoryUpdate();
    if (asking || (!manual && !must && postponedVersion === info.version)) return;
    asking = true;
    const { response } = await dialog.showMessageBox(win, {
      type: must ? "warning" : "info",
      buttons: must ? ["Скачать"] : ["Скачать", "Позже"],
      defaultId: 0, cancelId: must ? 0 : 1, noLink: true,
      title: "Обновление bb",
      message: must ? `Нужно обновить bb до версии ${info.version}` : `Вышла новая версия bb ${info.version}`,
      detail: "Скачается архив с новой версией. Открой его и перетащи bb в «Программы» с заменой — подключение и настройки сохранятся.",
    }).finally(() => { asking = false; });
    if (response !== 0) { postponedVersion = info.version; return; }
    const url = info[process.arch === "arm64" ? "arm64" : "x64"];
    if (url) shell.openExternal(url);
  } catch (error) {
    if (manual) dialog.showMessageBox(win, { type: "warning", message: "Не удалось проверить обновления.", detail: String(error?.message || error) });
  }
}

// ---------- работа на этом компьютере ----------

function localRoot() {
  return join(process.env.LOCALAPPDATA || app.getPath("userData"), "bb-local");
}

/** Запрос к шлюзу от имени устройства (токен — в адресе /__app/…). */
async function deviceRequest(method, path) {
  if (!connection) throw new Error("Нет подключения");
  await ensureRoute();
  const send = () => sesFetch(connection.origin + connection.prefix + path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(30000) });
  let res;
  try { res = await send(); }
  catch (error) {
    // Сеть сменилась (включили VPN и т. п.) — заново выбираем маршрут (напрямую или зеркало) и повторяем.
    logLocal(`запрос ${path} не прошёл (${error.message}) — выбираю маршрут заново`);
    route = null;
    await ensureRoute(true);
    res = await send();
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* не JSON */ }
  if (!res.ok) throw new Error(data.error?.message || data.error || `Сервер ответил ${res.status}`);
  return data;
}

function logLocal(line) {
  try { writeFileSync(join(localRoot(), "app.log"), `${new Date().toISOString()} ${line}\n`, { flag: "a" }); } catch { /* нет папки */ }
}

function setAutostart(on) {
  if (!app.isPackaged) return;
  if (IS_MAC) return app.setLoginItemSettings({ openAtLogin: on });
  if (process.platform !== "win32") return;
  app.setLoginItemSettings({ openAtLogin: on, args: on ? ["--hidden"] : [] });
}

const shown = new Set();
function notifyOnce(key, title, body) {
  if (shown.has(key) || !Notification.isSupported()) return;
  shown.add(key);
  new Notification({ title, body }).show();
}

function quitApp() {
  quitting = true;
  app.quit();
}

function updateTray() {
  const on = Boolean(localHost?.state().enabled);
  if (!on) { tray?.destroy(); tray = null; return; }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(join(__dirname, "icon.png")).resize({ width: 16, height: 16 }));
    tray.setToolTip("bb — работает на этом компьютере");
    tray.on("click", showWindow);
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Открыть bb", click: showWindow },
    { label: localHost.running() ? "Этот компьютер подключён ✓" : "Компьютер не подключён", enabled: false },
    { type: "separator" },
    { label: "Выход (агенты на этом компьютере остановятся)", click: quitApp },
  ]));
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setupWindow() {
  const w = new BrowserWindow({
    parent: win || undefined, modal: Boolean(win), width: 520, height: 300, resizable: false, minimizable: false,
    title: "Подключаю этот компьютер", backgroundColor: BG, autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, partition: "setup" },
  });
  w.setMenu(null);
  w.loadFile(join(__dirname, "setup.html"));
  return w;
}

async function toggleLocal(on) {
  if (!connection) { buildMenu(); return; }
  if (on) {
    const { response } = await dialog.showMessageBox(win, {
      type: "question", buttons: ["Подключить", "Отмена"], defaultId: 0, cancelId: 1,
      title: "Работать на этом компьютере",
      message: "Подключить этот компьютер к рабочей зоне bb?",
      detail: `Агенты GPT и Claude смогут читать и менять файлы и запускать команды на этом компьютере с правами твоего пользователя ${IS_MAC ? "Mac" : "Windows"} — как ты сам. В bb у поля ввода появится выбор машины: сервер или этот компьютер.\n\nМодели работают через наш сервер и общую подписку, расход считается в твоих лимитах. Один раз скачается около ${IS_MAC ? "400" : "460"} МБ (только с нашего сервера).`,
    });
    if (response !== 0) { buildMenu(); return; }
    const w = setupWindow();
    const step = (s) => { if (!w.isDestroyed()) w.webContents.send("bb:setup-progress", s); };
    try {
      await new Promise((r) => w.webContents.once("did-finish-load", r));
      step({ label: "Проверяю связь с сервером", progress: 0 });
      await ensureRoute();
      await localHost.enable(connection, { onStep: step });
      setAutostart(true);
      step({ label: "Готово", progress: 1, done: true });
      if (!w.isDestroyed()) w.close();
      dialog.showMessageBox(win, {
        type: "info", title: "Компьютер подключён",
        message: "Готово: этот компьютер подключён к bb.",
        detail: `Внизу у поля ввода выбери машину с именем этого компьютера и папку проекта — агент будет работать с файлами здесь. Пока работает bb (значок ${TRAY_WORD}), компьютер доступен агентам.`,
      });
      if (win && connection) win.loadURL(connection.url);
    } catch (error) {
      logLocal(`подключение не удалось: ${error.stack || error}`);
      if (!w.isDestroyed()) w.close();
      dialog.showMessageBox(win, { type: "error", title: "Не получилось", message: "Не удалось подключить этот компьютер.", detail: String(error.message || error) });
    }
  } else {
    const { response } = await dialog.showMessageBox(win, {
      type: "question", buttons: ["Отключить", "Отмена"], defaultId: 1, cancelId: 1,
      title: "Работать на этом компьютере", message: "Отключить этот компьютер от bb?",
      detail: "Агенты больше не будут работать с файлами этого компьютера. Сами файлы останутся на месте.",
    });
    if (response === 0) {
      await localHost.disable({ removeMachine: false }).catch((error) => logLocal(`отключение: ${error.message}`));
      setAutostart(false);
    }
  }
  buildMenu();
  updateTray();
}

/** Один раз после первого подключения — предложить локальную работу. */
async function offerLocal() {
  const asked = readJson("asked-local.json");
  if (asked || localHost.state().enabled) return;
  writeJson("asked-local.json", { at: Date.now() });
  const { response } = await dialog.showMessageBox(win, {
    type: "question", buttons: ["Да, подключить", "Позже"], defaultId: 0, cancelId: 1,
    title: "Локальные файлы",
    message: "Хочешь, чтобы агенты работали с файлами этого компьютера?",
    detail: "Можно выбрать в любой момент: меню «Файл» → «Работать на этом компьютере».",
  });
  if (response === 0) await toggleLocal(true);
}

// ---------- оформление и настройки приложения ----------

function applyLook(wc) {
  if (!wc || wc.isDestroyed()) return;
  const url = wc.getURL();
  if (!connection || !isOwn(url, connection.origin)) return;
  wc.executeJavaScript(look.pageScript(settings), true).catch(() => {});
}

function applyWindowGlass() {
  if (!win || win.isDestroyed() || !(support.mica || support.acrylic || support.vibrancy)) return;
  if (IS_MAC) {
    try { win.setVibrancy(settings.glass ? "under-window" : null); win.setBackgroundColor(settings.glass ? "#00000000" : BG); } catch (error) { logLocal(`стекло: ${error.message}`); }
    return;
  }
  try {
    win.setBackgroundMaterial(settings.glass ? settings.material : "none");
    win.setBackgroundColor(settings.glass ? "#00000000" : BG);
  } catch (error) { logLocal(`стекло: ${error.message}`); }
}

let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    parent: win || undefined, width: 520, height: 680, resizable: false, minimizable: false, maximizable: false,
    title: "Настройки приложения", backgroundColor: BG, autoHideMenuBar: true, show: false,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, partition: "setup" },
  });
  settingsWin.setMenu(null);
  settingsWin.once("ready-to-show", () => settingsWin.show());
  settingsWin.on("closed", () => { settingsWin = null; });
  settingsWin.loadFile(join(__dirname, "settings.html"));
}

ipcMain.handle("bb:settings-get", (event) => {
  if (!fromLocalPage(event)) return null;
  return { settings, support, defaults: appSettings.DEFAULTS, restart: appSettings.needsRestart(startSettings, settings) };
});
ipcMain.handle("bb:settings-set", (event, patch) => {
  if (!fromLocalPage(event) || !patch || typeof patch !== "object") return null;
  settings = appSettings.save(app.getPath("userData"), { ...settings, ...patch }, support);
  applyWindowGlass();
  bbSession().setSpellCheckerEnabled(settings.spellcheck);
  for (const w of BrowserWindow.getAllWindows()) applyLook(w.webContents);
  return { settings, restart: appSettings.needsRestart(startSettings, settings) };
});
ipcMain.handle("bb:restart", (event) => {
  if (!fromLocalPage(event)) return;
  quitting = true;
  app.relaunch();
  app.quit();
});

// ---------- IPC для экрана подключения ----------

function fromLocalPage(event) {
  return event.senderFrame?.url?.startsWith("file://");
}

ipcMain.handle("bb:clipboard-link", (event) => {
  if (!fromLocalPage(event)) return null;
  return parseLink(clipboard.readText())?.url ?? null;
});
ipcMain.handle("bb:connect", async (event, text) => {
  if (!fromLocalPage(event)) return { ok: false, error: "Недоступно" };
  const link = parseLink(String(text || ""));
  if (!link) return { ok: false, error: "Это не ссылка подключения. Она выглядит так: https://u…bb.200-165-236-8.sslip.io/__app/…" };
  saveConnection(link);
  openWorkspace();
  setTimeout(() => offerLocal().catch(() => {}), 4000);
  return { ok: true };
});
ipcMain.handle("bb:retry", async (event) => {
  if (!fromLocalPage(event)) return;
  route = null;
  await ensureRoute(true).catch(() => {});
  openWorkspace();
});

// ---------- старт ----------

app.whenReady().then(() => {
  connection = loadConnection();
  const ses = session.fromPartition(PARTITION);
  ses.setSpellCheckerLanguages(["ru", "en-US"]);
  ses.setSpellCheckerEnabled(settings.spellcheck);
  watchDownloads(ses);
  watchPermissions(ses);
  watchRevocation(ses);
  localHost = createLocalHost({ root: localRoot(), request: deviceRequest, log: logLocal, fetchFn: (u, o) => sesFetch(u, o), proxy: localProxy });
  buildMenu();
  createWindow();
  if (connection && localHost.state().enabled) {
    ensureRoute().catch(() => {}).then(() => localHost.start(connection)).then(() => updateTray()).catch((error) => logLocal(`служба не запустилась: ${error.message}`));
    updateTray();
  }
  setTimeout(() => checkUpdates(false), 3_000);
  setInterval(() => checkUpdates(false), 3600_000).unref?.();
});

app.on("window-all-closed", () => { if (!localHost?.running()) app.quit(); });
app.on("activate", () => { if (app.isReady()) showWindow(); }); // Mac: щелчок по значку в Dock
app.on("before-quit", () => { quitting = true; });
app.on("quit", () => proxy?.stop());
// Служба bb на ПК останавливается синхронно: выход идёт обычным путём, и установщик
// обновления (electron-updater, quitAndInstall) успевает запуститься.
app.on("will-quit", () => { if (localHost?.running()) localHost.stopSync(); });
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("dom-ready", () => applyLook(contents));
});

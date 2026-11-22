// Обход блокировок: если наш сервер (Москва, Timeweb) не открывается напрямую —
// например, у украинских провайдеров, — приложение поднимает встроенный Xray и
// ходит к серверу через выход сервера за границей (тот же узел, что у ai-bot-proxy).
// Настройки узла приходят через Cloudflare (как мини-апп) и только по токену
// устройства; в установщике их нет. Без Electron — проверяется под Node.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

// Сначала зеркало (Cloudflare → сервер в России → наш): у части российских провайдеров
// не открываются ни наш сервер, ни workers.dev, а маленький ответ через зеркало проходит.
const EDGE_URLS = [
  "https://www.daktntgos.ru/__edge/proxy?d=",
  "https://ai-bot-miniapp.miniapp-edge.workers.dev/__edge/proxy?d=",
  "https://aiapp.200-165-236-8.sslip.io/__edge/proxy?d=",
];

const tokenOf = (link) => link.prefix.split("/").pop();

/** Открывается ли сервер напрямую (любой ответ, кроме сетевой ошибки и 5xx от Cloudflare/провайдера). */
async function reachable(link, fetchFn = fetch, timeoutMs = 8000) {
  try {
    const res = await fetchFn(link.origin + link.prefix + "/__web/devices", { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel?.();
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Outbound Xray от сервера: сначала через Cloudflare, потом напрямую. */
async function fetchOutbound(link, fetchFn = fetch, urls = EDGE_URLS) {
  let last = null;
  for (const base of urls) {
    try {
      const res = await fetchFn(base + tokenOf(link), { signal: AbortSignal.timeout(15000) });
      if (res.status === 401) throw Object.assign(new Error("Ссылка устройства отозвана — получи новую через /desktop"), { fatal: true });
      if (!res.ok) throw new Error(`настройки прокси: ${res.status}`);
      const { outbound } = await res.json();
      if (!outbound?.protocol) throw new Error("настройки прокси пустые");
      return outbound;
    } catch (error) {
      if (error.fatal) throw error;
      last = error;
    }
  }
  throw new Error(`Не удалось получить настройки прокси (${last?.message || "нет связи"})`);
}

/** Конфиг Xray: только HTTP-вход на 127.0.0.1, всё из него — в узел сервера. */
function xrayConfig(outbound, port) {
  return {
    log: { loglevel: "warning" },
    inbounds: [{ tag: "local", listen: "127.0.0.1", port, protocol: "http", settings: {} }],
    outbounds: [{ ...outbound, tag: "proxy" }, { protocol: "freedom", tag: "direct" }],
    routing: { rules: [{ type: "field", inboundTag: ["local"], outboundTag: "proxy" }] },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function waitPort(port, ms = 10000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => { sock.destroy(); if (Date.now() > deadline) reject(new Error("Xray не запустился")); else setTimeout(attempt, 200); });
    };
    attempt();
  });
}

/** Запускает Xray; при падении перезапускает. stop() — выключить совсем. */
async function startXray({ exe, outbound, dir, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const configFile = path.join(dir, "xray.json");
  fs.writeFileSync(configFile, JSON.stringify(xrayConfig(outbound, port)), { mode: 0o600 });
  let child = null, stopped = false;
  const out = fs.openSync(path.join(dir, "xray.log"), "a");
  const launch = () => {
    child = spawn(exe, ["run", "-c", configFile], { windowsHide: true, stdio: ["ignore", out, out] });
    child.on("exit", (code) => {
      if (stopped) return;
      log(`Xray завершился (${code}), перезапускаю`);
      setTimeout(() => { if (!stopped) launch(); }, 3000);
    });
  };
  launch();
  await waitPort(port);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop() {
      stopped = true;
      try { child?.kill(); } catch { /* уже нет */ }
      try { fs.closeSync(out); } catch { /* закрыт */ }
    },
  };
}

module.exports = { reachable, fetchOutbound, xrayConfig, startXray, EDGE_URLS };

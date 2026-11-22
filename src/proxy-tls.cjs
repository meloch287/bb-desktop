// Подгружается в службу bb на ПК (NODE_OPTIONS=--require): TLS-соединения к нашему
// серверу (*.sslip.io) идут туннелем CONNECT через локальный Xray. Нужен потому, что
// WebSocket службы (библиотека ws) открывает TLS сам и HTTPS_PROXY не смотрит;
// fetch покрывает NODE_USE_ENV_PROXY. Включается переменной BB_TUNNEL_PROXY.
"use strict";

const net = require("node:net");
const tls = require("node:tls");
const { Duplex } = require("node:stream");
const { syncBuiltinESMExports } = require("node:module");

const proxy = process.env.BB_TUNNEL_PROXY ? new URL(process.env.BB_TUNNEL_PROXY) : null;
const match = new RegExp(process.env.BB_TUNNEL_HOSTS || "\\.sslip\\.io$", "i");

/** Поток, который сначала открывает CONNECT host:port у прокси, а до того копит запись. */
function tunnel(host, port) {
  const socket = net.connect(Number(proxy.port || 80), proxy.hostname);
  let ready = false;
  const pending = [];
  const stream = new Duplex({
    write(chunk, enc, cb) { if (ready) socket.write(chunk, enc, cb); else pending.push([chunk, enc, cb]); },
    read() { socket.resume(); },
    final(cb) { if (ready) socket.end(cb); else { pending.push([null, null, null]); cb(); } },
    destroy(err, cb) { socket.destroy(); cb(err); },
  });
  let head = Buffer.alloc(0);
  socket.on("connect", () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
  socket.on("data", function onData(chunk) {
    if (ready) { if (!stream.push(chunk)) socket.pause(); return; }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) { if (head.length > 16384) stream.destroy(new Error("proxy: слишком длинный ответ")); return; }
    if (!/^HTTP\/1\.[01] 200/.test(head.subarray(0, end).toString("latin1")))
      return stream.destroy(new Error("proxy: " + head.subarray(0, head.indexOf("\r\n")).toString("latin1")));
    ready = true;
    const rest = head.subarray(end + 4);
    if (rest.length) stream.push(rest);
    for (const [c, e, cb] of pending.splice(0)) { if (c === null) socket.end(); else socket.write(c, e, cb); }
  });
  socket.on("end", () => stream.push(null));
  socket.on("error", (err) => stream.destroy(err));
  return stream;
}

if (proxy) {
  const original = tls.connect;
  tls.connect = function connect(...args) {
    let options = {};
    if (typeof args[0] === "object" && args[0] !== null) options = args[0];
    else if (typeof args[0] === "number") options = { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined, ...(typeof args[2] === "object" ? args[2] : typeof args[1] === "object" ? args[1] : {}) };
    const host = options.host || options.servername || "localhost";
    if (options.socket || !match.test(host)) return original.apply(this, args);
    const callback = args.find((a) => typeof a === "function");
    const port = options.port || 443;
    return original.call(this, { ...options, socket: tunnel(host, port), servername: options.servername || host }, callback);
  };
  syncBuiltinESMExports();
}

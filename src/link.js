// Личная ссылка подключения из бота (/desktop) или профиля bb:
// https://u<id>.bb.200-165-236-8.sslip.io/__app/<64 hex>
"use strict";

const DOMAIN = "bb.200-165-236-8.sslip.io";
const LINK = /^https:\/\/(u[1-9][0-9]{0,15})\.bb\.200-165-236-8\.sslip\.io\/__app\/([a-f0-9]{64})\/?$/;

/** Нормализованная ссылка или null. Принимает текст с пробелами и мусором вокруг. */
function parseLink(text) {
  if (typeof text !== "string") return null;
  const found = text.match(/https:\/\/u[0-9]+\.bb\.200-165-236-8\.sslip\.io\/__app\/[a-f0-9]{64}\/?/i);
  if (!found) return null;
  const match = LINK.exec(found[0].toLowerCase());
  if (!match) return null;
  const origin = `https://${match[1]}.${DOMAIN}`;
  return { origin, url: `${origin}/__app/${match[2]}/`, prefix: `/__app/${match[2]}` };
}

/** Можно ли открыть адрес внутри окна (только своя рабочая зона). */
function isOwn(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Внешний адрес, который безопасно отдать системному браузеру. */
function isExternalWeb(url) {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

module.exports = { DOMAIN, parseLink, isOwn, isExternalWeb };

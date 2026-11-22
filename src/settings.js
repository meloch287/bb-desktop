// Настройки приложения bb (меню «Файл» → «Настройки приложения»). Хранятся в
// userData/settings.json. Без Electron — проверяется тестом под Node.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({
  glass: true,            // «жидкое стекло» (Windows 11 — акрил/мика, Mac — размытие macOS)
  material: "acrylic",    // acrylic — сильнее размывает, mica — спокойнее
  glassOpacity: 72,       // плотность фона bb поверх стекла, %
  smoothAnswers: "normal",// off | normal | soft — появление новых частей ответа
  animations: true,       // анимации интерфейса bb
  spellcheck: true,       // проверка орфографии в поле ввода
  smoothScroll: true,     // плавная прокрутка колесом (после перезапуска)
  gpu: true,              // аппаратное ускорение (после перезапуска)
});

const RESTART_KEYS = ["smoothScroll", "gpu"];

/** Поддерживает ли система стекло: Windows — mica с 22000, acrylic с 22621 (11 22H2); Mac — всегда (vibrancy). */
function glassSupport(platform = process.platform, release = require("node:os").release()) {
  if (platform === "darwin") return { mica: false, acrylic: false, vibrancy: true };
  if (platform !== "win32") return { mica: false, acrylic: false };
  const build = Number(String(release).split(".")[2] || 0);
  return { mica: build >= 22000, acrylic: build >= 22621 };
}

function normalize(raw, support = glassSupport()) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = s[key];
  for (const key of ["glass", "animations", "spellcheck", "smoothScroll", "gpu"]) out[key] = Boolean(out[key]);
  out.material = out.material === "mica" ? "mica" : "acrylic";
  if (out.material === "acrylic" && !support.acrylic && support.mica) out.material = "mica";
  if (!support.mica && !support.acrylic && !support.vibrancy) out.glass = false;
  const op = Math.round(Number(out.glassOpacity));
  out.glassOpacity = Number.isFinite(op) ? Math.min(95, Math.max(40, op)) : DEFAULTS.glassOpacity;
  out.smoothAnswers = ["off", "normal", "soft"].includes(out.smoothAnswers) ? out.smoothAnswers : DEFAULTS.smoothAnswers;
  return out;
}

function load(dir, support) {
  try {
    return normalize(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")), support);
  } catch {
    return normalize({}, support);
  }
}

function save(dir, settings, support) {
  const clean = normalize(settings, support);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(clean, null, 1));
  fs.renameSync(file + ".tmp", file);
  return clean;
}

/** Что из изменённого вступит в силу только после перезапуска. */
function needsRestart(before, after) {
  return RESTART_KEYS.filter((k) => before[k] !== after[k]);
}

module.exports = { DEFAULTS, glassSupport, normalize, load, save, needsRestart };

// Оформление bb внутри приложения: «жидкое стекло», плавное появление ответов,
// отключение анимаций. Возвращает код, который main.js выполняет на странице bb.
// Без Electron — тот же код проверяется в Playwright на настоящем bb.
"use strict";

const APPEAR_MS = { off: 0, normal: 180, soft: 320 };

function css() {
  return `
/* Стекло: основной фон и боковая панель полупрозрачные поверх Acrylic/Mica Windows.
   Меню, всплывающие окна и карточки почти плотные — текст на них читается всегда. */
html.bb-desk-glass, html.bb-desk-glass body { background: transparent !important; }
html.bb-desk-glass {
  --background: color-mix(in oklab, var(--canvas) var(--bb-glass, 72%), transparent);
  --sidebar: color-mix(in oklab, var(--canvas) calc(var(--bb-glass, 72%) - 12%), transparent);
  --popover: color-mix(in oklab, var(--canvas) 94%, transparent);
  --card: color-mix(in oklab, var(--canvas) calc(var(--bb-glass, 72%) + 14%), transparent);
}
html.bb-desk-glass [role="dialog"], html.bb-desk-glass [role="menu"], html.bb-desk-glass [role="listbox"], html.bb-desk-glass [data-radix-popper-content-wrapper] > * {
  backdrop-filter: blur(18px) saturate(1.4);
}
/* Слои не складываются: цвет только у внешнего слоя панели и основного фона,
   иначе 2–3 полупрозрачных слоя дают почти сплошной цвет. */
html.bb-desk-glass .bg-sidebar .bg-sidebar,
html.bb-desk-glass .bg-sidebar .relative.flex.w-full.min-w-0.flex-col::before,
html.bb-desk-glass .bg-sidebar .shrink-0.items-center.px-1[class*="ring-sidebar"]::before,
html.bb-desk-glass .bg-sidebar .shrink-0.items-center.px-1[class*="ring-sidebar"]::after { background-color: transparent !important; }
/* Прилипающий заголовок «Диалоги»: размытие вместо сплошных полос сверху и снизу. */
html.bb-desk-glass .bg-sidebar .shrink-0.items-center.px-1[class*="ring-sidebar"] { backdrop-filter: blur(12px); }
html.bb-desk-glass .bg-background .bg-background:not([data-promptbox]) { background-color: color-mix(in oklab, var(--canvas) 22%, transparent) !important; }
/* Под полем ввода прокручивается переписка — матовое стекло, чтобы текст не просвечивал. */
html.bb-desk-glass .shrink-0.bg-background:has(.chat-prompt-box) { backdrop-filter: blur(22px) saturate(1.25); }
html.bb-desk-glass [class*="h-(--bb-app-chrome-row-height)"] { background-color: color-mix(in oklab, var(--canvas) 18%, transparent) !important; backdrop-filter: blur(16px) saturate(1.3); }
html.bb-desk-glass form[data-promptbox] { background-color: color-mix(in oklab, var(--canvas) 88%, transparent) !important; backdrop-filter: blur(14px) saturate(1.3); }
/* Плавное появление новых частей ответа. */
html.bb-desk-smooth .bb-appear { animation: bb-appear var(--bb-appear-ms, 180ms) cubic-bezier(.2,.8,.2,1) both; }
@keyframes bb-appear { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
/* Без анимаций — для слабых ПК. */
html.bb-desk-still *, html.bb-desk-still *::before, html.bb-desk-still *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; scroll-behavior: auto !important; }
`;
}

/** Скрипт для страницы: ставит классы на <html> и следит за новыми частями ответа. */
function pageScript(settings) {
  const opts = {
    glass: Boolean(settings.glass),
    opacity: settings.glassOpacity,
    appear: settings.animations ? APPEAR_MS[settings.smoothAnswers] ?? 180 : 0,
    still: !settings.animations,
  };
  return `(() => {
  const o = ${JSON.stringify(opts)};
  const root = document.documentElement;
  let style = document.getElementById("bb-desktop-look");
  if (!style) { style = document.createElement("style"); style.id = "bb-desktop-look"; document.head.appendChild(style); }
  style.textContent = ${JSON.stringify(css())};
  root.classList.toggle("bb-desk-glass", o.glass);
  root.style.setProperty("--bb-glass", o.opacity + "%");
  root.classList.toggle("bb-desk-still", o.still);
  root.classList.toggle("bb-desk-smooth", o.appear > 0);
  root.style.setProperty("--bb-appear-ms", o.appear + "ms");
  if (window.__bbAppear) { window.__bbAppear.disconnect(); window.__bbAppear = null; }
  if (o.appear <= 0) return;
  // Новые элементы последнего сообщения ленты (то, что пишется сейчас) — с мягким
  // появлением. Открытие диалога и переходы не анимируем: после них пауза 1,5 с.
  let quietSince = performance.now();
  const calm = () => { quietSince = performance.now(); };
  if (!window.__bbAppearNav) {
    window.__bbAppearNav = true;
    for (const k of ["pushState", "replaceState"]) { const f = history[k]; history[k] = function () { window.__bbAppearCalm?.(); return f.apply(this, arguments); }; }
    addEventListener("popstate", () => window.__bbAppearCalm?.());
  }
  window.__bbAppearCalm = calm;
  const mo = new MutationObserver((list) => {
    const now = performance.now();
    let added = 0;
    for (const m of list) added += m.addedNodes.length;
    if (added > 40) { calm(); return; }
    if (now - quietSince < 1500) return;
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType !== 1 || n.classList.contains("bb-appear") || !n.parentElement) continue;
      const row = n.parentElement.closest("[data-timeline-row-id]");
      if (!row || row.nextElementSibling || n.closest("[data-promptbox]")) continue;
      n.classList.add("bb-appear");
      n.addEventListener("animationend", () => n.classList.remove("bb-appear"), { once: true });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  window.__bbAppear = mo;
})();`;
}

module.exports = { css, pageScript, APPEAR_MS };

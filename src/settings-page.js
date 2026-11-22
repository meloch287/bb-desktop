"use strict";
const $ = (id) => document.getElementById(id);
let state = null;

function render() {
  const s = state.settings, sup = state.support;
  const glassOk = sup.mica || sup.acrylic || sup.vibrancy;
  $("glass").checked = s.glass;
  $("glass").disabled = !glassOk;
  if (!glassOk) $("glass-note").textContent = "Нужна Windows 11 — на этой системе недоступно";
  $("m-acrylic").disabled = !sup.acrylic;
  $("m-acrylic").checked = s.material === "acrylic";
  $("m-mica").checked = s.material === "mica";
  $("material-row").hidden = $("opacity-row").hidden = !s.glass;
  if (sup.vibrancy) $("material-row").hidden = true; // на Mac материал один — системное размытие
  $("glassOpacity").value = s.glassOpacity;
  $("opacity-val").textContent = s.glassOpacity + "%";
  for (const k of ["animations", "spellcheck", "smoothScroll", "gpu"]) $(k).checked = s[k];
  $("smoothAnswers").value = s.smoothAnswers;
  $("smoothAnswers").disabled = !s.animations;
  $("restart").hidden = !state.restart?.length;
}

async function set(patch) {
  const r = await window.bbDesktop.setSettings(patch);
  if (r) { state = { ...state, ...r }; render(); }
}

window.bbDesktop.settings().then((r) => { state = r; render(); });
for (const k of ["glass", "animations", "spellcheck", "smoothScroll", "gpu"]) $(k).addEventListener("change", (e) => set({ [k]: e.target.checked }));
for (const id of ["m-acrylic", "m-mica"]) $(id).addEventListener("change", (e) => set({ material: e.target.value }));
let t = 0;
$("glassOpacity").addEventListener("input", (e) => { $("opacity-val").textContent = e.target.value + "%"; clearTimeout(t); t = setTimeout(() => set({ glassOpacity: Number(e.target.value) }), 80); });
$("smoothAnswers").addEventListener("change", (e) => set({ smoothAnswers: e.target.value }));
$("restart-btn").addEventListener("click", () => window.bbDesktop.restart());

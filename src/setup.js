"use strict";
window.bbDesktop.onSetupProgress((step) => {
  document.getElementById("label").textContent = step.label;
  const p = Math.max(0, Math.min(1, Number(step.progress) || 0));
  document.getElementById("fill").style.width = `${Math.round(p * 100)}%`;
});

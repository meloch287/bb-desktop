"use strict";
const error = new URLSearchParams(location.search).get("error");
if (error) document.getElementById("error").textContent = "Ошибка: " + error;
let left = 15;
const tick = setInterval(() => {
  left -= 1;
  document.getElementById("left").textContent = String(left);
  if (left <= 0) {
    clearInterval(tick);
    window.bbDesktop.retry();
  }
}, 1000);
document.getElementById("retry").addEventListener("click", () => {
  clearInterval(tick);
  window.bbDesktop.retry();
});

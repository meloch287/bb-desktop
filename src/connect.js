"use strict";
const $ = (id) => document.getElementById(id);
const status = $("status");
const message = new URLSearchParams(location.search).get("message");
if (message) {
  status.textContent = message;
  status.className = "error";
}
window.bbDesktop.clipboardLink().then((link) => {
  if (link && !$("link").value) {
    $("link").value = link;
    if (!message) status.textContent = "Ссылка из буфера обмена уже подставлена — нажми «Подключить».";
  }
});
$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("go").disabled = true;
  status.className = "";
  status.textContent = "Подключаюсь…";
  const result = await window.bbDesktop.connect($("link").value);
  if (!result.ok) {
    status.className = "error";
    status.textContent = result.error;
    $("go").disabled = false;
  }
});

// Мост только для локальных страниц приложения (подключение, нет связи).
// Страницам bb с сервера ничего не отдаём.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("bbDesktop", {
    clipboardLink: () => ipcRenderer.invoke("bb:clipboard-link"),
    connect: (text) => ipcRenderer.invoke("bb:connect", text),
    retry: () => ipcRenderer.invoke("bb:retry"),
    onSetupProgress: (cb) => ipcRenderer.on("bb:setup-progress", (_e, step) => cb(step)),
    settings: () => ipcRenderer.invoke("bb:settings-get"),
    setSettings: (patch) => ipcRenderer.invoke("bb:settings-set", patch),
    restart: () => ipcRenderer.invoke("bb:restart"),
  });
}

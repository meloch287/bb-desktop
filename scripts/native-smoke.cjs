"use strict";
// Runs only in the disposable Windows CI runner. Never uses a user's profile.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function evaluate(url, expression) {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Renderer inspection timed out")); }, 15_000);
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Renderer connection failed")); });
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })));
    socket.addEventListener("message", ({ data }) => {
      const response = JSON.parse(data);
      if (response.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (response.error || response.result?.exceptionDetails) reject(new Error("Renderer evaluation failed"));
      else resolve(response.result.result.value);
    });
  });
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Native smoke is restricted to disposable GitHub runners");
  assert.equal(process.platform, "win32");
  const executable = process.argv[2];
  assert.ok(executable, "Pass the installed bb.exe path");
  const port = await freePort();
  const child = spawn(executable, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], { stdio: "ignore" });
  let launchError;
  child.on("error", error => { launchError = error; });
  try {
    let page;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Application exited during startup: ${child.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
        page = (await response.json()).find(item => item.type === "page" && item.url.startsWith("file:") && item.url.includes("connect.html"));
        if (page) break;
      } catch {}
      await delay(500);
    }
    assert.ok(page, "Installed application must render its connection page");
    const state = await evaluate(page.webSocketDebuggerUrl, `(async () => ({ ready: document.readyState, input: !!document.querySelector('#link'), preload: typeof window.bbDesktop?.settings === 'function', gpu: (await window.bbDesktop.settings()).settings.gpu }))()`);
    assert.ok(["interactive", "complete"].includes(state.ready));
    assert.equal(state.input, true, "Connection form rendered");
    assert.equal(state.preload, true, "Preload IPC bridge loaded");
    assert.equal(state.gpu, false, "Existing settings survived installation and are used by the app");
    console.log("Native smoke passed: connection UI, preload IPC, preserved settings");
  } finally {
    if (child.pid) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

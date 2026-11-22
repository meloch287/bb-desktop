"use strict";
const macArch = process.env.BB_BUILD_ARCH || process.arch;
module.exports = {
  appId: "ru.aibot.bb",
  productName: "bb",
  electronVersion: "44.9.3",
  directories: { output: "dist", buildResources: "build/resources" },
  asar: true,
  npmRebuild: false,
  files: ["src/**/*", "package.json"],
  publish: [{ provider: "generic", url: "https://bb.2.29.166.225.sslip.io/download/desktop/" }],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/resources/win32-x64/icon.ico",
    executableName: "bb",
    signExecutable: false,
    extraResources: [{ from: "build/resources/win32-x64/xray", to: "xray" }],
    artifactName: "bb-setup.${ext}"
  },
  nsis: {
    guid: "496ef164-98f2-5287-85cd-e8fbc166be1d",
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
    shortcutName: "bb"
  },
  mac: {
    target: [{ target: "zip", arch: ["arm64", "x64"] }],
    category: "public.app-category.productivity",
    icon: `build/resources/darwin-${macArch}/icon.icns`,
    identity: "-",
    hardenedRuntime: false,
    notarize: false,
    extraResources: [{ from: "build/resources/darwin-${arch}/xray", to: "xray" }],
    artifactName: "bb-mac-${arch}-${version}.${ext}"
  }
};

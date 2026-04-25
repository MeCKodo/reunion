"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

/**
 * After every macOS arch packaging, do an ad-hoc codesign over the entire
 * .app bundle so its embedded resources are properly sealed. Without this
 * step the app fails Gatekeeper's "no resources but signature indicates they
 * must be present" check on Apple Silicon, even though the Electron binary
 * itself ships with linker-signed adhoc.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterPack] ad-hoc signing: ${appPath}`);
  const result = spawnSync(
    "codesign",
    [
      "--deep",
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      "--preserve-metadata=entitlements,requirements,flags,runtime",
      appPath,
    ],
    { stdio: "inherit" }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`codesign exited with status ${result.status}`);
  }
};

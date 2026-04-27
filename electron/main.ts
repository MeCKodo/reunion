import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// File-based diagnostic logger
// ---------------------------------------------------------------------------
//
// macOS swallows stdout/stderr from GUI .app launches, so we always mirror
// console output to ~/Library/Logs/Reunion/main.log. This makes production
// debugging (and the QA pass) tractable without re-packaging.

const logsDir = (() => {
  try {
    return app.getPath("logs");
  } catch {
    return path.join(
      process.env.HOME ?? "",
      "Library",
      "Logs",
      "Reunion"
    );
  }
})();
try {
  fs.mkdirSync(logsDir, { recursive: true });
} catch {
  // best-effort
}
const mainLogPath = path.join(logsDir, "main.log");

function logLine(level: string, ...args: unknown[]) {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) =>
      a instanceof Error
        ? a.stack ?? a.message
        : typeof a === "string"
        ? a
        : JSON.stringify(a)
    )
    .join(" ")}\n`;
  try {
    fs.appendFileSync(mainLogPath, line);
  } catch {
    // ignore write failures
  }
}

const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.log = (...args: unknown[]) => {
  logLine("INFO", ...args);
  originalLog(...args);
};
console.warn = (...args: unknown[]) => {
  logLine("WARN", ...args);
  originalWarn(...args);
};
console.error = (...args: unknown[]) => {
  logLine("ERROR", ...args);
  originalError(...args);
};

console.log("main.ts boot", {
  bootstrapped: process.env.REUNION_BOOTSTRAPPED === "1",
  dataDir: process.env.REUNION_DATA_DIR,
  frontendDistDir: process.env.REUNION_FRONTEND_DIST_DIR,
  logsDir,
  isPackaged: app.isPackaged,
});

if (!process.env.REUNION_BOOTSTRAPPED) {
  console.warn(
    "[reunion] WARN: bootstrap.cjs did not run; falling back to defaults"
  );
}

import fixPath from "fix-path";
try {
  fixPath();
  console.log("fix-path applied", { PATH: process.env.PATH?.slice(0, 200) });
} catch (error) {
  console.warn("[reunion] fix-path failed:", error);
}

import { runServe } from "../src/http-server.js";
import {
  DEFAULT_CURSOR_ROOT,
  DEFAULT_CLAUDE_ROOT,
  DEFAULT_CODEX_ROOT,
} from "../src/config.js";

type ServerHandle = Awaited<ReturnType<typeof runServe>>;

const dataDir = process.env.REUNION_DATA_DIR ?? "";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("failed to acquire free port"));
      }
    });
  });
}

let serverHandle: ServerHandle | null = null;
let serverPort = 0;
let mainWindow: BrowserWindow | null = null;

async function startBackend(): Promise<void> {
  serverPort = await getFreePort();
  serverHandle = await runServe("127.0.0.1", serverPort, {
    cursor: DEFAULT_CURSOR_ROOT,
    claudeCode: DEFAULT_CLAUDE_ROOT,
    codex: DEFAULT_CODEX_ROOT,
  });
  await writeRuntimeInfo();
}

async function writeRuntimeInfo(): Promise<void> {
  try {
    const fsMod = await import("node:fs/promises");
    const logsDir = app.getPath("logs");
    await fsMod.mkdir(logsDir, { recursive: true });
    await fsMod.writeFile(
      path.join(logsDir, "runtime.json"),
      JSON.stringify(
        {
          startedAt: new Date().toISOString(),
          serverUrl: `http://127.0.0.1:${serverPort}`,
          dataDir: process.env.REUNION_DATA_DIR ?? null,
          frontendDistDir: process.env.REUNION_FRONTEND_DIST_DIR ?? null,
          version: app.getVersion(),
        },
        null,
        2
      )
    );
  } catch (error) {
    console.warn("[reunion] failed to write runtime.json:", error);
  }
}

async function stopBackend(): Promise<void> {
  if (!serverHandle) return;
  console.log("stopping backend...", { port: serverPort });
  try {
    await serverHandle.close();
    console.log("backend stopped");
  } catch (error) {
    console.warn("backend server close failed:", error);
  } finally {
    serverHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: "Reunion",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0b0b0f",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  // External links open in the system browser instead of inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? ([
              { type: "separator" as const },
              { role: "front" as const },
            ] as Electron.MenuItemConstructorOptions[])
          : ([{ role: "close" as const }] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Open Data Folder",
          click: () => {
            shell.openPath(dataDir);
          },
        },
        {
          label: "Open Project Repository",
          click: () => {
            shell.openExternal("https://github.com/MeCKodo/reunion");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.setName("Reunion");
app.setAboutPanelOptions({
  applicationName: "Reunion",
  applicationVersion: app.getVersion(),
  copyright: "MIT License",
  website: "https://github.com/MeCKodo/reunion",
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    console.log("app.whenReady fired");
    try {
      await startBackend();
      console.log("backend started", { port: serverPort });
    } catch (error) {
      console.error("failed to start backend:", error);
      dialog.showErrorBox(
        "Reunion",
        `后端服务启动失败:\n${(error as Error).message ?? String(error)}`
      );
      app.quit();
      return;
    }

    buildMenu();
    createWindow();
    console.log("window created");
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort > 0) {
      createWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", async (event) => {
    if (!serverHandle) return;
    event.preventDefault();
    console.log("before-quit: shutting down");
    await stopBackend();
    app.exit(0);
  });
}

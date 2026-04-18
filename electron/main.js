const { app, BrowserWindow, Menu, ipcMain, dialog } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const isDev = !app.isPackaged;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWindow;
let serverProcess;
let isQuitting = false;
const BASE_PORT = 3001;
let runtimePort = BASE_PORT;
const APP_ICON_PATH = path.join(__dirname, "../client/public/favicon.ico");

function createBackendErrorWindow(message) {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: APP_ICON_PATH,
  });

  mainWindow.loadURL(`data:text/html,${encodeURIComponent(`
    <html>
      <body style="font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#e5e7eb;padding:28px;line-height:1.5;">
        <h2 style="margin:0 0 12px;">SwiftDrop</h2>
        <h3 style="margin:0 0 10px;color:#f87171;">Cannot reach local backend service</h3>
        <p style="margin:0 0 10px;">Please close and reopen the app. If this persists, ensure no firewall rule is blocking localhost communication.</p>
        <pre style="white-space:pre-wrap;background:#111827;color:#d1d5db;padding:14px;border-radius:10px;">${String(message || "Unknown startup error")}</pre>
      </body>
    </html>
  `)}`);
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(startPort = BASE_PORT, attempts = 20) {
  for (let p = startPort; p < startPort + attempts; p++) {
    if (await checkPortAvailable(p)) return p;
  }
  throw new Error(`No free port found in range ${startPort}-${startPort + attempts - 1}`);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, "preload.js"),
    },
    icon: APP_ICON_PATH,
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("app-closing");
    }
    setTimeout(() => {
      isQuitting = true;
      app.quit();
    }, 500);
  });

  const url = isDev
    ? "http://localhost:5173"
    : `http://localhost:${port}`;

  mainWindow.loadURL(url);

  mainWindow.webContents.on("did-fail-load", () => {
    if (!isDev) {
      mainWindow.loadURL(`data:text/html,${encodeURIComponent(`
        <html><body style="font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#e5e7eb;padding:24px;">
          <h2>SwiftDrop failed to start</h2>
          <p>The local service did not start correctly. Please close and reopen the app.</p>
        </body></html>
      `)}`);
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  createMenu();
}

function createMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Exit",
          accelerator: "CmdOrCtrl+Q",
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", role: "undo" },
        { label: "Redo", accelerator: "CmdOrCtrl+Y", role: "redo" },
        { type: "separator" },
        { label: "Cut", accelerator: "CmdOrCtrl+X", role: "cut" },
        { label: "Copy", accelerator: "CmdOrCtrl+C", role: "copy" },
        { label: "Paste", accelerator: "CmdOrCtrl+V", role: "paste" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", role: "reload" },
        { label: "Toggle DevTools", accelerator: "CmdOrCtrl+Shift+I", role: "toggleDevTools" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About SwiftDrop",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About SwiftDrop",
              message: "SwiftDrop",
              detail: "Fast, secure peer-to-peer file sharing on local networks.\n\nVersion 1.0.0",
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(
      __dirname,
      "../server/index.js"
    );

    let settled = false;
    let stderrBuf = "";

    serverProcess = spawn(process.execPath, [serverPath], {
      stdio: isDev ? "inherit" : "pipe",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_APP: "1",
        NODE_ENV: isDev ? "development" : "production",
        PORT: String(port),
      },
    });

    serverProcess.on("error", (err) => {
      console.error("Server error:", err);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    serverProcess.on("exit", (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(`Server exited with code ${code}${stderrBuf ? `\n${stderrBuf}` : ""}`));
      }
    });

    if (!isDev) {
      serverProcess.stdout?.on("data", (data) => {
        console.log(`[Server] ${data}`);
      });
      serverProcess.stderr?.on("data", (data) => {
        console.error(`[Server] ${data}`);
        stderrBuf += String(data);
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
      });
    }

    const startedAt = Date.now();
    const timeoutMs = 15000;

    const check = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
        res.resume();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      req.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          if (!settled) {
            settled = true;
            reject(new Error(`Timed out waiting for local server startup${stderrBuf ? `\n${stderrBuf}` : ""}`));
          }
          return;
        }
        setTimeout(check, 300);
      });

      req.on("timeout", () => {
        req.destroy();
      });
    };

    check();
  });
}

async function bootServerWithRetries(maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const candidatePort = await findAvailablePort(BASE_PORT + i, 1);
    try {
      await startServer(candidatePort);
      runtimePort = candidatePort;
      return;
    } catch (err) {
      const msg = String(err?.message || err);
      // On address conflicts, try next port; otherwise fail fast.
      if (/EADDRINUSE/i.test(msg)) continue;
      throw err;
    }
  }
  throw new Error("Could not start backend: no available port found.");
}

app.on("ready", async () => {
  try {
    await bootServerWithRetries(20);
    createWindow(runtimePort);
  } catch (err) {
    createBackendErrorWindow(err?.message || String(err));
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow(runtimePort);
  }
});

// IPC Handlers for frontend communication
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("get-app-path", () => app.getAppPath());
ipcMain.handle("show-error-dialog", (event, message, detail) => {
  return dialog.showMessageBox(mainWindow, {
    type: "error",
    title: "Error",
    message,
    detail,
  });
});
ipcMain.handle("show-success-dialog", (event, message, detail) => {
  return dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Success",
    message,
    detail,
  });
});

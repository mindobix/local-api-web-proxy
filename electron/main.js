'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const autostart = require('./autostart');

// Proxy runs on a non-privileged port; dashboard on another.
// These can be overridden with env vars for dev.
const PROXY_PORT = parseInt(process.env.PROXY_PORT) || 9999;
const DASH_PORT  = parseInt(process.env.DASH_PORT)  || 9000;

// When launched by the OS's "start at login" hook, we pass --hidden so the
// window stays closed and only the tray icon appears. The user opens the
// dashboard explicitly via the tray menu.
const startHidden = process.argv.includes('--hidden');

let mainWindow  = null;
let tray        = null;
let isQuitting  = false;
let serverReady = false;
let server      = null; // lazy-required once userData path is available

function createTrayIcon() {
  // Use the real app icon for the tray (cyan WP circle) instead of a
  // hand-drawn placeholder. On Windows load the multi-size .ico so the
  // OS picks the correct size (16/24/32) per DPI; elsewhere load the
  // 1024² PNG and downscale once.
  const iconPath = path.join(
    __dirname, '..', 'resources',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );

  let img = nativeImage.createFromPath(iconPath);

  if (img.isEmpty()) {
    console.warn('[tray] failed to load icon at', iconPath, '— falling back to drawn ring');
    return fallbackRing();
  }

  // Linux tray icons look best at ~22px; Windows handles the .ico's embedded
  // sizes natively; macOS menu-bar icons prefer ~22px template images.
  if (process.platform === 'linux' || process.platform === 'darwin') {
    img = img.resize({ width: 22, height: 22 });
  }

  // Do NOT mark as template — the cyan colour is part of the app identity,
  // and the Windows/Linux trays render colour correctly. On macOS this means
  // the WP appears in colour rather than being tinted by the menu-bar theme,
  // which is the explicit tradeoff the user asked for.
  return img;
}

function fallbackRing() {
  // Emergency fallback only — the .ico / .png file should always exist.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = 7.5, cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= 49 && d2 >= 16) {
        const i = (y * size + x) * 4;
        buf[i] = 0x06; buf[i + 1] = 0xb6; buf[i + 2] = 0xd4; buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'LocalAPIWebProxy', enabled: false },
    { type: 'separator' },
    {
      label: `Proxy  : 0.0.0.0:${PROXY_PORT}`,
      enabled: false,
    },
    {
      label: `Dashboard : http://localhost:${DASH_PORT}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: 'Open CA Cert URL',
      click: () => shell.openExternal(`http://localhost:${DASH_PORT}/ca.crt`),
    },
    {
      label: 'Open certs folder',
      click: () => shell.openPath(process.env.CERTS_DIR),
    },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: autostart.isEnabled(),
      enabled: app.isPackaged, // only meaningful for installed builds
      click: (item) => {
        autostart.setEnabled(item.checked);
        // Rebuild so the checkbox state reflects the actual OS-level setting,
        // in case setEnabled silently failed.
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('LocalAPIWebProxy — local HTTP(S) proxy');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    } else {
      createWindow();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#111315',
    title: 'LocalAPIWebProxy',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Once server has bound, point the window at the dashboard.
  const load = () => {
    mainWindow.loadURL(`http://localhost:${DASH_PORT}`).catch((err) => {
      console.error('Failed to load dashboard URL:', err);
    });
  };
  if (serverReady) load();
  else serverReadyCallbacks.push(load);

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Outgoing target="_blank" links and cert URL open in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

const serverReadyCallbacks = [];
function onServerReady(cb) {
  if (serverReady) cb();
  else serverReadyCallbacks.push(cb);
}

async function startServer() {
  try {
    // Point the proxy's cert dir at a writable userData location BEFORE
    // requiring server.js — its top-level code calls loadOrCreateCA() which
    // writes to CERTS_DIR. In a packaged app, __dirname sits inside the
    // read-only app bundle, so redirect to userData first.
    process.env.CERTS_DIR = path.join(app.getPath('userData'), 'certs');
    fs.mkdirSync(process.env.CERTS_DIR, { recursive: true });

    server = require('../server.js');
    await server.start({ proxyPort: PROXY_PORT, dashPort: DASH_PORT, quiet: false });
    serverReady = true;
    for (const cb of serverReadyCallbacks.splice(0)) cb();
  } catch (err) {
    console.error('Failed to start proxy server:', err);
    dialog.showErrorBox(
      'LocalAPIWebProxy — startup failed',
      `The proxy server could not start.\n\n${err && err.message ? err.message : String(err)}`
    );
    app.quit();
  }
}

// Prevent multiple instances — a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    startServer();
    createTray();
    autostart.enableOnFirstRun(); // no-op in dev and on 2nd+ launches
    if (!startHidden) createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
  });
}

// On macOS, keep the app alive in the tray after the last window is closed.
app.on('window-all-closed', () => {
  // Intentionally no app.quit() — tray keeps the proxy alive.
});

app.on('before-quit', () => {
  isQuitting = true;
});

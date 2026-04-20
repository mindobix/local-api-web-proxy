'use strict';

// Cross-platform "start at login" for LocalAPIWebProxy.
//   macOS + Windows: Electron's built-in app.setLoginItemSettings().
//   Linux:           ~/.config/autostart/LocalAPIWebProxy.desktop.
//
// All functions are no-ops in dev mode (app.isPackaged === false) — we never
// want a development checkout to register itself as a login item.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { app } = require('electron');

const APP_NAME = 'LocalAPIWebProxy';
const LINUX_DESKTOP_FILE = path.join(os.homedir(), '.config', 'autostart', `${APP_NAME}.desktop`);

function linuxDesktopFileContents() {
  // On an AppImage, process.execPath points inside the mounted squashfs (a
  // temporary path that changes on every launch). The environment variable
  // APPIMAGE holds the stable path to the .AppImage file itself.
  const exec = process.env.APPIMAGE || process.execPath;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${APP_NAME}`,
    'Comment=Local HTTP/HTTPS proxy with real-time dashboard',
    `Exec="${exec}" --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'Categories=Development;Network;',
    '',
  ].join('\n');
}

function isEnabled() {
  if (!app.isPackaged) return false;
  if (process.platform === 'linux') {
    return fs.existsSync(LINUX_DESKTOP_FILE);
  }
  return app.getLoginItemSettings({ path: process.execPath }).openAtLogin;
}

function setEnabled(enabled) {
  if (!app.isPackaged) return; // silently no-op in dev

  if (process.platform === 'linux') {
    if (enabled) {
      fs.mkdirSync(path.dirname(LINUX_DESKTOP_FILE), { recursive: true });
      fs.writeFileSync(LINUX_DESKTOP_FILE, linuxDesktopFileContents(), { mode: 0o644 });
    } else {
      try { fs.unlinkSync(LINUX_DESKTOP_FILE); } catch {}
    }
    return;
  }

  // macOS + Windows
  const settings = {
    openAtLogin: enabled,
    path:        process.execPath,
  };
  if (process.platform === 'darwin') {
    // macOS can start hidden via this flag natively.
    settings.openAsHidden = true;
  } else {
    // Windows has no openAsHidden — pass --hidden and handle it ourselves.
    settings.args = ['--hidden'];
  }
  app.setLoginItemSettings(settings);
}

// On the very first launch of a packaged build, turn autostart on by default.
// After that, respect whatever the user last chose via the tray toggle.
function enableOnFirstRun() {
  if (!app.isPackaged) return;
  const marker = path.join(app.getPath('userData'), '.autostart-initialized');
  if (fs.existsSync(marker)) return;
  try {
    setEnabled(true);
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (err) {
    console.error('[autostart] first-run enable failed:', err);
  }
}

module.exports = { isEnabled, setEnabled, enableOnFirstRun };

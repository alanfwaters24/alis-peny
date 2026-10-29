// main.js — turns P.E.N.Y into a normal Windows program.
// Starts the same backend used on the server edition, pointed at a data
// folder in the user's own profile, and opens it in a desktop window.
// Shows a clear error box (and writes startup.log) instead of
// failing silently, and waits for the backend to be ready before opening.

const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 4278;
const LOG_FILE = path.join(app.getPath('userData'), 'startup.log');

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* logging must never crash the app */ }
}

function fail(title, err) {
  const text = (err && err.stack) ? err.stack : String(err);
  log(`${title}: ${text}`);
  try { dialog.showErrorBox(`P.E.N.Y — ${title}`, `${text}\n\nA log was saved to:\n${LOG_FILE}`); } catch (_) {}
  app.exit(1);
}

process.on('uncaughtException', (err) => fail('Unexpected error', err));
process.on('unhandledRejection', (err) => fail('Unexpected error', err));

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running — it will bring its window to the front (see 'second-instance').
  app.quit();
}

// Data lives under the normal Windows AppData folder, e.g.
// C:\Users\<name>\AppData\Roaming\P.E.N.Y\data — back it up like any important files.
process.env.PENY_DATA_DIR = path.join(app.getPath('userData'), 'data');
process.env.SERVE_STATIC_FROM = path.join(__dirname, 'frontend');
process.env.PORT = String(PORT);
process.env.LISTEN_HOST = '127.0.0.1'; // this PC only
process.env.PENY_EDITION = 'Windows Edition';

let mainWindow;

function waitForBackend(tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(); else retry(n);
      });
      req.on('error', () => retry(n));
      req.on('timeout', () => { req.destroy(); retry(n); });
    };
    const retry = (n) => (n <= 0 ? reject(new Error('The P.E.N.Y engine did not start within 30 seconds.\nAnother program may be using port ' + PORT + '.')) : setTimeout(() => attempt(n - 1), 500));
    attempt(tries);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430, height: 900, minWidth: 380,
    title: 'P.E.N.Y',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#05100D',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => log(`window failed to load: ${code} ${desc}`));
  // External links (e.g. GoCardless bank login) open in the normal browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(async () => {
  log(`starting v${app.getVersion()}, data dir ${process.env.PENY_DATA_DIR}`);
  try {
    require('./backend/server.js'); // starts listening when loaded
  } catch (err) {
    return fail('Could not start the engine', err);
  }
  try {
    await waitForBackend();
  } catch (err) {
    return fail('Engine not responding', err);
  }
  log('backend ready, opening window');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((err) => fail('Startup failed', err));

app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

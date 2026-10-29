// main.js — this is what turns P.E.N.Y into a normal Windows program.
// It starts the same backend used on the server edition, but pointed at a
// data folder in the user's own profile (no Docker, no TrueNAS, no network
// setup needed) and opens it in a plain desktop window.

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const PORT = 4278; // fixed local port — nothing else on the PC should be using this

// Everything P.E.N.Y stores lives under the normal Windows AppData folder,
// e.g. C:\Users\<name>\AppData\Roaming\P.E.N.Y\data — back this folder up
// the same way you'd back up any other important files.
process.env.PENY_DATA_DIR = path.join(app.getPath('userData'), 'data');
process.env.SERVE_STATIC_FROM = path.join(__dirname, 'frontend');
process.env.PORT = String(PORT);
process.env.LISTEN_HOST = '127.0.0.1'; // this PC only — nothing else on the network can reach it

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430,
    height: 900,
    minWidth: 380,
    title: 'P.E.N.Y',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#0a0f0d',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Open any external links (e.g. GoCardless bank login) in the normal
  // system browser rather than inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  // Starting the backend just means requiring it — it calls app.listen()
  // itself when loaded, same as it does on the server edition.
  require('./backend/server.js');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

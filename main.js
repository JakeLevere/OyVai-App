// Minimal Electron main process to load Index.html
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// Keep a global reference of the window object to avoid GC
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0b0b0f',
    webPreferences: {
      // Disable Node.js integration in renderer for safety
      nodeIntegration: false,
      contextIsolation: true,
      // Enable zoom/HiDPI correctly while loading local file
      sandbox: false,
    },
    show: true,
  });

  // Optional: disable default menu
  try { Menu.setApplicationMenu(null); } catch (_) {}

  // Load the local Index.html
  mainWindow.loadFile(path.join(__dirname, 'Index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Recommended on Windows for notifications/taskbar grouping
if (process.platform === 'win32') {
  app.setAppUserModelId('com.oyvai.app');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // On macOS, apps generally stay active until user quits explicitly
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS, recreate a window when dock icon is clicked
  if (mainWindow === null) {
    createWindow();
  }
});


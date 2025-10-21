const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let settingsCache = null;

const SETTINGS_FILE_NAME = 'settings.json';
const NOTES_HEADER = '# OyVai Daily Notes';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0b0b0f',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  try {
    Menu.setApplicationMenu(null);
  } catch (_) {
    // ignore if menu cannot be cleared
  }

  mainWindow.loadFile(path.join(__dirname, 'Index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle('notes:get-path', async () => {
    const settings = loadSettings();
    return settings.notesFilePath || null;
  });

  ipcMain.handle('notes:select-file', async () => {
    const targetWindow = BrowserWindow.getFocusedWindow() || mainWindow;
    const defaultPath = path.join(app.getPath('documents'), 'oyvai-daily-notes.md');
    const { canceled, filePath } = await dialog.showSaveDialog(targetWindow, {
      title: 'Select daily notes file',
      defaultPath,
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    const settings = loadSettings();
    settings.notesFilePath = filePath;
    await ensureNotesFile(filePath);
    saveSettings(settings);
    broadcastNotesPathChanged(filePath);

    return { canceled: false, filePath };
  });

  ipcMain.handle('notes:save', async (_event, payload) => {
    const { dateKey, content } = payload || {};
    if (!dateKey || typeof dateKey !== 'string') {
      throw new Error('Invalid date key.');
    }
    if (typeof content !== 'string') {
      throw new Error('Invalid content.');
    }

    const settings = loadSettings();
    if (!settings.notesFilePath) {
      return { success: false, reason: 'NO_PATH' };
    }

    await ensureNotesFile(settings.notesFilePath);

    const markdown = await fs.promises.readFile(settings.notesFilePath, 'utf8');
    const { header, notes } = parseNotes(markdown);

    const normalized = normalizeBullets(content);
    if (normalized.length > 0) {
      notes[dateKey] = normalized;
    } else {
      delete notes[dateKey];
    }

    const updated = buildNotesDocument(header, notes);
    await fs.promises.writeFile(settings.notesFilePath, updated, 'utf8');

    broadcastNotesUpdated(dateKey);

    return { success: true };
  });

  ipcMain.handle('notes:load', async (_event, dateKey) => {
    if (!dateKey || typeof dateKey !== 'string') {
      throw new Error('Invalid date key.');
    }

    const settings = loadSettings();
    if (!settings.notesFilePath) {
      return { content: '' };
    }

    await ensureNotesFile(settings.notesFilePath);
    const markdown = await fs.promises.readFile(settings.notesFilePath, 'utf8');
    const { notes } = parseNotes(markdown);
    return { content: notes[dateKey] || '' };
  });
}

function loadSettings() {
  if (settingsCache) {
    return settingsCache;
  }

  const filePath = getSettingsFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    settingsCache = {
      notesFilePath: '',
      ...parsed,
    };
  } catch (error) {
    settingsCache = { notesFilePath: '' };
  }
  return settingsCache;
}

function saveSettings(settings) {
  settingsCache = {
    notesFilePath: '',
    ...settings,
  };

  const filePath = getSettingsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settingsCache, null, 2), 'utf8');
}

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE_NAME);
}

async function ensureNotesFile(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.size === 0) {
      await fs.promises.writeFile(filePath, `${NOTES_HEADER}\n\n`, 'utf8');
      return;
    }
    const contents = await fs.promises.readFile(filePath, 'utf8');
    if (!contents.trim().startsWith('#')) {
      const newline = contents.trim().length ? `\n\n${contents}` : '';
      await fs.promises.writeFile(filePath, `${NOTES_HEADER}${newline}\n`, 'utf8');
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.promises.writeFile(filePath, `${NOTES_HEADER}\n\n`, 'utf8');
    } else {
      throw error;
    }
  }
}

function broadcastNotesPathChanged(filePath) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('notes:path-changed', { filePath });
  }
}

function parseNotes(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const headerLines = [];
  const notes = {};

  let index = 0;
  while (index < lines.length && !lines[index].startsWith('## ')) {
    headerLines.push(lines[index]);
    index += 1;
  }

  let currentDate = null;
  let buffer = [];

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('## ')) {
      if (currentDate) {
        notes[currentDate] = buffer.join('\n').trim();
      }
      currentDate = line.slice(3).trim();
      buffer = [];
    } else {
      buffer.push(line);
    }
    index += 1;
  }

  if (currentDate) {
    notes[currentDate] = buffer.join('\n').trim();
  }

  const headerText = headerLines.join('\n').trim();
  return { header: headerText || NOTES_HEADER, notes };
}

function buildNotesDocument(header, notesMap) {
  const normalizedHeader = header && header.trim().length ? header.trim() : NOTES_HEADER;

  const entries = Object.entries(notesMap).sort(([a], [b]) => {
    const aTime = Date.parse(a);
    const bTime = Date.parse(b);
    if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) {
      return aTime - bTime;
    }
    return a.localeCompare(b);
  });

  const sections = entries
    .map(([dateKey, content]) => {
      const trimmed = (content || '').trim();
      if (!trimmed) {
        return null;
      }
      return `## ${dateKey}\n\n${trimmed}`;
    })
    .filter(Boolean);

  const body = sections.join('\n\n');
  if (body.length === 0) {
    return `${normalizedHeader}\n`;
  }
  return `${normalizedHeader}\n\n${body}\n`;
}

function normalizeBullets(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const formatted = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.startsWith('- ')) {
        return line;
      }
      return `- ${line.replace(/^-\s*/, '')}`;
    });
  return formatted.join('\n');
}

function broadcastNotesUpdated(dateKey) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('notes:updated', { dateKey });
  }
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.oyvai.app');
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

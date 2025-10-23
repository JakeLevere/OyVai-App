const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

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

  // Broadcast saved settings on load
  mainWindow.webContents.once('did-finish-load', () => {
    try {
      const settings = loadSettings();
      if (settings && settings.notesFilePath) {
        broadcastNotesPathChanged(settings.notesFilePath);
      }
    } catch (_) {}
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

    const choice = await dialog.showMessageBox(targetWindow, {
      type: 'question',
      buttons: ['Select existing file', 'Create new file', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Use an existing notes file or create a new one?',
      detail: 'Existing: pick a Markdown file you already have. New: create a fresh oyvai-daily-notes.md file.',
    });

    if (choice.response === 2) return { canceled: true };

    let selectedPath = null;
    if (choice.response === 0) {
      const { canceled, filePaths } = await dialog.showOpenDialog(targetWindow, {
        title: 'Select existing notes file',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [
          { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (canceled || !filePaths || filePaths.length === 0) return { canceled: true };
      selectedPath = filePaths[0];
    } else {
      const { canceled, filePath } = await dialog.showSaveDialog(targetWindow, {
        title: 'Create daily notes file',
        defaultPath,
        filters: [
          { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (canceled || !filePath) return { canceled: true };
      selectedPath = filePath;
    }

    const settings = loadSettings();
    settings.notesFilePath = selectedPath;
    await ensureNotesFile(selectedPath);
    saveSettings(settings);
    broadcastNotesPathChanged(selectedPath);
    return { canceled: false, filePath: selectedPath };
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
      const previous = notes[dateKey] || '';
      notes[dateKey] = mergeCategoryMarkers(previous, normalized);
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
    const raw = notes[dateKey] || '';
    const { text, codes } = stripCategoryMarkers(raw);
    return { content: text, categories: codes };
  });

  // States management (with delete for custom states)
  ipcMain.handle('states:get', async () => ({ states: loadAllStates() }));
  ipcMain.handle('states:add', async (_event, payload = {}) => {
    const { title, description, color, code } = payload || {};
    const settings = loadSettings();
    if (!settings.customStates) settings.customStates = [];
    const used = new Set(loadAllStates().map((s) => s.code));
    let newCode = String(code || '').trim().toLowerCase();
    if (!newCode) newCode = generateCodeFromTitle(title || 'Custom', used);
    if (used.has(newCode)) {
      let i = 2; let c = `${newCode}${i}`; while (used.has(c)) { i += 1; c = `${newCode}${i}`; } newCode = c;
    }
    const allowed = new Set(getAllowedColors());
    const chosen = allowed.has(String(color || 'slate').toLowerCase()) ? String(color || 'slate').toLowerCase() : 'slate';
    settings.customStates.push({ code: newCode, title: String(title || 'Custom'), description: String(description || ''), color: chosen });
    saveSettings(settings);
    broadcastStatesUpdated();
    return { success: true, state: { code: newCode, title: String(title || 'Custom'), description: String(description || ''), color: chosen } };
  });
  ipcMain.handle('states:update', async (_event, payload = {}) => {
    const { code, title, description, color } = payload || {};
    if (!code) return { success: false };
    const c = String(code).toLowerCase();
    const settings = loadSettings();
    if (!Array.isArray(settings.customStates)) settings.customStates = [];
    const allowed = new Set(getAllowedColors());
    const idx = settings.customStates.findIndex((s) => String(s.code).toLowerCase() === c);
    if (idx !== -1) {
      const next = { ...settings.customStates[idx] };
      if (typeof title === 'string') next.title = title;
      if (typeof description === 'string') next.description = description;
      if (typeof color === 'string' && allowed.has(color.toLowerCase())) next.color = color.toLowerCase();
      settings.customStates[idx] = next;
      saveSettings(settings);
      broadcastStatesUpdated();
      return { success: true };
    }
    if (!settings.stateOverrides) settings.stateOverrides = {};
    const next = { ...(settings.stateOverrides[c] || {}) };
    if (typeof title === 'string') next.title = title;
    if (typeof description === 'string') next.description = description;
    if (typeof color === 'string' && allowed.has(color.toLowerCase())) next.color = color.toLowerCase();
    settings.stateOverrides[c] = next;
    saveSettings(settings);
    broadcastStatesUpdated();
    return { success: true };
  });
  ipcMain.handle('states:delete', async (_event, payload = {}) => {
    const { code } = payload || {};
    if (!code) return { success: false };
    const c = String(code).toLowerCase();
    const settings = loadSettings();
    if (!Array.isArray(settings.customStates)) settings.customStates = [];
    const before = settings.customStates.length;
    settings.customStates = settings.customStates.filter(
      (s) => String(s.code).toLowerCase() !== c
    );
    const changed = settings.customStates.length !== before;
    if (changed) {
      saveSettings(settings);
      broadcastStatesUpdated();
    }
    return { success: changed };
  });

  // Analysis endpoints
  ipcMain.handle('notes:analyze-day', async (_event, { dateKey, force } = {}) => {
    if (!dateKey || typeof dateKey !== 'string') throw new Error('Invalid date key.');
    const settings = loadSettings();
    if (!settings.notesFilePath) return { success: false, reason: 'NO_PATH' };
    const apiKey = getOpenAIKey();
    if (!apiKey) return { success: false, reason: 'NO_OPENAI_KEY' };
    await ensureNotesFile(settings.notesFilePath);
    const markdown = await fs.promises.readFile(settings.notesFilePath, 'utf8');
    const { header, notes } = parseNotes(markdown);
    const dayContent = (notes[dateKey] || '').trim();
    if (!dayContent) return { success: false, reason: 'EMPTY' };
    if (!force && allLinesHaveMarkers(dayContent)) return { success: true, skipped: true };
    const { text, bullets } = extractBulletBase(dayContent);
    if (bullets.length === 0) return { success: false, reason: 'NO_BULLETS' };
    const codes = await classifyBulletsWithOpenAI(bullets, loadAllStates(), getOpenAIKey());
    if (!codes || codes.length !== bullets.length) return { success: false, reason: 'CLASSIFY_FAILED' };
    notes[dateKey] = applyMarkersToBullets(text, codes);
    const newDoc = buildNotesDocument(header, notes);
    await fs.promises.writeFile(settings.notesFilePath, newDoc, 'utf8');
    broadcastNotesUpdated(dateKey);
    return { success: true };
  });
  ipcMain.handle('notes:analyze-all', async (_event, { force } = {}) => {
    const settings = loadSettings();
    if (!settings.notesFilePath) return { success: false, reason: 'NO_PATH' };
    const apiKey = getOpenAIKey();
    if (!apiKey) return { success: false, reason: 'NO_OPENAI_KEY' };
    await ensureNotesFile(settings.notesFilePath);
    const markdown = await fs.promises.readFile(settings.notesFilePath, 'utf8');
    const { header, notes } = parseNotes(markdown);
    const keys = Object.keys(notes);
    let updated = 0;
    for (const k of keys) {
      const content = (notes[k] || '').trim();
      if (!content) continue;
      if (!force && allLinesHaveMarkers(content)) continue;
      const { text, bullets } = extractBulletBase(content);
      if (bullets.length === 0) continue;
      try {
        const codes = await classifyBulletsWithOpenAI(bullets, loadAllStates(), getOpenAIKey());
        if (codes && codes.length === bullets.length) { notes[k] = applyMarkersToBullets(text, codes); updated += 1; }
      } catch (_) {}
    }
    if (updated > 0) { const newDoc = buildNotesDocument(header, notes); await fs.promises.writeFile(settings.notesFilePath, newDoc, 'utf8'); broadcastNotesUpdated(null); }
    return { success: true, updated };
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

function broadcastStatesUpdated() {
  const payload = { states: loadAllStates() };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('states:updated', payload);
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

// ----- States and classification helpers -----
function getDefaultStates() {
  return [
    { code: 'm', title: 'Mental', description: 'Thoughts, mood, clarity, stress, focus.', color: 'emerald' },
    { code: 'p', title: 'Physical', description: 'Body, energy, movement, sleep, pain.', color: 'sky' },
    { code: 'f', title: 'Financial', description: 'Money, spending, budgeting, income, risk.', color: 'amber' },
    { code: 'c', title: 'Career', description: 'Work, progress, skills, deliverables, team.', color: 'purple' },
    { code: 'u', title: 'Purpose', description: 'Meaning, values, long-term vision, alignment.', color: 'rose' },
    { code: 'r', title: 'Record', description: 'Raw capture, logs, observations, references.', color: 'cyan' },
  ];
}
function getAllowedColors() {
  return ['emerald', 'sky', 'amber', 'purple', 'rose', 'cyan', 'slate'];
}
function generateCodeFromTitle(title, used = new Set()) {
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  let base = t.slice(0, 3) || 's';
  if (!used.has(base)) return base;
  let i = 2, c = base; while (used.has(c)) { c = `${base}${i++}`; }
  return c;
}
function loadAllStates() {
  const settings = loadSettings();
  const overrides = settings.stateOverrides || {};
  const custom = Array.isArray(settings.customStates) ? settings.customStates : [];
  const out = [];
  const used = new Set();
  for (const s of getDefaultStates()) {
    const code = String(s.code).toLowerCase();
    used.add(code);
    out.push({ ...s, ...(overrides[code] || {}), code });
  }
  for (const s of custom) {
    const base = String(s.code || '').trim().toLowerCase() || generateCodeFromTitle(s.title, used);
    let code = base; let i = 2; while (used.has(code)) { code = `${base}${i++}`; }
    used.add(code);
    out.push({ code, title: s.title || 'Custom', description: s.description || '', color: s.color || 'slate' });
  }
  return out;
}
function stripCategoryMarkers(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const codes = [];
  const cleaned = lines.map((line) => {
    const m = line.match(/^(.*?)(?:\s*\{([a-z0-9_-]{1,8})\})\s*$/i);
    if (m) { codes.push(m[2].toLowerCase()); return m[1].trimEnd(); }
    codes.push(null); return line;
  }).join('\n');
  return { text: cleaned, codes };
}
function extractBulletBase(text) {
  const { text: withoutMarkers } = stripCategoryMarkers(text);
  const lines = withoutMarkers.replace(/\r\n/g, '\n').split('\n');
  const bullets = [];
  const normalized = lines.map((l) => l.trim()).filter((l) => l.length > 0).map((l) => {
    const base = l.replace(/^-\s*/, '').trim(); bullets.push(base); return `- ${base}`;
  }).join('\n');
  return { text: normalized, bullets };
}
function allLinesHaveMarkers(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((l) => /\{[a-z0-9_-]{1,8}\}\s*$/i.test(l));
}
function applyMarkersToBullets(normalizedText, codes) {
  const lines = normalizedText.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const code = String(codes[i] || '').toLowerCase();
    out.push(code ? `${lines[i]} {${code}}` : lines[i]);
  }
  return out.join('\n');
}
function mergeCategoryMarkers(previous, nextNormalized) {
  const prev = stripCategoryMarkers(previous);
  const nextLines = nextNormalized.split('\n');
  const merged = [];
  for (let i = 0; i < nextLines.length; i += 1) {
    const base = nextLines[i].replace(/\{[a-z0-9_-]{1,8}\}\s*$/i, '').trimEnd();
    const code = prev.codes[i];
    merged.push(code ? `${base} {${code}}` : base);
  }
  return merged.join('\n');
}
function getOpenAIKey() {
  const settings = loadSettings();
  if (settings && typeof settings.openaiApiKey === 'string' && settings.openaiApiKey.trim()) return settings.openaiApiKey.trim();
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) return process.env.OPENAI_API_KEY.trim();
  return null;
}
async function classifyBulletsWithOpenAI(bullets, states, apiKey) {
  const payload = buildClassificationPrompt(bullets, states);
  const body = JSON.stringify(payload);
  const res = await fetchOpenAI('/v1/chat/completions', apiKey, body);
  if (!res) return null;
  try {
    const data = JSON.parse(res);
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;
    const parsed = JSON.parse(content);
    const labels = parsed.labels || parsed.codes || parsed.categories || [];
    return labels.map((c) => String(c).toLowerCase());
  } catch (_) { return null; }
}
function buildClassificationPrompt(bullets, states) {
  const compact = states.map((s) => ({ code: s.code, title: s.title, description: s.description })).slice(0, 20);
  const allowed = compact.map((s) => s.code);
  const system = 'You classify each input bullet into exactly one of the provided states. Use the short code for the best-fitting state. Respond ONLY with strict JSON.';
  const user = { bullets, states: compact, instructions: 'Return JSON {"labels":[code,...]} aligned to bullets. Only use provided state codes. No explanations.', allowed };
  return { model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages: [ { role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) } ] };
}
function fetchOpenAI(pathname, apiKey, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.openai.com', path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(data); else resolve(null); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
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

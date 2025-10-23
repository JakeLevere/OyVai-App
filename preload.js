const { contextBridge, ipcRenderer } = require('electron');

const notesPathListeners = new Set();
const notesUpdatedListeners = new Set();
const statesUpdatedListeners = new Set();

ipcRenderer.on('notes:path-changed', (_event, payload = {}) => {
  for (const listener of notesPathListeners) {
    try {
      listener(payload);
    } catch (error) {
      console.error('notes:path-changed listener error', error);
    }
  }

  try {
    if (typeof window !== 'undefined' && window.document) {
      window.document.dispatchEvent(
        new CustomEvent('oyvai-notes-path-changed', { detail: payload })
      );
    }
  } catch (error) {
    console.error('Failed to dispatch notes path change event', error);
  }
});

ipcRenderer.on('notes:updated', (_event, payload = {}) => {
  for (const listener of notesUpdatedListeners) {
    try {
      listener(payload);
    } catch (error) {
      console.error('notes:updated listener error', error);
    }
  }

  try {
    if (typeof window !== 'undefined' && window.document) {
      window.document.dispatchEvent(
        new CustomEvent('oyvai-note-saved', { detail: payload })
      );
    }
  } catch (error) {
    console.error('Failed to dispatch note saved event', error);
  }
});

ipcRenderer.on('states:updated', (_event, payload = {}) => {
  for (const listener of statesUpdatedListeners) {
    try { listener(payload); } catch (error) { console.error('states:updated listener error', error); }
  }
  try {
    if (typeof window !== 'undefined' && window.document) {
      window.document.dispatchEvent(new CustomEvent('oyvai-states-updated', { detail: payload }));
    }
  } catch (error) {
    console.error('Failed to dispatch states updated event', error);
  }
});

contextBridge.exposeInMainWorld('timelineAPI', {
  selectNotesFile: () => ipcRenderer.invoke('notes:select-file'),
  getNotesFilePath: () => ipcRenderer.invoke('notes:get-path'),
  saveDailyNote: (dateKey, content) =>
    ipcRenderer.invoke('notes:save', { dateKey, content }),
  loadDailyNote: (dateKey) => ipcRenderer.invoke('notes:load', dateKey),
  analyzeDay: (dateKey, force = false) => ipcRenderer.invoke('notes:analyze-day', { dateKey, force }),
  analyzeAllDays: (force = true) => ipcRenderer.invoke('notes:analyze-all', { force }),
  getStates: () => ipcRenderer.invoke('states:get').then(r => r?.states || []),
  addState: (state) => ipcRenderer.invoke('states:add', state),
  updateState: (state) => ipcRenderer.invoke('states:update', state),
  deleteState: (code) => ipcRenderer.invoke('states:delete', { code }),
  onNotesPathChanged: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    notesPathListeners.add(callback);
    return () => {
      notesPathListeners.delete(callback);
    };
  },
  onNotesUpdated: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    notesUpdatedListeners.add(callback);
    return () => {
      notesUpdatedListeners.delete(callback);
    };
  },
  onStatesUpdated: (callback) => {
    if (typeof callback !== 'function') { return () => {}; }
    statesUpdatedListeners.add(callback);
    return () => { statesUpdatedListeners.delete(callback); };
  },
});

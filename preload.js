const { contextBridge, ipcRenderer } = require('electron');

const notesPathListeners = new Set();
const notesUpdatedListeners = new Set();

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

contextBridge.exposeInMainWorld('timelineAPI', {
  selectNotesFile: () => ipcRenderer.invoke('notes:select-file'),
  getNotesFilePath: () => ipcRenderer.invoke('notes:get-path'),
  saveDailyNote: (dateKey, content) =>
    ipcRenderer.invoke('notes:save', { dateKey, content }),
  loadDailyNote: (dateKey) => ipcRenderer.invoke('notes:load', dateKey),
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
});

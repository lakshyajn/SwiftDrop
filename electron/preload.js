const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // App info
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getAppPath: () => ipcRenderer.invoke("get-app-path"),

  // Lifecycle
  onAppClosing: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("app-closing", handler);
    return () => ipcRenderer.removeListener("app-closing", handler);
  },

  // Dialogs
  showErrorDialog: (message, detail) =>
    ipcRenderer.invoke("show-error-dialog", message, detail),
  showSuccessDialog: (message, detail) =>
    ipcRenderer.invoke("show-success-dialog", message, detail),
});

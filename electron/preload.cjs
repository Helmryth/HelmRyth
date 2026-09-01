// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.helmryth), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const primitiveString = (value) =>
  Object(value) !== value && value?.constructor === String ? value : null;

let pendingPackageInstallUrl = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, url) => {
  const installUrl = primitiveString(url);
  if (installUrl === null) return;
  pendingPackageInstallUrl = installUrl;
  for (const listener of packageInstallListeners) listener(installUrl);
});

const reachBridge = Object.freeze({
  state: () => ipcRenderer.invoke("reach:state"),
  start: () => ipcRenderer.invoke("reach:start"),
  stop: () => ipcRenderer.invoke("reach:stop"),
  keepAwake: (enabled) => ipcRenderer.invoke("reach:keep-awake", enabled),
  pairing: (open, expectedToken) => ipcRenderer.invoke("reach:pairing", open, expectedToken),
  cloudDesktop: (deviceId, allowed) => ipcRenderer.invoke("reach:cloud-desktop", deviceId, allowed),
  revoke: (deviceId) => ipcRenderer.invoke("reach:revoke", deviceId),
});

const registryBridge = Object.freeze({
  state: () => ipcRenderer.invoke("registry:state"),
  requestCode: (email) => ipcRenderer.invoke("registry:request-code", email),
  verifyCode: (email, code) => ipcRenderer.invoke("registry:verify-code", email, code),
  retry: () => ipcRenderer.invoke("registry:retry"),
  signOut: () => ipcRenderer.invoke("registry:sign-out"),
});

contextBridge.exposeInMainWorld("helmryth", {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  /** Helmryth Reach is the opt-in service that connects this installation to
   * approved devices. Every call returns the complete secret-free state. */
  reach: reachBridge,
  /** Registry-backed identity and Reach provisioning. Credentials stay in
   * the main process; this surface exposes only narrow user actions. */
  registry: registryBridge,
  /** @deprecated Compatibility alias until the next versioned bridge. */
  companion: reachBridge,
  /** @deprecated Compatibility alias until the next versioned bridge. */
  companionAccount: registryBridge,
  localControl: {
    status: () => ipcRenderer.invoke("cua:linux-status"),
    enable: () => ipcRenderer.invoke("cua:linux-enable"),
    disable: () => ipcRenderer.invoke("cua:linux-disable"),
    retry: () => ipcRenderer.invoke("cua:linux-retry"),
  },
  /** Arms exactly one display-media request from the current renderer frame. */
  beginScreenPreviewIntent: () => ipcRenderer.sendSync("screen:preview-intent"),
  /** One frame of this computer's screen as a data: URL when supported. */
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  /** Physical USB Android devices. Network ADB is deliberately excluded. */
  androidDevice: {
    status: () => ipcRenderer.invoke("android-device:status"),
    frame: (serial) => ipcRenderer.invoke("android-device:frame", serial),
    input: (serial, payload) =>
      ipcRenderer.invoke("android-device:input", serial, payload).then(() => undefined),
  },
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  /** A local-first demonstration recorder. Global events stay in main; the
   * renderer receives only the privacy-filtered event stream. */
  skillRecorder: {
    permissions: () => ipcRenderer.invoke("skill-recorder:permissions"),
    start: () => ipcRenderer.invoke("skill-recorder:start"),
    stop: () => ipcRenderer.invoke("skill-recorder:stop"),
    save: (payload) => ipcRenderer.invoke("skill-recorder:save", payload),
    onEvent: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("skill-recorder:event", handler);
      return () => ipcRenderer.removeListener("skill-recorder:event", handler);
    },
    onEnd: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("skill-recorder:end", handler);
      return () => ipcRenderer.removeListener("skill-recorder:end", handler);
    },
  },
  transcription: {
    status: () => ipcRenderer.invoke("assemblyai:status"),
    setKey: (value) => ipcRenderer.invoke("assemblyai:set-key", value),
    streamingToken: () => ipcRenderer.invoke("assemblyai:streaming-token"),
  },
  /** Absolute path of a dropped File — Electron 32 removed File.path, and
   * only the preload can ask. "" when the drag carried no file on disk. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * No screen field — macOS 15+ caches that status per-process, so any
   * value here would lie for the whole session after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),

  /** Copies an engine install command and opens a blank terminal. Resolves
   * false if no terminal could be launched; the clipboard still has it. */
  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  /** Open a web link in the default browser. Unlike renderer window.open,
   * this remains reliable after an asynchronous API request. */
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  /** Confirms the active light-first Helmryth surface to the desktop shell. */
  applySkin: (skin) => ipcRenderer.invoke("desktop:skin", skin),
  /** A reviewed capability package opened through helmryth://install. */
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    if (pendingPackageInstallUrl) cb(pendingPackageInstallUrl);
    return () => packageInstallListeners.delete(cb);
  },
  /** Mirrors durable unread state into the native Dock/taskbar badge. */
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
  /** Live VNC/noVNC in a sandboxed window owned by the app window. */
  desktopViewer: {
    open: (url, title, contextId) => ipcRenderer.invoke("desktop-viewer:open", url, title, contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-viewer:close", contextId),
    currentState: () => ipcRenderer.invoke("desktop-viewer:state-now"),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-viewer:state", handler);
      return () => ipcRenderer.removeListener("desktop-viewer:state", handler);
    },
  },
  /** Two sandboxed Local VM viewers embedded in the owning app window. */
  desktopWorkspace: {
    open: (input) => ipcRenderer.invoke("desktop-workspace:open", input),
    layout: (items) => ipcRenderer.invoke("desktop-workspace:layout", items),
    setInteractive: (contextId) => ipcRenderer.invoke("desktop-workspace:set-interactive", contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-workspace:close", contextId),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-workspace:state", handler);
      return () => ipcRenderer.removeListener("desktop-workspace:state", handler);
    },
  },
  /** The built-in browser: a native page view per operator that the Browser tab
   * positions over its own rectangle. Operators drive it through tools; the
   * person drives it by clicking into the view. */
  browser: {
    available: () => ipcRenderer.invoke("browser:available"),
    state: (botId) => ipcRenderer.invoke("browser:state", botId),
    layout: (botId, bounds, profile, mode) => ipcRenderer.invoke("browser:layout", botId, bounds, profile, mode),
    navigate: (botId, url) => ipcRenderer.invoke("browser:navigate", botId, url),
    back: (botId) => ipcRenderer.invoke("browser:back", botId),
    forward: (botId) => ipcRenderer.invoke("browser:forward", botId),
    /** Wipe a named profile's logins, storage and cache after it is deleted. */
    forgetProfile: (profileId) => ipcRenderer.invoke("browser:forget-profile", profileId),
    close: (botId) => ipcRenderer.invoke("browser:close", botId),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("browser:state", handler);
      return () => ipcRenderer.removeListener("browser:state", handler);
    },
  },
  /** Native folder picker for an operator's working folder; null when cancelled. */
  pickFolder: (current) => ipcRenderer.invoke("desktop:pick-folder", current),
  /** Writes the redacted diagnostics report to a user-chosen file; resolves
   * the path, or null when the save dialog was cancelled. */
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
  /** Ask where to save an operator-created file (inside ~/.helmryth), copy it
   * there and reveal it. Returns the chosen path, or null if the user
   * cancelled the dialog. The chat bubble shows the
   * rejection text verbatim, so strip the "Error invoking remote method"
   * wrapper ipcRenderer adds around a main-process throw. */
  saveFile: (filePath) =>
    ipcRenderer.invoke("desktop:save-file", filePath).catch((error) => {
      const message = String(error?.message ?? error);
      throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    }),
  /** Store a provider credential with OS-backed encryption. */
  setCredential: (name, value) => ipcRenderer.invoke("credential:set", name, value),

  /** In-app auto-update. State object:
   *  { status: "idle"|"checking"|"available"|"downloading"|"downloaded"|"error",
   *    version?, percent?, message? }. onState fires immediately with the
   *    current state, then on every transition. Dormant in dev (no bridge). */
  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    onState: (cb) => {
      ipcRenderer
        .invoke("update:get-state")
        .then((s) => cb(s))
        .catch(() => {});
      const handler = (_event, s) => cb(s);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
});

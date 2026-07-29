'use strict';
/**
 * Owns the window, config, caption server and engine supervisor, and passes
 * messages between them.
 *
 * Colours and display names are resolved here rather than in the engine, which
 * only knows who said what. That way renaming or recolouring a speaker applies
 * to the next caption without disturbing the Discord connection.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');

const { ConfigStore } = require('./config');
const { CaptionServer } = require('./server');
const { EngineHost } = require('./engine-host');
const { colorForUser, assignColors, PALETTE } = require('../shared/colors');
const {
  tryResolveModelPath,
  listModels,
  modelsDir,
  vendorDir,
} = require('../shared/paths');
const { catalogWithStatus, installModel, removeModel } = require('../shared/models');
const { buildFilter, maskText } = require('../shared/wordfilter');
const { checkForUpdate, RELEASES_PAGE } = require('./updates');

let mainWindow = null;
let config = null;
let server = null;
let engine = null;

/**
 * Collision-free colour assignment for everyone currently in the call,
 * recomputed whenever the member list or the overrides change. Captions read
 * from this so the overlay always matches the swatches shown in the UI.
 */
let colorAssignment = new Map();

/** Colour for a caption; falls back to the hash if the speaker already left. */
function captionColor(userId) {
  return colorAssignment.get(userId) || colorForUser(userId, config.data.colors);
}

/**
 * The name to show on stream. Resolved here rather than in the engine so that
 * renaming someone applies to the very next caption without touching the
 * Discord connection or their recognizer.
 */
function captionName(userId, fallback) {
  const alias = config.data.aliases[userId];
  return (alias && alias.trim()) || fallback;
}

/**
 * Latest sign-in state and server/channel tree from the engine.
 *
 * Cached here because the launch sign-in can finish before the renderer has
 * loaded and subscribed, and a `webContents.send` with nobody listening is
 * simply lost. `getState` serves this on init, so the pickers populate whether
 * the events arrived early, late, or not at all.
 */
let discord = { auth: 'idle', botTag: null, message: '', guilds: [] };

/** Compiled slur matcher, rebuilt whenever the filter settings change. */
let wordFilter = buildFilter({ enabled: true, custom: [] });
let maskedTotal = 0;

function rebuildFilter() {
  wordFilter = buildFilter({
    enabled: config.data.filter.enabled,
    custom: config.data.filter.custom,
  });
}

/**
 * Pin the model and vendor directories into the environment before anything
 * reads them.
 *
 * In an installed build the app directory is read-only (Program Files), so
 * downloaded models must live in the user's data directory instead. Pinning
 * them as env vars means the engine child process resolves exactly the same
 * paths without needing Electron's `app` module, which it doesn't have.
 */
function resolveRuntimeDirs() {
  if (!process.env.CHATTERLAYER_MODELS_DIR) {
    process.env.CHATTERLAYER_MODELS_DIR = app.isPackaged
      ? path.join(app.getPath('userData'), 'models')
      : modelsDir();
  }
  if (!process.env.CHATTERLAYER_VENDOR_DIR) {
    process.env.CHATTERLAYER_VENDOR_DIR = vendorDir();
  }
  fs.mkdirSync(process.env.CHATTERLAYER_MODELS_DIR, { recursive: true });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    title: 'Chatterlayer',
    backgroundColor: '#191b1a', // matches --chassis so launch doesn't flash
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Current styling as the overlay expects it. */
function displaySettings() {
  return { overlay: config.data.overlay };
}

function wireEngine() {
  engine.on('message', (msg) => {
    switch (msg.type) {
      case 'caption': {
        // Everything that goes on stream is resolved here: colour, display
        // name, and slur masking. Filtering at this single point means
        // unmasked text never reaches the overlay or the monitor.
        const body = maskText(msg.text, wordFilter);
        // A slur can just as easily be in someone's Discord name.
        const name = maskText(captionName(msg.userId, msg.username), wordFilter);

        const caption = {
          userId: msg.userId,
          username: name.text,
          text: body.text,
          color: captionColor(msg.userId),
          isFinal: msg.isFinal,
          timestamp: msg.timestamp,
        };
        server.sendCaption(caption);
        send('chatterlayer:caption', caption);

        if (msg.isFinal && body.masked + name.masked > 0) {
          maskedTotal += body.masked + name.masked;
          send('chatterlayer:event', { type: 'filter', masked: maskedTotal });
        }
        return;
      }
      case 'captionCleared':
        server.broadcast({ type: 'captionCleared', userId: msg.userId });
        return;
      case 'members': {
        // Re-derive colours across the whole call so nobody shares one.
        colorAssignment = assignColors(
          msg.members.map((m) => m.id),
          config.data.colors
        );
        const members = msg.members.map((m) => ({
          ...m,
          /** What viewers will see; empty means "use the Discord name". */
          alias: config.data.aliases[m.id] || '',
          captionName: captionName(m.id, m.displayName),
          color: colorAssignment.get(m.id),
          customColor: Boolean(config.data.colors[m.id]),
        }));
        send('chatterlayer:members', members);
        return;
      }
      case 'auth': {
        const gone = msg.state === 'error' || msg.state === 'signed-out';
        discord = {
          auth: msg.state,
          message: msg.message || '',
          botTag: gone ? null : msg.botTag || discord.botTag,
          // Nothing to pick from once the session is gone.
          guilds: gone ? [] : discord.guilds,
        };
        send('chatterlayer:event', msg);
        return;
      }
      case 'guilds':
        discord = { ...discord, guilds: msg.guilds, botTag: msg.botTag || discord.botTag };
        send('chatterlayer:event', msg);
        return;
      default:
        send('chatterlayer:event', msg);
    }
  });
}

async function bootstrap() {
  config = new ConfigStore();
  rebuildFilter();
  server = new CaptionServer();
  engine = new EngineHost();

  server.updateSettings(displaySettings());
  wireEngine();

  try {
    const urls = await server.start(config.data.server);
    send('chatterlayer:event', {
      type: 'server',
      state: 'ready',
      urls,
      port: server.port,
    });
  } catch (err) {
    send('chatterlayer:event', { type: 'server', state: 'error', message: err.message });
  }

  // Sign in straight away so the server and channel pickers are populated
  // before the user goes looking for them. This only logs the bot in — no
  // speech model is loaded and no voice channel is joined until Connect.
  // Side effect worth knowing: the bot shows as online in Discord for as long
  // as Chatterlayer is open, not just while captioning.
  if (config.getToken()) engine.signIn(config.getToken());
}

// ------------------------------------------------------------------- IPC ---

ipcMain.handle('chatterlayer:getState', () => ({
  config: config.toClient(),
  palette: PALETTE,
  urls: server.urls(config.data.server.host),
  port: server.port,
  modelPath: tryResolveModelPath(config.data.modelPath),
  models: listModels(),
  running: engine.running,
  discord,
  version: app.getVersion(),
  releasesUrl: RELEASES_PAGE,
}));

/**
 * Ask GitHub whether a newer release exists. Notification only — nothing is
 * downloaded. `force` comes from the user switching the setting on and skips
 * the once-a-day throttle.
 */
ipcMain.handle('chatterlayer:checkUpdate', async (_e, { force = false } = {}) => {
  const result = await checkForUpdate({
    currentVersion: app.getVersion(),
    cache: config.data.updates,
    force,
  });
  // Remember what we saw so tomorrow's launch doesn't ask again, and so an
  // offline launch still shows the badge. A check that was refused ('off')
  // knows nothing, and must not erase what the last real one found.
  if (result.state !== 'off') {
    config.update({
      updates: {
        ...config.data.updates,
        lastCheck: result.lastCheck,
        latest: result.latest,
      },
    });
  }
  return result;
});

/**
 * Sign in, or refresh the channel list if already signed in on this token.
 * Backs the Refresh/Retry button and the "I just pasted a new token" case —
 * the engine works out which of those it is.
 */
ipcMain.handle('chatterlayer:signIn', (_e, token) => {
  if (token) config.setToken(token);
  const activeToken = config.getToken();
  if (!activeToken) throw new Error('Enter your Discord bot token first.');
  engine.signIn(activeToken);
  return true;
});

ipcMain.handle('chatterlayer:setToken', (_e, token) => {
  config.setToken(token);
  return config.toClient();
});

ipcMain.handle('chatterlayer:updateConfig', async (_e, patch) => {
  const before = JSON.stringify(config.data.server);
  config.update(patch);

  // Overlay styling is live-pushed to the connected browser source.
  if (patch.overlay !== undefined) {
    server.updateSettings(displaySettings());
  }

  if (patch.filter !== undefined) rebuildFilter();

  // Changing host/port needs the server rebound.
  if (JSON.stringify(config.data.server) !== before) {
    await server.stop();
    try {
      const urls = await server.start(config.data.server);
      send('chatterlayer:event', { type: 'server', state: 'ready', urls, port: server.port });
      server.updateSettings(displaySettings());
    } catch (err) {
      send('chatterlayer:event', { type: 'server', state: 'error', message: err.message });
    }
  }
  return config.toClient();
});

// ---- speech model management ---------------------------------------------

ipcMain.handle('chatterlayer:modelCatalog', () => ({
  catalog: catalogWithStatus(modelsDir()),
  installed: listModels(),
  modelsDir: modelsDir(),
}));

/** Tracks in-flight downloads so the same model can't be fetched twice. */
const downloading = new Set();

ipcMain.handle('chatterlayer:installModel', async (_e, key) => {
  if (downloading.has(key)) throw new Error('That model is already downloading.');
  downloading.add(key);
  try {
    const result = await installModel(key, modelsDir(), (p) =>
      send('chatterlayer:modelProgress', { key, ...p })
    );
    // If this is the first model, select it automatically so the user isn't
    // left with a downloaded model and nothing using it.
    if (!config.data.modelPath) config.update({ modelPath: result.path });
    send('chatterlayer:modelProgress', { key, phase: 'done' });
    return { ok: true, ...result };
  } catch (err) {
    send('chatterlayer:modelProgress', { key, phase: 'error', message: err.message });
    throw err;
  } finally {
    downloading.delete(key);
  }
});

ipcMain.handle('chatterlayer:removeModel', (_e, key) => {
  if (engine.running) throw new Error('Disconnect before removing a model.');
  const removed = removeModel(key, modelsDir());
  // Drop the selection if it pointed at what we just deleted.
  if (config.data.modelPath === removed) config.update({ modelPath: '' });
  return { ok: true };
});

ipcMain.handle('chatterlayer:setAlias', (_e, { userId, alias }) => {
  const aliases = { ...config.data.aliases };
  const trimmed = (alias || '').trim();
  if (trimmed) aliases[userId] = trimmed;
  else delete aliases[userId]; // empty reverts to their Discord name
  config.update({ aliases });
  engine.requestMembers();
  return config.toClient();
});

ipcMain.handle('chatterlayer:setColor', (_e, { userId, color }) => {
  const colors = { ...config.data.colors };
  if (color) colors[userId] = color;
  else delete colors[userId]; // falling back to the hashed default
  config.update({ colors });
  engine.requestMembers(); // refresh swatches in the UI
  return config.toClient();
});

ipcMain.handle('chatterlayer:start', async (_e, { token, channelId, guildId }) => {
  if (token) config.setToken(token);
  if (channelId !== undefined) config.update({ channelId });
  if (guildId !== undefined) config.update({ guildId });

  const activeToken = config.getToken();
  if (!activeToken) throw new Error('Enter your Discord bot token first.');
  if (!config.data.channelId) throw new Error('Pick a voice channel first.');

  await engine.start({
    token: activeToken,
    channelId: config.data.channelId,
    modelPath: config.data.modelPath || undefined,
  });
  // Restore the previous selection once the engine reports it has joined.
  engine.setSelected(config.data.selected || []);
  return true;
});

ipcMain.handle('chatterlayer:stop', async () => {
  await engine.stop();
  return true;
});

ipcMain.handle('chatterlayer:setSelected', (_e, userIds) => {
  config.update({ selected: userIds });
  engine.setSelected(userIds);
  return userIds;
});

ipcMain.handle('chatterlayer:clearCaptions', () => {
  server.clearCaptions();
  return true;
});

ipcMain.handle('chatterlayer:copy', (_e, text) => {
  clipboard.writeText(text || '');
  return true;
});

ipcMain.handle('chatterlayer:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('chatterlayer:revealConfig', () => shell.showItemInFolder(config.file));

// ----------------------------------------------------------- app lifecycle --

// A second instance would fight over the caption server port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    resolveRuntimeDirs();
    createWindow();
    await bootstrap();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (engine && engine.child) {
    event.preventDefault();
    await engine.shutdown();
    if (server) await server.stop();
    app.exit(0);
  }
});

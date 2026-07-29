'use strict';
/**
 * Reaches the main process only through the `window.chatterlayer` bridge; no
 * Node APIs here by design.
 *
 * Speaker-supplied text (names, caption text) is always set via textContent,
 * never innerHTML — Discord names are untrusted input.
 */

const $ = (id) => document.getElementById(id);

const el = {
  tally: $('tally'),
  statusText: $('status-text'),
  token: $('token'),
  toggleToken: $('toggle-token'),
  tokenHint: $('token-hint'),
  guild: $('guild'),
  refreshGuilds: $('refresh-guilds'),
  authNote: $('auth-note'),
  voiceChannel: $('voice-channel'),
  channelNote: $('channel-note'),
  manualChannel: $('manual-channel'),
  toggleManual: $('toggle-manual'),
  channel: $('channel'),
  start: $('start'),
  stop: $('stop'),
  modelPath: $('model-path'),
  model: $('model'),
  modelNote: $('model-note'),
  manageModels: $('manage-models'),
  modelList: $('model-list'),
  filterEnabled: $('filter-enabled'),
  filterCustom: $('filter-custom'),
  filterCount: $('filter-count'),
  members: $('members'),
  speakerCount: $('speaker-count'),
  urlOverlay: $('url-overlay'),
  fontSize: $('font-size'),
  lifetime: $('lifetime'),
  maxLines: $('max-lines'),
  showPartials: $('show-partials'),
  showNames: $('show-names'),
  port: $('port'),
  clear: $('clear'),
  reveal: $('reveal'),
  preview: $('preview'),
  stats: $('stats'),
  log: $('log'),
  clearLog: $('clear-log'),
  donate: $('donate'),
  vFont: $('v-font'),
  vLife: $('v-life'),
  vLines: $('v-lines'),
};

let state = {
  config: null,
  members: [],
  running: false,
  /** Sign-in state and the server/channel tree the pickers are built from. */
  discord: { auth: 'idle', botTag: null, message: '', guilds: [] },
};
/** userId -> the monitor line currently showing that speaker's partial text. */
const partials = new Map();
/** userId -> timer clearing the channel lamp blip. */
const blips = new Map();

// ------------------------------------------------------------- indicators --

/**
 * Drive the tally lamp.
 * @param {'standby'|'linking'|'onair'|'fault'} lampState
 */
function setTally(lampState, text) {
  el.tally.dataset.state = lampState;
  el.statusText.textContent = text;
}

function log(message, level = 'info') {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('span');
  if (level === 'error') line.className = 'err';
  else if (level === 'warn') line.className = 'warn';
  line.textContent = `[${time}] ${message}\n`;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

/** Pulse a speaker's indicator when their words come through. */
function blip(userId) {
  const row = el.members.querySelector(`[data-user="${CSS.escape(userId)}"]`);
  if (!row) return;
  row.classList.remove('speaking');
  // Force reflow so the animation restarts on rapid consecutive captions.
  void row.offsetWidth;
  row.classList.add('speaking');
  clearTimeout(blips.get(userId));
  blips.set(
    userId,
    setTimeout(() => row.classList.remove('speaking'), 600)
  );
}

/** Coalesce rapid slider input into one config write. */
function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const saveOverlay = debounce(async () => {
  state.config = await window.chatterlayer.updateConfig({
    overlay: {
      fontSize: Number(el.fontSize.value),
      captionLifetimeMs: Number(el.lifetime.value),
      maxLines: Number(el.maxLines.value),
      showPartials: el.showPartials.checked,
      showSpeakerName: el.showNames.checked,
    },
  });
});

const saveFilter = debounce(async () => {
  const custom = el.filterCustom.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  state.config = await window.chatterlayer.updateConfig({
    filter: { enabled: el.filterEnabled.checked, custom },
  });
}, 400);

const savePort = debounce(async () => {
  const port = Number(el.port.value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  log(`Moving caption server to port ${port}…`);
  state.config = await window.chatterlayer.updateConfig({
    server: { ...state.config.server, port },
  });
}, 700);

// ------------------------------------------------- server / channel pickers --

function renderAuth() {
  const d = state.discord;
  const set = (text, tone) => {
    el.authNote.textContent = text;
    if (tone) el.authNote.dataset.state = tone;
    else el.authNote.removeAttribute('data-state');
  };

  if (d.auth === 'signed-in') set(d.botTag ? `Signed in as ${d.botTag}` : 'Signed in', 'ok');
  else if (d.auth === 'signing-in') set('Signing in…', 'working');
  else if (d.auth === 'error') set(d.message || 'Sign-in failed — check your bot token.', 'fault');
  else if (state.config && state.config.hasToken) set('Not signed in — press Refresh.');
  else set('Paste your bot token, then press Refresh.');
}

function renderGuilds() {
  const guilds = state.discord.guilds || [];
  el.guild.replaceChildren();

  if (!guilds.length) {
    const opt = document.createElement('option');
    opt.textContent =
      state.discord.auth === 'signed-in' ? 'No servers with voice channels' : '—';
    el.guild.appendChild(opt);
    el.guild.disabled = true;
    renderChannels();
    return;
  }

  el.guild.disabled = false;
  for (const g of guilds) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    el.guild.appendChild(opt);
  }

  // Come back to where they left off. If the remembered server is gone, fall
  // back to whichever one holds the remembered channel before giving up.
  const saved = state.config.guildId;
  const holder = guilds.find((g) => g.channels.some((c) => c.id === state.config.channelId));
  el.guild.value = (guilds.some((g) => g.id === saved) ? saved : (holder || guilds[0]).id);
  renderChannels();
}

function renderChannels() {
  const guild = (state.discord.guilds || []).find((g) => g.id === el.guild.value);
  el.voiceChannel.replaceChildren();

  if (!guild) {
    const opt = document.createElement('option');
    opt.textContent = '—';
    el.voiceChannel.appendChild(opt);
    el.voiceChannel.disabled = true;
    updateChannelNote();
    return;
  }

  el.voiceChannel.disabled = false;
  for (const c of guild.channels) {
    const opt = document.createElement('option');
    opt.value = c.id;

    const tags = [];
    if (c.stage) tags.push('stage');
    if (c.canJoin === false) tags.push('no access');
    else if (c.full) tags.push('full');
    opt.textContent = tags.length ? `${c.name} — ${tags.join(', ')}` : c.name;

    // Listed but unselectable: hiding a channel the bot lacks permission for
    // turns a fixable permissions mistake into a channel that appears not to
    // exist, which is far harder to diagnose.
    opt.disabled = c.canJoin === false;
    if (c.reason) opt.title = c.reason;

    el.voiceChannel.appendChild(opt);
  }

  const saved = guild.channels.find((c) => c.id === state.config.channelId);
  const firstJoinable = guild.channels.find((c) => c.canJoin !== false);
  const pick = saved && saved.canJoin !== false ? saved : firstJoinable;
  el.voiceChannel.value = pick ? pick.id : '';
  updateChannelNote();
}

function currentChannel() {
  const guild = (state.discord.guilds || []).find((g) => g.id === el.guild.value);
  if (!guild) return null;
  return guild.channels.find((c) => c.id === el.voiceChannel.value) || null;
}

function updateChannelNote() {
  const c = currentChannel();

  if (!c) {
    el.channelNote.textContent =
      state.discord.auth === 'signed-in'
        ? 'No voice channel here that the bot can join.'
        : 'Sign in to list your servers and voice channels.';
    el.channelNote.removeAttribute('data-state');
    return;
  }

  const notes = [];
  // Joining a stage puts a bot in the audience, where it receives no audio at
  // all. Without this note that failure looks like Chatterlayer being broken.
  if (c.stage) {
    notes.push(
      'Stage channel — the bot joins as audience and hears nothing until you invite it to speak.'
    );
  }
  if (c.full) notes.push('This channel is at its user limit, so the bot may not fit.');
  if (c.canJoin === null) notes.push("Couldn't verify the bot's permissions here.");

  el.channelNote.textContent = notes.length
    ? notes.join(' ')
    : 'Chatterlayer will join this channel and list everyone in it.';
  if (notes.length) el.channelNote.dataset.state = 'working';
  else el.channelNote.removeAttribute('data-state');
}

/** Manual entry wins when it's open and filled, otherwise the picker. */
function effectiveChannelId() {
  if (!el.manualChannel.hidden) {
    const manual = el.channel.value.trim();
    if (manual) return manual;
  }
  return el.voiceChannel.value || '';
}

async function persistChannel() {
  const channelId = el.voiceChannel.value;
  if (!channelId) return;
  state.config = await window.chatterlayer.updateConfig({ channelId });
}

// ------------------------------------------------------- channel strips --

function renderMembers() {
  el.members.replaceChildren();

  if (!state.members.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.running
      ? 'Nobody else is in the voice channel yet.'
      : 'Connect to see who’s in the voice channel.';
    el.members.appendChild(li);
    el.speakerCount.textContent = '0 on';
    return;
  }

  const live = state.members.filter((m) => m.selected).length;
  el.speakerCount.textContent = `${live} on`;

  for (const m of state.members) {
    const li = document.createElement('li');
    li.className = `row${m.selected ? ' live' : ''}`;
    li.dataset.user = m.id;
    li.style.setProperty('--ch', m.color);

    // speaker indicator, lit in that speaker's caption colour
    const dot = document.createElement('span');
    dot.className = 'dot';

    // Identity. The name is editable in place and shows exactly what viewers
    // will see, so "ruptz_45454" can go on stream as "Ruptz". The immutable
    // Discord handle stays underneath so you can still tell who is who.
    const who = document.createElement('span');
    who.className = 'who';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'alias';
    name.value = m.captionName;
    name.placeholder = m.displayName;
    name.spellcheck = false;
    name.title = 'Name shown on captions — clear it to use their Discord name';
    name.setAttribute('aria-label', `Caption name for ${m.displayName}`);

    const commit = () => {
      const next = name.value.trim();
      if (next === (m.alias || '') || (!next && !m.alias)) return; // unchanged
      m.alias = next;
      window.chatterlayer.setAlias(m.id, next);
      log(next ? `${m.displayName} shows as “${next}”` : `${m.displayName} shows their Discord name`);
    };
    name.addEventListener('change', commit);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') {
        name.value = m.captionName;
        name.blur();
      }
    });

    const meta = document.createElement('small');
    meta.textContent = `@${m.username} · ${m.id}`;
    who.append(name, meta);

    li.append(dot, who);

    if (m.bot) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'bot';
      li.append(badge);
    }

    if (m.customColor) {
      const reset = document.createElement('button');
      reset.className = 'btn btn-ghost btn-sm';
      reset.textContent = 'Reset';
      reset.title = 'Return to the automatic colour';
      reset.addEventListener('click', () => window.chatterlayer.setColor(m.id, null));
      li.append(reset);
    }

    // caption colour picker
    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.value = m.color;
    swatch.title = `Caption colour for ${m.displayName}`;
    swatch.addEventListener('change', async () => {
      await window.chatterlayer.setColor(m.id, swatch.value);
    });
    li.append(swatch);

    // switch — input first so the CSS can drive track/knob via `~`
    const sw = document.createElement('label');
    sw.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = m.selected;
    cb.setAttribute('aria-label', `Caption ${m.displayName}`);
    cb.addEventListener('change', () => toggleMember(m.id, cb.checked));
    const track = document.createElement('span');
    track.className = 'track';
    const knob = document.createElement('span');
    knob.className = 'knob';
    sw.append(cb, track, knob);
    li.append(sw);

    el.members.appendChild(li);
  }
}

async function toggleMember(userId, on) {
  const ids = new Set(state.members.filter((m) => m.selected).map((m) => m.id));
  if (on) ids.add(userId);
  else ids.delete(userId);

  const member = state.members.find((m) => m.id === userId);
  if (member) member.selected = on;
  renderMembers();

  await window.chatterlayer.setSelected([...ids]);
  log(`${member ? member.displayName : userId} — captioning ${on ? 'on' : 'off'}`);
}

// -------------------------------------------------------------- monitor --

function buildLine(cap, isPartial) {
  const div = document.createElement('div');
  div.className = `line${isPartial ? ' partial' : ''}`;
  div.style.setProperty('--ch', cap.color);
  const who = document.createElement('b');
  who.textContent = cap.username;
  const text = document.createElement('span');
  text.textContent = cap.text;
  div.append(who, text);
  return div;
}

function addCaption(cap) {
  const empty = el.preview.querySelector('.empty');
  if (empty) empty.remove();

  blip(cap.userId);

  if (!cap.isFinal) {
    // A partial replaces that speaker's previous partial in place.
    const fresh = buildLine(cap, true);
    const existing = partials.get(cap.userId);
    if (existing && existing.isConnected) existing.replaceWith(fresh);
    else el.preview.appendChild(fresh);
    partials.set(cap.userId, fresh);
  } else {
    const existing = partials.get(cap.userId);
    if (existing && existing.isConnected) existing.remove();
    partials.delete(cap.userId);
    el.preview.appendChild(buildLine(cap, false));
  }

  while (el.preview.children.length > 40) el.preview.firstChild.remove();
  el.preview.scrollTop = el.preview.scrollHeight;
}

// --------------------------------------------------------------- events --

function handleEvent(msg) {
  switch (msg.type) {
    case 'status':
      if (msg.state === 'joined') {
        setTally('onair', 'On air');
        state.running = true;
        el.start.disabled = true;
        el.stop.disabled = false;
        log(`Joined ${msg.guildName} / #${msg.channelName}`);
      } else if (msg.state === 'error') {
        setTally('fault', 'Fault');
        state.running = false;
        el.start.disabled = false;
        el.stop.disabled = true;
        log(msg.message, 'error');
      } else if (msg.state === 'stopped' || msg.state === 'disconnected') {
        setTally('standby', 'Standby');
        state.running = false;
        state.members = [];
        renderMembers();
        el.start.disabled = false;
        el.stop.disabled = true;
        log(msg.message);
      } else {
        setTally('linking', 'Linking');
        log(msg.message);
      }
      return;

    case 'auth':
      state.discord = {
        ...state.discord,
        auth: msg.state,
        botTag: msg.botTag || state.discord.botTag,
        message: msg.message || '',
      };
      // No session, nothing to pick from.
      if (msg.state === 'error' || msg.state === 'signed-out') state.discord.guilds = [];
      renderAuth();
      renderGuilds();
      // A failed background sign-in is a nuisance, not a fault — the tally
      // lamp stays where it is and only the Source panel says so.
      if (msg.state === 'error') log(msg.message, 'warn');
      else if (msg.message) log(msg.message);
      return;

    case 'guilds':
      state.discord = {
        ...state.discord,
        guilds: msg.guilds,
        botTag: msg.botTag || state.discord.botTag,
      };
      renderAuth();
      renderGuilds();
      log(
        msg.guilds.length
          ? `${msg.guilds.length} server${msg.guilds.length === 1 ? '' : 's'} with voice channels.`
          : 'The bot is not in any server with a voice channel yet.'
      );
      return;

    case 'vosk':
      if (msg.state === 'loading') {
        setTally('linking', 'Loading model');
        // The large models take ~30s. Say so, or it reads as a freeze.
        log(
          `Loading ${msg.modelPath.split(/[\\/]/).pop()}… ` +
            `(large models can take 30s or more)`
        );
      } else if (msg.state === 'ready') {
        log(`Speech model ready in ${msg.loadMs} ms`);
        el.modelPath.textContent = msg.modelPath.split(/[\\/]/).pop();
      } else if (msg.state === 'error') {
        setTally('fault', 'Model fault');
        log(msg.message, 'error');
      }
      return;

    case 'server':
      if (msg.state === 'ready') {
        el.urlOverlay.textContent = msg.urls.overlay;
        el.port.value = msg.port;
        log(`Caption server on port ${msg.port}`);
      } else {
        log(msg.message, 'error');
      }
      return;

    case 'stats': {
      const bits = [];
      if (msg.speakers !== undefined) bits.push(`${msg.speakers} ch`);
      if (msg.rss) bits.push(`${(msg.rss / 1048576).toFixed(0)} MB`);
      if (bits.length) el.stats.textContent = bits.join(' · ');
      return;
    }

    case 'filter':
      el.filterCount.textContent = `${msg.masked} masked`;
      return;

    case 'log':
      if (msg.message) log(msg.message, msg.level);
      return;

    default:
      return;
  }
}

// ----------------------------------------------------------------- init --

/** Rough cost hints so the tradeoff is visible before you pick, not after. */
const MODEL_HINTS = {
  'vosk-model-en-us-0.42-gigaspeech':
    'Best accuracy. ~6.8 GB memory, ~30s to load. Good for a few speakers at once.',
  'vosk-model-en-us-0.22': 'High accuracy. ~5 GB memory, slow to load.',
  'vosk-model-en-us-0.22-lgraph': 'Balanced accuracy and speed. ~250 MB memory.',
  'vosk-model-small-en-us-0.15':
    'Lightest and fastest. ~150 MB memory. Comfortable with 7 speakers.',
};

function renderModels() {
  const models = state.models || [];
  el.model.replaceChildren();

  if (!models.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No model installed';
    el.model.appendChild(opt);
    el.model.disabled = true;
    el.modelNote.textContent =
      'Chatterlayer needs a speech model before it can caption. Choose one below.';
    // Nothing works without a model, so open the picker rather than making the
    // user hunt for it.
    el.modelList.hidden = false;
    el.manageModels.textContent = 'Hide';
    return;
  }

  el.model.disabled = false;
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.path;
    opt.textContent = m.label;
    el.model.appendChild(opt);
  }
  // An unset modelPath means "use the best installed", which is what the main
  // process already resolved into state.modelPath.
  el.model.value = state.config.modelPath || state.modelPath || models[0].path;
  updateModelNote();
}

/** Catalogue rows: download / installed / remove, with a progress bar. */
async function renderModelCatalog() {
  const { catalog } = await window.chatterlayer.modelCatalog();
  el.modelList.replaceChildren();

  for (const m of catalog) {
    const li = document.createElement('li');
    li.className = `model-row${m.installed ? ' installed' : ''}`;
    li.dataset.model = m.key;

    const info = document.createElement('div');
    info.className = 'model-info';

    const title = document.createElement('strong');
    title.textContent = m.label;
    if (m.recommended) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = 'Recommended';
      title.append(' ', pill);
    }

    const size = document.createElement('small');
    size.textContent = `${m.downloadMB >= 1000 ? (m.downloadMB / 1000).toFixed(1) + ' GB' : m.downloadMB + ' MB'} download · ~${
      m.ramMB >= 1000 ? (m.ramMB / 1000).toFixed(1) + ' GB' : m.ramMB + ' MB'
    } memory`;

    const blurb = document.createElement('p');
    blurb.textContent = m.blurb;

    info.append(title, size, blurb);

    const action = document.createElement('div');
    action.className = 'model-action';

    if (m.installed) {
      const tick = document.createElement('span');
      tick.className = 'installed-tag';
      tick.textContent = 'Installed';
      const remove = document.createElement('button');
      remove.className = 'btn btn-ghost btn-sm';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => removeModelRow(m));
      action.append(tick, remove);
    } else {
      const get = document.createElement('button');
      get.className = 'btn btn-sm';
      get.textContent = 'Download';
      get.addEventListener('click', () => downloadModelRow(m, get));
      action.append(get);
    }

    const bar = document.createElement('div');
    bar.className = 'model-bar';
    bar.appendChild(document.createElement('i'));

    li.append(info, action, bar);
    el.modelList.appendChild(li);
  }
}

async function downloadModelRow(model, button) {
  button.disabled = true;
  button.textContent = 'Starting…';
  log(`Downloading ${model.label} speech model (~${model.downloadMB} MB)…`);
  try {
    await window.chatterlayer.installModel(model.key);
    log(`${model.label} model installed.`);
    // Refresh both the picker and the catalogue.
    state = { ...state, ...(await window.chatterlayer.getState()) };
    renderModels();
    await renderModelCatalog();
  } catch (err) {
    log(`Download failed: ${err.message}`, 'error');
    button.disabled = false;
    button.textContent = 'Retry';
  }
}

async function removeModelRow(model) {
  try {
    await window.chatterlayer.removeModel(model.key);
    log(`${model.label} model removed.`);
    state = { ...state, ...(await window.chatterlayer.getState()) };
    renderModels();
    await renderModelCatalog();
  } catch (err) {
    log(err.message, 'error');
  }
}

/** Live progress for the row currently downloading. */
function onModelProgress(p) {
  const row = el.modelList.querySelector(`[data-model="${CSS.escape(p.key)}"]`);
  if (!row) return;
  const bar = row.querySelector('.model-bar i');
  const button = row.querySelector('.model-action button');

  if (p.phase === 'download' && p.total) {
    const pct = (p.received / p.total) * 100;
    bar.style.width = `${pct}%`;
    if (button) button.textContent = `${pct.toFixed(0)}%`;
  } else if (p.phase === 'extract') {
    bar.style.width = '100%';
    if (button) button.textContent = 'Unpacking…';
  } else if (p.phase === 'done' || p.phase === 'error') {
    bar.style.width = '0%';
  }
}

function updateModelNote() {
  const name = (el.model.value || '').split(/[\\/]/).pop();
  const hint = MODEL_HINTS[name] || 'Custom model.';
  el.modelNote.textContent = state.running
    ? `${hint} Reconnect to switch models.`
    : hint;
}

function syncFaderLabels() {
  el.vFont.textContent = el.fontSize.value;
  el.vLife.textContent = `${(Number(el.lifetime.value) / 1000).toFixed(1)}s`;
  el.vLines.textContent = el.maxLines.value;
}

async function init() {
  state = { ...state, ...(await window.chatterlayer.getState()) };
  const c = state.config;

  el.channel.value = c.channelId || '';
  renderAuth();
  renderGuilds();
  if (c.hasToken) {
    el.token.value = '••••••••••••••••••••••••';
    el.token.dataset.masked = '1';
  }
  el.tokenHint.textContent = c.tokenEncrypted
    ? 'Encrypted by your OS keystore.'
    : 'No OS keystore here — the token is stored in plain text. Keep the config file private.';

  el.fontSize.value = c.overlay.fontSize;
  el.lifetime.value = c.overlay.captionLifetimeMs;
  el.maxLines.value = c.overlay.maxLines;
  el.showPartials.checked = c.overlay.showPartials;
  el.showNames.checked = c.overlay.showSpeakerName;
  el.port.value = c.server.port;
  el.filterEnabled.checked = c.filter.enabled;
  el.filterCustom.value = (c.filter.custom || []).join('\n');
  syncFaderLabels();

  if (state.urls && state.urls.overlay) el.urlOverlay.textContent = state.urls.overlay;

  renderModels();
  renderModelCatalog();

  // Installed builds have no npm, so don't tell people to run it.
  el.modelPath.textContent = state.modelPath
    ? state.modelPath.split(/[\\/]/).pop()
    : 'No model installed';

  renderMembers();
  log('Chatterlayer ready.');
}

// ------------------------------------------------------------ listeners --

el.toggleToken.addEventListener('click', () => {
  const showing = el.token.type === 'text';
  el.token.type = showing ? 'password' : 'text';
  el.toggleToken.textContent = showing ? 'Show' : 'Hide';
});

// Clear the mask on first edit so the placeholder is never saved as a token.
el.token.addEventListener('focus', () => {
  if (el.token.dataset.masked) {
    el.token.value = '';
    delete el.token.dataset.masked;
  }
});

el.start.addEventListener('click', async () => {
  el.start.disabled = true;
  setTally('linking', 'Linking');
  try {
    await window.chatterlayer.start({
      token: el.token.dataset.masked ? undefined : el.token.value.trim() || undefined,
      // Undefined rather than empty: if the pickers haven't populated yet,
      // this must fall through to the remembered channel, not erase it.
      channelId: effectiveChannelId() || undefined,
      guildId: el.guild.value || undefined,
    });
  } catch (err) {
    setTally('fault', 'Fault');
    log(err.message, 'error');
    el.start.disabled = false;
  }
});

el.stop.addEventListener('click', async () => {
  el.stop.disabled = true;
  await window.chatterlayer.stop();
});

for (const input of [el.fontSize, el.lifetime, el.maxLines]) {
  input.addEventListener('input', () => {
    syncFaderLabels();
    saveOverlay();
  });
}
el.showPartials.addEventListener('change', saveOverlay);
el.showNames.addEventListener('change', saveOverlay);
el.port.addEventListener('input', savePort);
el.filterEnabled.addEventListener('change', () => {
  saveFilter();
  log(
    el.filterEnabled.checked
      ? 'Word filter on.'
      : 'Word filter OFF — captions go out unmasked.',
    el.filterEnabled.checked ? 'info' : 'warn'
  );
});
el.filterCustom.addEventListener('input', saveFilter);

el.refreshGuilds.addEventListener('click', async () => {
  try {
    await window.chatterlayer.signIn(
      el.token.dataset.masked ? undefined : el.token.value.trim() || undefined
    );
  } catch (err) {
    log(err.message, 'error');
  }
});

el.guild.addEventListener('change', async () => {
  state.config = await window.chatterlayer.updateConfig({ guildId: el.guild.value });
  renderChannels();
  await persistChannel();
});

el.voiceChannel.addEventListener('change', async () => {
  updateChannelNote();
  await persistChannel();
});

el.toggleManual.addEventListener('click', () => {
  const wasOpen = !el.manualChannel.hidden;
  el.manualChannel.hidden = wasOpen;
  el.toggleManual.textContent = wasOpen
    ? 'Enter a channel ID manually'
    : 'Use the pickers instead';
  if (wasOpen) persistChannel();
});

el.channel.addEventListener('change', () =>
  window.chatterlayer.updateConfig({ channelId: el.channel.value.trim() })
);

el.manageModels.addEventListener('click', () => {
  el.modelList.hidden = !el.modelList.hidden;
  el.manageModels.textContent = el.modelList.hidden ? 'Get models' : 'Hide';
});

el.model.addEventListener('change', async () => {
  state.config = await window.chatterlayer.updateConfig({ modelPath: el.model.value });
  updateModelNote();
  const name = el.model.value.split(/[\\/]/).pop();
  // The model is loaded once at connect time, so a live switch needs a restart.
  log(`Speech model set to ${name}${state.running ? ' — reconnect to apply' : ''}`);
});

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const text = $(btn.dataset.copy).textContent;
    if (!text || text === '—') return;
    await window.chatterlayer.copy(text);
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = original), 1200);
  });
}

el.clear.addEventListener('click', async () => {
  await window.chatterlayer.clearCaptions();
  el.preview.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'Cleared.';
  el.preview.appendChild(empty);
  partials.clear();
});

el.reveal.addEventListener('click', () => window.chatterlayer.revealConfig());
el.clearLog.addEventListener('click', () => el.log.replaceChildren());

el.donate.addEventListener('click', () =>
  window.chatterlayer.openExternal('https://ko-fi.com/ruptz')
);

window.chatterlayer.onModelProgress(onModelProgress);
window.chatterlayer.onEvent(handleEvent);
window.chatterlayer.onCaption(addCaption);
window.chatterlayer.onMembers((members) => {
  state.members = members;
  renderMembers();
});

init();

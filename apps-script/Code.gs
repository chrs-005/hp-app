/**
 * HP App — Troupe Griffons
 * Backend for Google Apps Script. All data lives in the Google Sheet this script
 * is attached to (one tab per table, created automatically on first use).
 *
 * The front end (Index.html) calls `api({ action, payload, token })`, either through
 * google.script.run (when served by this script) or through doPost (when the page
 * is hosted somewhere else).
 */

const DB_SCHEMA = {
  config: ['key', 'value'],
  members: ['id', 'name', 'patrol', 'birthYear', 'active', 'order', 'updatedAt', 'leader'],
  reporters: ['id', 'name', 'pinHash', 'role', 'patrols', 'createdAt'],
  meetings: ['date', 'cancelled', 'note', 'updatedAt'],
  // Camps and special events. Their attendance rows use the event id in place of a date.
  events: ['id', 'title', 'kind', 'date', 'endDate', 'order', 'createdAt'],
  // Phones that turned on reminders (web push subscriptions).
  push: ['endpoint', 'reporterId', 'createdAt', 'lastSent', 'lastStatus'],
  attendance: ['date', 'memberId', 'wedStatus', 'wedReason', 'wedBy', 'wedAt', 'satStatus', 'satReason', 'satBy', 'satAt'],
};

const DEFAULT_SETTINGS = {
  teamName: 'Troupe Griffons',
  seasonStart: '2026-09-01',
  streakAlert: 2,   // missed this many Saturdays in a row -> red alert
  minMeetings: 5,   // start judging percentages once this many Saturdays were held
  warnPct: 75,      // below this -> amber
  lowPct: 60,       // below this -> red
};

const STATUSES = {
  wed: ['coming', 'out', 'late', 'noreply'],
  sat: ['present', 'absent', 'late'],
};
const STATUSES_WITH_REASON = ['out', 'late', 'absent'];
const TOKEN_DAYS = 120;
const MAX_LOGIN_FAILS = 5;

// ---------------------------------------------------------------- entry points

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('HP App · Griffons')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents); } catch (err) { /* handled by api() */ }
  return ContentService.createTextOutput(JSON.stringify(api(req)))
    .setMimeType(ContentService.MimeType.JSON);
}

function api(req) {
  try {
    req = req || {};
    const action = ACTIONS[req.action];
    if (!action) throw new Error('Unknown action: ' + req.action);
    return { ok: true, data: action(req.payload || {}, req.token || '') };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

const ACTIONS = {
  bootstrap: bootstrap_,
  setup: setup_,
  login: login_,
  state: state_,
  saveAttendance: saveAttendance_,
  setMeeting: setMeeting_,
  saveReporter: saveReporter_,
  deleteReporter: deleteReporter_,
  saveSettings: saveSettings_,
  syncSource: syncSource_,
  createLeaderAccounts: createLeaderAccounts_,
  saveEvent: saveEvent_,
  deleteEvent: deleteEvent_,
  changePin: changePin_,
  savePush: savePush_,
  removePush: removePush_,
  testPush: testPush_,
};

// ---------------------------------------------------------------- actions

// No names here: the app link is public, so nobody can list the leaders without a PIN.
function bootstrap_() {
  return {
    needsSetup: readTable_('reporters').length === 0,
    teamName: settings_(getConfig_()).teamName,
    vapidKey: vapidPublicKey_(),
  };
}

/** First run only: creates the chief (admin) account and connects the members file. */
function setup_(p) {
  const name = cleanName_(p.name);
  const pin = cleanPin_(p.pin);
  const token = withLock_(() => {
    if (readTable_('reporters').length) throw new Error('The app is already set up.');
    const id = newId_('r');
    writeTable_('reporters', [{
      id: id, name: name, pinHash: hash_(id + ':' + pin), role: 'admin', patrols: '', createdAt: nowIso_(),
    }]);
    return makeToken_(id);
  });
  let importError = '';
  if (p.sourceUrl) {
    try { syncSource_({ url: p.sourceUrl, apply: true }, token); } catch (err) { importError = String(err.message || err); }
  }
  return { token: token, importError: importError };
}

/** payload: { name, pin }. The name is matched ignoring case, accents and extra spaces. */
function login_(p) {
  const key = memberId_(p.name || '');
  if (!key) throw new Error('Type your name.');
  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + key;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_LOGIN_FAILS) throw new Error('Too many wrong tries. Wait 10 minutes and try again.');

  const r = readTable_('reporters').find(x => memberId_(x.name) === key);
  const pin = String(p.pin || '').trim();
  let ok = false;
  if (!r) {
    ok = false;
  } else if (r.pinHash.indexOf('plain:') === 0) {
    // Emergency reset: the chief typed "plain:1234" in the reporters sheet.
    ok = pin === r.pinHash.slice(6);
    if (ok) withLock_(() => updateRow_('reporters', r._row, { pinHash: hash_(r.id + ':' + pin) }));
  } else {
    ok = r.pinHash === hash_(r.id + ':' + pin);
  }
  if (!ok) {
    cache.put(failKey, String(fails + 1), 600);
    throw new Error('Wrong name or PIN.');
  }
  cache.remove(failKey);
  return { token: makeToken_(r.id) };
}

/** payload.sync = true forces a check of the members file in Drive (the ↻ button). */
function state_(p, token) {
  const me = auth_(token);
  const membersSync = autoSync_(p.sync === true);
  const cfg = getConfig_();
  const isAdmin = me.role === 'admin';
  const members = readTable_('members').map(m => ({
    id: m.id, name: m.name, patrol: m.patrol, birthYear: m.birthYear,
    active: m.active !== '0', order: Number(m.order) || 0, leader: m.leader || '',
  }));

  let attendance = readTable_('attendance').map(stripRow_);
  const scope = scopeOf_(me);
  if (scope) {
    const ids = {};
    members.forEach(m => { if (scope[m.patrol]) ids[m.id] = true; });
    attendance = attendance.filter(a => ids[a.memberId]);
  }

  let patrols = [];
  try { patrols = JSON.parse(cfg.patrols || '[]'); } catch (err) { patrols = []; }
  members.forEach(m => { if (m.patrol && patrols.indexOf(m.patrol) < 0) patrols.push(m.patrol); });

  return {
    me: me,
    settings: settings_(cfg),
    patrols: patrols,
    members: members,
    attendance: attendance,
    meetings: readTable_('meetings').map(m => ({ date: m.date, cancelled: m.cancelled === '1', note: m.note })),
    events: events_(),
    reporters: isAdmin ? readTable_('reporters').map(publicReporter_) : [],
    source: isAdmin ? {
      url: cfg.sourceUrl || '',
      sheetName: cfg.sourceSheet || '',
      fileName: cfg.sourceFileName || '',
      lastImport: cfg.lastImport || '',
      lastImportBy: cfg.lastImportBy || '',
      fileUpdated: cfg.sourceFileUpdated || '',
      syncError: cfg.syncError || '',
    } : null,
    membersSync: membersSync,
    reminders: isAdmin ? remindersOn_() : null,
    serverTime: nowIso_(),
  };
}

/**
 * Keeps the members list in sync with the Drive file: if the file was modified since
 * the last import, it is imported again. Checked at most every 5 minutes (or now when
 * forced). Returns the changes when an import happened, else null.
 */
function autoSync_(force) {
  const cache = CacheService.getScriptCache();
  if (!force && cache.get('srcChecked')) return null;
  cache.put('srcChecked', '1', 300);
  const cfg = getConfig_();
  const fileId = fileIdFromUrl_(cfg.sourceUrl || '');
  if (!fileId) return null;
  try {
    const updated = DriveApp.getFileById(fileId).getLastUpdated().toISOString();
    if (updated === cfg.sourceFileUpdated) {
      if (cfg.syncError) setConfig_({ syncError: '' });
      return null;
    }
    const src = readSourceWorkbook_(fileId, cfg.sourceSheet || '');
    const roster = parseRoster_(src.grid, src.colors);
    if (!roster.members.length) throw new Error('No names found in the tab "' + src.sheetName + '".');
    const diff = diffRoster_(readTable_('members').map(stripRow_), roster.members);
    applyRoster_(cfg.sourceUrl, fileId, src, roster, 'Auto-sync');
    return { added: diff.added, removed: diff.removed, moved: diff.moved, total: diff.total };
  } catch (err) {
    setConfig_({ syncError: String((err && err.message) || err) });
    return null;
  }
}

/**
 * payload.entries: [{ date:'YYYY-MM-DD', memberId, phase:'wed'|'sat', status, reason }]
 * status '' clears the answer.
 */
function saveAttendance_(p, token) {
  const me = auth_(token);
  const entries = Array.isArray(p.entries) ? p.entries : [];
  if (!entries.length) return { rows: [] };
  if (entries.length > 500) throw new Error('Too many changes at once.');

  const members = {};
  readTable_('members').forEach(m => { members[m.id] = m; });
  const cancelled = {};
  readTable_('meetings').forEach(m => { if (m.cancelled === '1') cancelled[m.date] = true; });
  const eventIds = {};
  events_().forEach(ev => { eventIds[ev.id] = true; });
  const scope = scopeOf_(me);

  entries.forEach(e => {
    // e.date is a réunion date (YYYY-MM-DD) or a camp / event id.
    if (!isIsoDate_(e.date) && !eventIds[e.date]) throw new Error('This event does not exist anymore. Refresh the app.');
    const m = members[e.memberId];
    if (!m) throw new Error('Unknown scout. Refresh the app.');
    if (scope && !scope[m.patrol]) throw new Error('You are not in charge of ' + m.name + '.');
    if (!STATUSES[e.phase]) throw new Error('Bad phase.');
    if (e.status && STATUSES[e.phase].indexOf(e.status) < 0) throw new Error('Bad status.');
    if (cancelled[e.date] && me.role !== 'admin') throw new Error('There is no réunion on ' + e.date + '.');
  });

  return withLock_(() => {
    const rows = readTable_('attendance').map(stripRow_);
    const index = {};
    rows.forEach((r, i) => { index[r.date + '|' + r.memberId] = i; });
    const now = nowIso_();
    const touched = {};
    entries.forEach(e => {
      const key = e.date + '|' + e.memberId;
      if (index[key] === undefined) {
        const blank = {};
        DB_SCHEMA.attendance.forEach(k => { blank[k] = ''; });
        blank.date = e.date;
        blank.memberId = e.memberId;
        rows.push(blank);
        index[key] = rows.length - 1;
      }
      const r = rows[index[key]];
      const status = e.status || '';
      r[e.phase + 'Status'] = status;
      r[e.phase + 'Reason'] = STATUSES_WITH_REASON.indexOf(status) >= 0 ? String(e.reason || '').trim().slice(0, 200) : '';
      r[e.phase + 'By'] = status ? me.name : '';
      r[e.phase + 'At'] = status ? now : '';
      touched[key] = r;
    });
    writeTable_('attendance', rows);
    return { rows: Object.keys(touched).map(k => touched[k]) };
  });
}

const DEFAULT_EVENTS = [
  { id: 'ev_camp-patrouille', title: 'Camp Patrouille' },
  { id: 'ev_camp-noel', title: 'Camp Noël' },
  { id: 'ev_camp-paques', title: 'Camp Pâques' },
  { id: 'ev_camp-ete', title: 'Camp d\'Été' },
];

/** Camps (created once, editable) and special events, in display order. */
function events_() {
  let rows = readTable_('events').map(stripRow_);
  if (getConfig_().eventsSeeded !== '1') {
    withLock_(() => {
      rows = readTable_('events').map(stripRow_);
      const have = {};
      rows.forEach(r => { have[r.id] = true; });
      DEFAULT_EVENTS.forEach((d, i) => {
        if (!have[d.id]) rows.push({ id: d.id, title: d.title, kind: 'camp', date: '', endDate: '', order: String(i), createdAt: nowIso_() });
      });
      writeTable_('events', rows);
      setConfig_({ eventsSeeded: '1' });
    });
  }
  return rows
    .map(r => ({ id: r.id, title: r.title, kind: r.kind || 'special', date: r.date, endDate: r.endDate, order: Number(r.order) || 0 }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'camp' ? -1 : 1) ||
      (a.kind === 'camp' ? a.order - b.order : (a.date || '9999').localeCompare(b.date || '9999') || a.order - b.order));
}

/** payload: { id?, title, date?, endDate? }. New events are "special" events. */
function saveEvent_(p, token) {
  requireAdmin_(token);
  const title = String(p.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!title) throw new Error('Give the event a name.');
  ['date', 'endDate'].forEach(k => { if (p[k] && !isIsoDate_(p[k])) throw new Error('Bad date.'); });
  if (p.date && p.endDate && p.endDate < p.date) throw new Error('The end date is before the start date.');
  return withLock_(() => {
    const rows = readTable_('events').map(stripRow_);
    let r = p.id ? rows.find(x => x.id === p.id) : null;
    if (p.id && !r) throw new Error('Event not found.');
    if (!r) {
      r = { id: newId_('ev_'), kind: 'special', order: String(rows.length), createdAt: nowIso_() };
      rows.push(r);
    }
    r.title = title;
    r.date = p.date || '';
    r.endDate = p.endDate || '';
    writeTable_('events', rows);
    return { events: events_(), id: r.id };
  });
}

/** Deletes a camp or event and everything filled for it. */
function deleteEvent_(p, token) {
  requireAdmin_(token);
  return withLock_(() => {
    const rows = readTable_('events').map(stripRow_);
    if (!rows.some(r => r.id === p.id)) throw new Error('Event not found.');
    writeTable_('events', rows.filter(r => r.id !== p.id));
    writeTable_('attendance', readTable_('attendance').map(stripRow_).filter(a => a.date !== p.id));
    return { events: events_() };
  });
}

function setMeeting_(p, token) {
  requireAdmin_(token);
  if (!isIsoDate_(p.date)) throw new Error('Bad date.');
  return withLock_(() => {
    const rows = readTable_('meetings').map(stripRow_);
    let r = rows.find(x => x.date === p.date);
    if (!r) { r = { date: p.date }; rows.push(r); }
    r.cancelled = p.cancelled ? '1' : '0';
    r.note = String(p.note || '').slice(0, 200);
    r.updatedAt = nowIso_();
    writeTable_('meetings', rows);
    return { meetings: rows.map(m => ({ date: m.date, cancelled: m.cancelled === '1', note: m.note })) };
  });
}

function saveReporter_(p, token) {
  requireAdmin_(token);
  const name = cleanName_(p.name);
  const role = ['admin', 'cp', 'sp'].indexOf(p.role) >= 0 ? p.role : 'cp';   // Chief, CP (green name) or SP (red name)
  const patrols = (Array.isArray(p.patrols) ? p.patrols : []).map(String).filter(Boolean);
  return withLock_(() => {
    const rows = readTable_('reporters').map(stripRow_);
    if (rows.some(r => r.id !== p.id && r.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('Someone called "' + name + '" already exists.');
    }
    let r = p.id ? rows.find(x => x.id === p.id) : null;
    if (p.id && !r) throw new Error('Reporter not found.');
    if (!r) {
      if (!p.pin) throw new Error('Choose a PIN for the new account.');
      r = { id: newId_('r'), createdAt: nowIso_() };
      rows.push(r);
    }
    if (r.role === 'admin' && role !== 'admin' && rows.filter(x => x.role === 'admin').length < 2) {
      throw new Error('You need at least one chief (admin).');
    }
    r.name = name;
    r.role = role;
    r.patrols = patrols.join(',');
    if (p.pin) r.pinHash = hash_(r.id + ':' + cleanPin_(p.pin));
    writeTable_('reporters', rows);
    return { reporters: rows.map(publicReporter_) };
  });
}

function deleteReporter_(p, token) {
  const me = requireAdmin_(token);
  if (p.id === me.id) throw new Error('You cannot delete yourself.');
  return withLock_(() => {
    const rows = readTable_('reporters').map(stripRow_).filter(r => r.id !== p.id);
    writeTable_('reporters', rows);
    return { reporters: rows.map(publicReporter_) };
  });
}

function saveSettings_(p, token) {
  requireAdmin_(token);
  const s = {};
  if (p.teamName !== undefined) s.teamName = String(p.teamName).trim().slice(0, 60) || DEFAULT_SETTINGS.teamName;
  if (p.seasonStart !== undefined) {
    if (!isIsoDate_(p.seasonStart)) throw new Error('Season start must be a date.');
    s.seasonStart = p.seasonStart;
  }
  const ranges = { streakAlert: [1, 20], minMeetings: [1, 52], warnPct: [1, 100], lowPct: [0, 100] };
  Object.keys(ranges).forEach(k => {
    if (p[k] === undefined) return;
    const n = Math.round(Number(p[k]));
    if (!(n >= ranges[k][0] && n <= ranges[k][1])) throw new Error('Bad value for ' + k + '.');
    s[k] = n;
  });
  const merged = Object.assign(settings_(getConfig_()), s);
  if (merged.lowPct > merged.warnPct) throw new Error('The red % must be lower than the amber %.');
  setConfig_(Object.keys(s).reduce((o, k) => { o[k] = String(s[k]); return o; }, {}));
  return { settings: settings_(getConfig_()) };
}

/**
 * Reads the members list from a Google Drive spreadsheet (Google Sheet or .xlsx).
 * payload: { url, sheetName, apply }. Without apply it only previews the changes.
 */
function syncSource_(p, token) {
  const me = requireAdmin_(token);
  const cfg = getConfig_();
  const url = String(p.url || cfg.sourceUrl || '').trim();
  const fileId = fileIdFromUrl_(url);
  if (!fileId) throw new Error('Paste the Google Drive / Google Sheets link of the members file.');

  const src = readSourceWorkbook_(fileId, p.sheetName || (url === cfg.sourceUrl ? cfg.sourceSheet : ''));
  const roster = parseRoster_(src.grid, src.colors);
  if (!roster.members.length) throw new Error('No names found in the tab "' + src.sheetName + '".');

  const existing = readTable_('members').map(stripRow_);
  const diff = diffRoster_(existing, roster.members);
  const result = {
    fileName: src.fileName, sheetNames: src.sheetNames, sheetName: src.sheetName,
    patrols: roster.patrols, members: roster.members, diff: diff, applied: false,
  };
  if (!p.apply) return result;

  applyRoster_(url, fileId, src, roster, me.name);
  result.applied = true;
  return result;
}

function applyRoster_(url, fileId, src, roster, byName) {
  withLock_(() => {
    const now = nowIso_();
    const existing = readTable_('members').map(stripRow_);
    const seen = {};
    const out = roster.members.map((m, i) => {
      seen[m.id] = true;
      return { id: m.id, name: m.name, patrol: m.patrol, birthYear: m.birthYear, active: '1', order: String(i), updatedAt: now, leader: m.leader };
    });
    // Scouts no longer on the list are kept (their history stays) but marked inactive.
    existing.forEach(m => {
      if (seen[m.id]) return;
      out.push(Object.assign({}, m, { active: '0', leader: '', updatedAt: m.active === '0' ? m.updatedAt : now }));
    });
    writeTable_('members', out);
    setConfig_({
      sourceUrl: url, sourceSheet: src.sheetName, sourceFileName: src.fileName, sourceFileUpdated: src.updated,
      patrols: JSON.stringify(roster.patrols), lastImport: now, lastImportBy: byName, syncError: '',
    });
  });
  CacheService.getScriptCache().put('srcChecked', '1', 300);
  moveDatabaseNextTo_(fileId);
}

/**
 * Only once, right after the database sheet was created: put it in the same Drive folder
 * as the members file. Never again, so the chief can move both files wherever he wants.
 */
function moveDatabaseNextTo_(fileId) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('DB_AUTO') !== '1') return;
  props.deleteProperty('DB_AUTO');
  try {
    const parents = DriveApp.getFileById(fileId).getParents();
    if (parents.hasNext()) DriveApp.getFileById(props.getProperty('DB_ID')).moveTo(parents.next());
  } catch (err) { /* keep it where it is */ }
}

/**
 * Creates a reporter account for every patrol leader found in the members file
 * (names written in color) who does not have one yet. Each gets a random 4-digit
 * PIN, returned only this once so the chief can send it.
 */
function createLeaderAccounts_(p, token) {
  requireAdmin_(token);
  const leaders = readTable_('members').filter(m => m.active !== '0' && m.leader);
  if (!leaders.length) throw new Error('No CP or SP found. Write their names in green (CP) or red (SP) in the members file.');
  return withLock_(() => {
    const rows = readTable_('reporters').map(stripRow_);
    const taken = {};
    rows.forEach(r => { taken[memberId_(r.name)] = true; });
    const created = [];
    const existing = [];
    leaders.forEach(m => {
      if (taken[memberId_(m.name)]) { existing.push({ name: m.name, patrol: m.patrol }); return; }
      const pin = randomPin_();
      const r = { id: newId_('r'), name: m.name, role: m.leader === 'red' ? 'sp' : 'cp', patrols: m.patrol, createdAt: nowIso_() };
      r.pinHash = hash_(r.id + ':' + pin);
      rows.push(r);
      taken[memberId_(m.name)] = true;
      created.push({ name: m.name, patrol: m.patrol, leader: m.leader, pin: pin });
    });
    writeTable_('reporters', rows);
    return { created: created, existing: existing, reporters: rows.map(publicReporter_) };
  });
}

function randomPin_() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + secret_());
  let pin = '';
  for (let i = 0; pin.length < 4; i++) pin += String((bytes[i] + 256) % 10);
  return pin;
}

// ---------------------------------------------------------------- members file

function fileIdFromUrl_(url) {
  const m = /\/d\/([\w-]{20,})/.exec(url) || /[?&]id=([\w-]{20,})/.exec(url) || /^([\w-]{20,})$/.exec(url);
  return m ? m[1] : '';
}

function readSourceWorkbook_(fileId, sheetName) {
  let file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (err) {
    throw new Error('Cannot open that file. Make sure it is shared with the Google account that runs this app.');
  }
  let ss;
  let tempId = '';
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    ss = SpreadsheetApp.openById(fileId);
  } else {
    // .xlsx stored in Drive: make a temporary Google Sheets copy to read it.
    const copy = Drive.Files.copy(
      { name: '[HP App] temporary import', mimeType: MimeType.GOOGLE_SHEETS },
      fileId, { supportsAllDrives: true });
    tempId = copy.id;
    ss = SpreadsheetApp.openById(tempId);
  }
  try {
    const visible = ss.getSheets().filter(s => !s.isSheetHidden());
    const sheet = (sheetName && ss.getSheetByName(sheetName)) || visible[0] || ss.getSheets()[0];
    const range = sheet.getDataRange();
    return {
      fileName: file.getName().trim(),
      sheetNames: visible.map(s => s.getName()),
      sheetName: sheet.getName(),
      grid: range.getDisplayValues(),
      colors: fontColors_(ss, range),
      updated: file.getLastUpdated().toISOString(),
    };
  } finally {
    if (tempId) DriveApp.getFileById(tempId).setTrashed(true);
  }
}

/** Font color of every cell as "#rrggbb" ('' when unknown). Theme colors are resolved. */
function fontColors_(ss, range) {
  try {
    let theme = null;
    return range.getFontColorObjects().map(row => row.map(c => {
      try {
        if (!c) return '';
        const type = String(c.getColorType());
        if (type === 'RGB') return c.asRgbColor().asHexString();
        if (type === 'THEME') {
          theme = theme || ss.getSpreadsheetTheme();
          return theme.getConcreteColor(c.asThemeColor().getThemeColorType()).asRgbColor().asHexString();
        }
      } catch (err) { /* unsupported color */ }
      return '';
    }));
  } catch (err) {
    try { return range.getFontColors(); } catch (err2) { return []; }
  }
}

/** 'green', 'red', 'color' (any other visible color) or '' for black / gray text. */
function leaderColor_(hex) {
  const m = /([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  if (Math.max(r, g, b) - Math.min(r, g, b) < 60) return '';
  if (g > r && g >= b) return 'green';
  if (r > g && r >= b) return 'red';
  return 'color';
}

/**
 * Understands the layout of the "Membres" sheet:
 *   - one header row with the patrol names (Panda, Leopard, …) side by side,
 *   - the scouts' names below each patrol,
 *   - birth years in a column on the left,
 *   - stops at the "Total" row,
 *   - names written in color (green / red) are the patrol leaders.
 */
function parseRoster_(grid, colors) {
  colors = colors || [];
  const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const isNumber = v => /^-?\d+([.,]\d+)?$/.test(v);
  let header = -1;
  let cols = [];
  for (let r = 0; r < grid.length && header < 0; r++) {
    const textCols = [];
    grid[r].forEach((v, c) => { v = clean(v); if (v && !isNumber(v)) textCols.push(c); });
    if (textCols.length >= 3) { header = r; cols = textCols; }
  }
  if (header < 0) throw new Error('Could not find the row with the patrol names.');

  const patrols = cols.map(c => clean(grid[header][c]));
  const firstCol = Math.min.apply(null, cols);
  const members = [];
  const seen = {};
  let year = '';
  for (let r = header + 1; r < grid.length; r++) {
    const row = grid[r].map(clean);
    if (row.some(v => /^(total|troupe)$/i.test(v))) break;
    for (let c = 0; c < firstCol; c++) {
      if (/^(19|20)\d\d([.,]0+)?$/.test(row[c] || '')) year = String(parseInt(row[c], 10));
    }
    cols.forEach((c, k) => {
      const name = row[c];
      if (!name || isNumber(name)) return;
      const id = memberId_(name);
      if (!id || seen[id]) return;
      seen[id] = true;
      members.push({ id: id, name: name, patrol: patrols[k], birthYear: year, leader: leaderColor_((colors[r] || [])[c]) });
    });
  }
  return { patrols: patrols, members: members };
}

function memberId_(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function diffRoster_(existing, incoming) {
  const before = {};
  existing.forEach(m => { before[m.id] = m; });
  const now = {};
  incoming.forEach(m => { now[m.id] = m; });
  return {
    added: incoming.filter(m => !before[m.id] || before[m.id].active === '0').map(m => m.name),
    removed: existing.filter(m => m.active !== '0' && !now[m.id]).map(m => m.name),
    moved: incoming.filter(m => before[m.id] && before[m.id].active !== '0' && before[m.id].patrol !== m.patrol)
      .map(m => m.name + ': ' + before[m.id].patrol + ' → ' + m.patrol),
    leaders: incoming.filter(m => m.leader).map(m => ({ name: m.name, patrol: m.patrol, leader: m.leader })),
    total: incoming.length,
  };
}

// ---------------------------------------------------------------- reminders (push notifications)
//
// Wednesday 5 pm: "who is coming Saturday?"   Thursday 5 pm: reminder if not filled.
// Saturday 5 pm:  "who came today?"           Sunday 5 pm:   reminder if not filled.
// Each phone gets a notification only if its leader still has scouts not filled.
// Run setupReminders() once from the Apps Script editor to switch this on.

function setupReminders() {
  const handlers = { notifyWednesday: 'WEDNESDAY', notifyThursday: 'THURSDAY', notifySaturday: 'SATURDAY', notifySunday: 'SUNDAY' };
  ScriptApp.getProjectTriggers().forEach(t => { if (handlers[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t); });
  Object.keys(handlers).forEach(fn => {
    ScriptApp.newTrigger(fn).timeBased().onWeekDay(ScriptApp.WeekDay[handlers[fn]]).atHour(17).nearMinute(0).everyWeeks(1).create();
  });
  vapidPublicKey_();
  Logger.log('Reminders are on: Wednesday, Thursday, Saturday and Sunday around 5 pm (' + Session.getScriptTimeZone() + ').');
}

function notifyWednesday() { sendReminders_('wed', 3); }
function notifyThursday() { sendReminders_('wed', 2); }
function notifySaturday() { sendReminders_('sat', 0); }
function notifySunday() { sendReminders_('sat', -1); }

function remindersOn_() {
  try {
    return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'notifyWednesday');
  } catch (err) {
    return null;
  }
}

/** Sends to every phone whose leader has scouts without an answer for that Saturday. */
function sendReminders_(phase, daysFromToday) {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const date = addDaysIso_(today, daysFromToday);
  if (readTable_('meetings').some(m => m.date === date && m.cancelled === '1')) return { date: date, sent: 0 };

  const filled = {};
  readTable_('attendance').forEach(a => { if (a.date === date && a[phase + 'Status']) filled[a.memberId] = true; });
  const members = readTable_('members').filter(m => m.active !== '0');
  const waiting = {};
  readTable_('reporters').forEach(r => {
    const scope = scopeOf_(publicReporter_(r));
    waiting[r.id] = members.some(m => (!scope || scope[m.patrol]) && !filled[m.id]);
  });
  const subs = readTable_('push').filter(s => waiting[s.reporterId]);
  return { date: date, sent: pushToAll_(subs) };
}

function savePush_(p, token) {
  const me = auth_(token);
  const endpoint = String(p.endpoint || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) throw new Error('Bad subscription.');
  return withLock_(() => {
    const rows = readTable_('push').map(stripRow_).filter(r => r.endpoint !== endpoint);
    rows.push({ endpoint: endpoint, reporterId: me.id, createdAt: nowIso_(), lastSent: '', lastStatus: '' });
    writeTable_('push', rows);
    return { ok: true };
  });
}

function removePush_(p, token) {
  auth_(token);
  return withLock_(() => {
    writeTable_('push', readTable_('push').map(stripRow_).filter(r => r.endpoint !== p.endpoint));
    return { ok: true };
  });
}

/** Sends a notification right now to the phones of whoever asks. */
function testPush_(p, token) {
  const me = auth_(token);
  const subs = readTable_('push').filter(s => s.reporterId === me.id);
  if (!subs.length) throw new Error('Turn on reminders on this phone first (Home tab).');
  return { sent: pushToAll_(subs) };
}

/** Empty push messages (the app writes the text itself); dead subscriptions are removed. */
function pushToAll_(subs) {
  if (!subs.length) return 0;
  const jwts = {};
  const results = subs.map(s => {
    const aud = s.endpoint.match(/^https:\/\/[^/]+/)[0];
    jwts[aud] = jwts[aud] || vapidJwt_(aud);
    let code = 0;
    try {
      code = UrlFetchApp.fetch(s.endpoint, {
        method: 'post',
        headers: { Authorization: 'vapid t=' + jwts[aud] + ', k=' + vapidPublicKey_(), TTL: '86400', Urgency: 'high' },
        payload: '',
        muteHttpExceptions: true,
      }).getResponseCode();
    } catch (err) { code = -1; }
    return { endpoint: s.endpoint, code: code };
  });
  withLock_(() => {
    const now = nowIso_();
    const byEndpoint = {};
    results.forEach(r => { byEndpoint[r.endpoint] = r.code; });
    const rows = readTable_('push').map(stripRow_)
      .filter(r => byEndpoint[r.endpoint] !== 404 && byEndpoint[r.endpoint] !== 410)
      .map(r => (byEndpoint[r.endpoint] === undefined ? r : Object.assign(r, { lastSent: now, lastStatus: String(byEndpoint[r.endpoint]) })));
    writeTable_('push', rows);
  });
  return results.filter(r => r.code >= 200 && r.code < 300).length;
}

function addDaysIso_(iso, n) {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + n));
  return d.toISOString().slice(0, 10);
}

// ---- VAPID (the key that lets this script send push messages), ES256 on curve P-256.

const P256_ = {
  p: BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff'),
  n: BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
  g: [BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
    BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')],
};
const B0_ = BigInt(0);
const B1_ = BigInt(1);
const B2_ = BigInt(2);
const B3_ = BigInt(3);

function vapidPublicKey_() {
  const props = PropertiesService.getScriptProperties();
  let pub = props.getProperty('VAPID_PUBLIC');
  if (pub) return pub;
  const seed = Utilities.getUuid() + Utilities.getUuid() + secret_() + Date.now();
  const d = bytesToBig_(sha256_(seed)) % (P256_.n - B1_) + B1_;
  const q = ecMul_(d, P256_.g);
  pub = b64url_([4].concat(bigToBytes_(q[0]), bigToBytes_(q[1])));
  props.setProperty('VAPID_PRIVATE', d.toString(16));
  props.setProperty('VAPID_PUBLIC', pub);
  return pub;
}

function vapidJwt_(audience) {
  vapidPublicKey_();
  const d = BigInt('0x' + PropertiesService.getScriptProperties().getProperty('VAPID_PRIVATE'));
  const enc = (o) => b64url_(utf8Bytes_(JSON.stringify(o)));
  const input = enc({ typ: 'JWT', alg: 'ES256' }) + '.' +
    enc({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://github.com/chrs-005/hp-app' });
  return input + '.' + b64url_(ecdsaSign_(d, sha256_(input)));
}

/** ECDSA signature (r || s, 64 bytes) with a deterministic nonce (RFC 6979). */
function ecdsaSign_(d, hash) {
  const n = P256_.n;
  const e = bytesToBig_(hash);
  const x = bigToBytes_(d);
  const h1 = bigToBytes_(e % n);
  let v = new Array(32).fill(1);
  let k = new Array(32).fill(0);
  k = hmac_(k, v.concat([0], x, h1));
  v = hmac_(k, v);
  k = hmac_(k, v.concat([1], x, h1));
  v = hmac_(k, v);
  for (;;) {
    v = hmac_(k, v);
    const nonce = bytesToBig_(v);
    if (nonce >= B1_ && nonce < n) {
      const r = ecMul_(nonce, P256_.g)[0] % n;
      const s = (modInv_(nonce, n) * (e + r * d)) % n;
      if (r !== B0_ && s !== B0_) return bigToBytes_(r).concat(bigToBytes_(s));
    }
    k = hmac_(k, v.concat([0]));
    v = hmac_(k, v);
  }
}

function ecAdd_(a, b) {
  const p = P256_.p;
  if (!a) return b;
  if (!b) return a;
  let l;
  if (a[0] === b[0]) {
    if ((a[1] + b[1]) % p === B0_) return null;
    l = mod_(B3_ * a[0] * a[0] - B3_, p) * modInv_(mod_(B2_ * a[1], p), p);   // curve a = -3
  } else {
    l = mod_(b[1] - a[1], p) * modInv_(mod_(b[0] - a[0], p), p);
  }
  l = mod_(l, p);
  const x = mod_(l * l - a[0] - b[0], p);
  return [x, mod_(l * (a[0] - x) - a[1], p)];
}

function ecMul_(k, point) {
  let result = null;
  let addend = point;
  while (k > B0_) {
    if (k & B1_) result = ecAdd_(result, addend);
    addend = ecAdd_(addend, addend);
    k = k >> B1_;
  }
  return result;
}

function mod_(a, m) {
  const r = a % m;
  return r < B0_ ? r + m : r;
}

function modInv_(a, m) {
  let [oldR, r] = [mod_(a, m), m];
  let [oldS, s] = [B1_, B0_];
  while (r !== B0_) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod_(oldS, m);
}

// Byte helpers. Apps Script uses signed bytes (-128..127); these work with 0..255.
const toSigned_ = (bytes) => bytes.map(b => (b > 127 ? b - 256 : b));
const toUnsigned_ = (bytes) => Array.prototype.map.call(bytes, b => b & 255);
function sha256_(text) { return toUnsigned_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)); }
function hmac_(key, data) { return toUnsigned_(Utilities.computeHmacSha256Signature(toSigned_(data), toSigned_(key))); }
function utf8Bytes_(text) { return toUnsigned_(Utilities.newBlob(text).getBytes()); }
function b64url_(bytes) { return Utilities.base64EncodeWebSafe(toSigned_(bytes)).replace(/=+$/, ''); }
function bytesToBig_(bytes) { return BigInt('0x' + (bytes.map(b => (b < 16 ? '0' : '') + b.toString(16)).join('') || '0')); }
function bigToBytes_(x) {
  const hex = x.toString(16).padStart(64, '0');
  const out = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

// ---------------------------------------------------------------- auth

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SECRET', s);
  }
  return s;
}

function hash_(text) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret_() + '|' + text));
}

function sign_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret_()));
}

function makeToken_(id) {
  const payload = id + '.' + (Date.now() + TOKEN_DAYS * 86400000);
  return payload + '.' + sign_(payload);
}

function auth_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('AUTH');
  const payload = parts[0] + '.' + parts[1];
  if (sign_(payload) !== parts[2] || Number(parts[1]) < Date.now()) throw new Error('AUTH');
  const r = readTable_('reporters').find(x => x.id === parts[0]);
  if (!r) throw new Error('AUTH');
  return publicReporter_(r);
}

function requireAdmin_(token) {
  const me = auth_(token);
  if (me.role !== 'admin') throw new Error('Only the chief can do this.');
  return me;
}

/** Patrols a reporter is in charge of, or null for everyone. */
function scopeOf_(me) {
  if (me.role === 'admin' || !me.patrols.length) return null;
  const s = {};
  me.patrols.forEach(p => { s[p] = true; });
  return s;
}

function publicReporter_(r) {
  return { id: r.id, name: r.name, role: r.role || 'cp', patrols: r.patrols ? String(r.patrols).split(',').filter(Boolean) : [] };
}

function cleanName_(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) throw new Error('Name is required.');
  if (n.length > 60) throw new Error('Name is too long.');
  return n;
}

/** Anyone signed in: payload { pin (current), newPin }. */
function changePin_(p, token) {
  const me = auth_(token);
  const newPin = cleanPin_(p.newPin);
  return withLock_(() => {
    const r = readTable_('reporters').find(x => x.id === me.id);
    const current = String(p.pin || '').trim();
    const ok = r.pinHash.indexOf('plain:') === 0 ? current === r.pinHash.slice(6) : r.pinHash === hash_(r.id + ':' + current);
    if (!ok) throw new Error('Your current PIN is wrong.');
    if (newPin === current) throw new Error('Choose a PIN different from the current one.');
    updateRow_('reporters', r._row, { pinHash: hash_(r.id + ':' + newPin) });
    return { ok: true };
  });
}

function cleanPin_(pin) {
  const p = String(pin || '').trim();
  if (!/^\d{4}$/.test(p)) throw new Error('The PIN must be 4 digits.');
  return p;
}

// ---------------------------------------------------------------- storage

function db_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DB_ID');
  if (id) return SpreadsheetApp.openById(id);
  // Script attached to a sheet: use it. Standalone script: create the database sheet
  // (it is moved next to the members file at the first import).
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    ss = SpreadsheetApp.create('HP App – Database (do not edit)');
    props.setProperty('DB_AUTO', '1');
  }
  props.setProperty('DB_ID', ss.getId());
  return ss;
}

function sheet_(name) {
  const ss = db_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const cols = DB_SCHEMA[name].length;
    sh.getRange(1, 1, sh.getMaxRows(), cols).setNumberFormat('@'); // keep dates & PINs as plain text
    sh.getRange(1, 1, 1, cols).setValues([DB_SCHEMA[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const keys = DB_SCHEMA[name];
  return sh.getRange(2, 1, last - 1, keys.length).getDisplayValues()
    .map((row, i) => {
      const o = { _row: i + 2 };
      keys.forEach((k, j) => { o[k] = row[j]; });
      return o;
    })
    .filter(o => keys.some(k => o[k] !== ''));
}

/** Replaces the whole table with `rows` in a single write. */
function writeTable_(name, rows) {
  const sh = sheet_(name);
  const keys = DB_SCHEMA[name];
  const last = sh.getLastRow();
  if (rows.length) {
    const range = sh.getRange(2, 1, rows.length, keys.length);
    range.setNumberFormat('@');
    range.setValues(rows.map(r => keys.map(k => (r[k] == null ? '' : String(r[k])))));
  }
  if (last > rows.length + 1) sh.getRange(rows.length + 2, 1, last - rows.length - 1, keys.length).clearContent();
}

function updateRow_(name, rowNumber, changes) {
  const keys = DB_SCHEMA[name];
  const range = sheet_(name).getRange(rowNumber, 1, 1, keys.length);
  const row = range.getDisplayValues()[0];
  keys.forEach((k, j) => { if (changes[k] !== undefined) row[j] = String(changes[k]); });
  range.setNumberFormat('@');
  range.setValues([row]);
}

function stripRow_(r) {
  const o = {};
  Object.keys(r).forEach(k => { if (k !== '_row') o[k] = r[k]; });
  return o;
}

function getConfig_() {
  const o = {};
  readTable_('config').forEach(r => { o[r.key] = r.value; });
  return o;
}

function setConfig_(values) {
  withLock_(() => {
    const rows = readTable_('config').map(stripRow_);
    Object.keys(values).forEach(k => {
      const r = rows.find(x => x.key === k);
      if (r) r.value = values[k]; else rows.push({ key: k, value: values[k] });
    });
    writeTable_('config', rows);
  });
}

function settings_(cfg) {
  const s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(k => {
    const d = DEFAULT_SETTINGS[k];
    const v = cfg[k];
    s[k] = (v === undefined || v === '') ? d : (typeof d === 'number' ? Number(v) : v);
  });
  return s;
}

let lockDepth_ = 0;
function withLock_(fn) {
  if (lockDepth_ > 0) return fn();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  lockDepth_++;
  try {
    return fn();
  } finally {
    lockDepth_--;
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function newId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

function nowIso_() {
  return new Date().toISOString();
}

function isIsoDate_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

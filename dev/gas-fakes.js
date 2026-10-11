// Minimal in-memory stand-ins for the Google Apps Script services used by Code.gs.
// Only for local testing (browser preview + node tests). Not deployed.
(function (root) {
  'use strict';

  function makeFakes(opts) {
    opts = opts || {};
    const state = (opts.load && opts.load()) || { props: {}, db: {} };
    const cache = {};
    let uuidCounter = 0;

    function SheetFake(store, name) {
      // store[name] = { hidden, rows: [[...]] }
      const o = store[name];
      const sheet = {
        getName: () => name,
        isSheetHidden: () => !!o.hidden,
        getMaxRows: () => Math.max(1000, o.rows.length),
        getMaxColumns: () => 26,
        setFrozenRows: () => sheet,
        getLastRow: () => {
          for (let r = o.rows.length - 1; r >= 0; r--) {
            if ((o.rows[r] || []).some(v => v !== '' && v != null)) return r + 1;
          }
          return 0;
        },
        getRange: (row, col, nr, nc) => RangeFake(o, row, col, nr || 1, nc || 1),
        getDataRange: () => {
          const nr = sheet.getLastRow() || 1;
          const nc = Math.max(1, ...o.rows.map(r => r.length));
          return RangeFake(o, 1, 1, nr, nc);
        },
      };
      return sheet;
    }

    function RangeFake(o, row, col, nr, nc) {
      const range = {
        getDisplayValues: () => {
          const out = [];
          for (let r = 0; r < nr; r++) {
            const src = o.rows[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < nc; c++) line.push(src[col - 1 + c] == null ? '' : String(src[col - 1 + c]));
            out.push(line);
          }
          return out;
        },
        setValues: (values) => {
          if (values.length !== nr || values.some(v => v.length !== nc)) throw new Error('Fake: setValues size mismatch');
          for (let r = 0; r < nr; r++) {
            const i = row - 1 + r;
            while (o.rows.length <= i) o.rows.push([]);
            for (let c = 0; c < nc; c++) o.rows[i][col - 1 + c] = String(values[r][c]);
          }
          return range;
        },
        clearContent: () => {
          for (let r = 0; r < nr; r++) {
            const line = o.rows[row - 1 + r];
            if (line) for (let c = 0; c < nc; c++) line[col - 1 + c] = '';
          }
          return range;
        },
        getFontColorObjects: () => {
          const out = [];
          for (let r = 0; r < nr; r++) {
            const src = (o.colors || [])[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < nc; c++) {
              const hex = src[col - 1 + c] || '#000000';
              line.push({ getColorType: () => 'RGB', asRgbColor: () => ({ asHexString: () => hex }) });
            }
            out.push(line);
          }
          return out;
        },
        setNumberFormat: () => range,
        setFontWeight: () => range,
      };
      return range;
    }

    function SpreadsheetFake(id, store) {
      const ss = {
        getId: () => id,
        getSheetByName: (n) => (store[n] ? SheetFake(store, n) : null),
        getSheets: () => Object.keys(store).map(n => SheetFake(store, n)),
        insertSheet: (n) => { store[n] = { hidden: false, rows: [] }; return SheetFake(store, n); },
      };
      return ss;
    }

    const db = SpreadsheetFake('DB', state.db);
    const source = opts.source || { name: 'members.xlsx', sheets: [] };
    const sourceStore = {};
    source.sheets.forEach(s => {
      sourceStore[s.name] = { hidden: s.hidden, rows: s.grid.map(r => r.slice()), colors: (s.colors || []).map(r => r.slice()) };
    });
    const sourceSs = SpreadsheetFake('TMP', sourceStore);
    // Drive state the tests can change: when the members file was last modified, where the DB went.
    const drive = { updated: new Date('2026-10-11T16:56:11Z'), dbFolder: null };
    // Push requests sent by the script, and its time triggers (tests read these).
    const net = { requests: [], respond: () => 201, triggers: [], now: null };
    const nodeCrypto = opts.realCrypto ? require('crypto') : null;
    const signed = (buf) => Array.from(buf, b => (b > 127 ? b - 256 : b));
    const toBuf = (x) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map(b => b & 255)));

    function fakeHash(text) {
      // FNV-1a, repeated to 32 bytes. Not cryptographic — local testing only.
      const bytes = [];
      let h = 0x811c9dc5;
      for (let round = 0; round < 8; round++) {
        for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i) + round; h = Math.imul(h, 16777619) >>> 0; }
        bytes.push(h & 255, (h >>> 8) & 255, (h >>> 16) & 255, (h >>> 24) & 255);
      }
      return bytes;
    }

    return {
      persist: () => opts.save && opts.save(state),
      drive: drive,
      net: net,
      SpreadsheetApp: {
        getActiveSpreadsheet: () => (opts.standalone ? null : db),
        create: () => db,
        openById: (id) => {
          if (id === 'DB') return db;
          if (id === 'TMP') return sourceSs;
          throw new Error('Fake: unknown spreadsheet ' + id);
        },
        flush: () => {},
      },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k) => (k in state.props ? state.props[k] : null),
          setProperty: (k, v) => { state.props[k] = String(v); },
          deleteProperty: (k) => { delete state.props[k]; },
        }),
      },
      CacheService: {
        getScriptCache: () => ({
          get: (k) => (k in cache ? cache[k] : null),
          put: (k, v) => { cache[k] = String(v); },
          remove: (k) => { delete cache[k]; },
        }),
      },
      LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
      Utilities: {
        DigestAlgorithm: { SHA_256: 'SHA_256' },
        Charset: { UTF_8: 'UTF_8' },
        computeDigest: (alg, text) => (nodeCrypto ? signed(nodeCrypto.createHash('sha256').update(toBuf(text)).digest()) : fakeHash(String(text))),
        computeHmacSha256Signature: (value, key) => (nodeCrypto
          ? signed(nodeCrypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest())
          : fakeHash(String(key) + '#' + String(value))),
        base64EncodeWebSafe: (bytes) => (nodeCrypto
          ? Buffer.from(bytes.map(b => b & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
          : bytes.map(b => (b & 255).toString(16).padStart(2, '0')).join('')),
        newBlob: (text) => ({ getBytes: () => signed(new TextEncoder().encode(String(text))) }),
        formatDate: (date) => {
          const d = net.now || date;
          return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        },
        getUuid: () => {
          uuidCounter++;
          const rnd = Math.random().toString(16).slice(2) + Date.now().toString(16) + uuidCounter.toString(16);
          return (rnd + '00000000000000000000000000000000').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
        },
      },
      DriveApp: {
        getFileById: (id) => {
          if (id === 'DB') return { moveTo: (folder) => { drive.dbFolder = folder.getName(); } };
          if (id === 'TMP' || /^[\w-]{20,}$/.test(id)) {
            const folders = [{ getName: () => 'Scouts 2026-2027' }];
            return {
              getMimeType: () => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              getName: () => source.name,
              getLastUpdated: () => drive.updated,
              getParents: () => ({ hasNext: () => folders.length > 0, next: () => folders.shift() }),
              setTrashed: () => {},
            };
          }
          throw new Error('Fake: no file');
        },
      },
      Drive: { Files: { copy: () => ({ id: 'TMP' }) } },
      Session: { getScriptTimeZone: () => 'Asia/Beirut' },
      Logger: { log: () => {} },
      UrlFetchApp: {
        fetch: (url, params) => {
          net.requests.push({ url: url, params: params });
          const code = net.respond(url);
          return { getResponseCode: () => code };
        },
      },
      ScriptApp: {
        WeekDay: { WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
        getProjectTriggers: () => net.triggers.map(t => ({ getHandlerFunction: () => t.fn, _t: t })),
        deleteTrigger: (t) => { net.triggers.splice(net.triggers.indexOf(t._t), 1); },
        newTrigger: (fn) => {
          const t = { fn: fn };
          const b = {
            timeBased: () => b,
            onWeekDay: (d) => { t.day = d; return b; },
            atHour: (h) => { t.hour = h; return b; },
            nearMinute: (m) => { t.minute = m; return b; },
            everyWeeks: () => b,
            create: () => { net.triggers.push(t); return t; },
          };
          return b;
        },
      },
      MimeType: { GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
      HtmlService: {},
      ContentService: {},
    };
  }

  /** Evaluates Code.gs with the fake services in scope and returns its entry points. */
  function loadServer(code, fakes) {
    const names = Object.keys(fakes).filter(k => k !== 'persist' && k !== 'drive' && k !== 'net');
    const exported = ['api', 'parseRoster_', 'setupReminders', 'notifyWednesday', 'notifyThursday', 'notifySaturday', 'notifySunday', 'vapidJwt_'];
    const factory = new Function(...names, code + '\n;return {' + exported.map(n => n + ': ' + n).join(', ') + '};');
    return factory(...names.map(n => fakes[n]));
  }

  root.HPFakes = { makeFakes: makeFakes, loadServer: loadServer };
  if (typeof module !== 'undefined') module.exports = root.HPFakes;
})(typeof window !== 'undefined' ? window : globalThis);

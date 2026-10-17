// Runs Code.gs against in-memory fakes:  node dev/test-server.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { makeFakes, loadServer } = require('./gas-fakes');
const source = require('./sample-source');
const { seedDemo, DEMO_PIN, DEMO_ADMIN, SOURCE_URL } = require('./seed');

const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const fakes = makeFakes({ source: source });
const server = loadServer(code, fakes);
const call = (action, payload, token) => server.api({ action: action, payload: payload, token: token });
const ok = (r) => { assert.ok(r.ok, r.error); return r.data; };

// Roster parser: layout + leaders written in color.
const sheet = source.sheets[0];
const roster = server.parseRoster_(sheet.grid, sheet.colors);
assert.deepStrictEqual(roster.patrols, ['Panda', 'Leopard', 'Faucon', 'Bison', 'Requin']);
assert.strictEqual(roster.members.length, 50);
const counts = {};
roster.members.forEach(m => { counts[m.patrol] = (counts[m.patrol] || 0) + 1; });
assert.deepStrictEqual(counts, { Panda: 10, Leopard: 10, Faucon: 10, Bison: 10, Requin: 10 });
assert.strictEqual(roster.members[0].birthYear, '2010');
assert.strictEqual(roster.members[roster.members.length - 1].birthYear, '2014');
const leaders = roster.members.filter(m => m.leader);
assert.strictEqual(leaders.length, 11);
assert.strictEqual(leaders.filter(m => m.leader === 'green').length, 5);
assert.strictEqual(leaders.filter(m => m.leader === 'red').length, 6);
assert.strictEqual(leaders.filter(m => m.patrol === 'Faucon').length, 3);
assert.strictEqual(server.parseRoster_(sheet.grid).members.filter(m => m.leader).length, 0);  // no colors -> no leaders
assert.strictEqual(server.parseRoster_(source.sheets[1].grid).members.length, 42);

// First run.
assert.strictEqual(ok(call('bootstrap')).needsSetup, true);
const { token } = seedDemo(server.api);
const boot = ok(call('bootstrap'));
assert.strictEqual(boot.needsSetup, false);
assert.strictEqual(boot.reporters, undefined);           // no names leak before login
assert.strictEqual(call('setup', { name: 'X', pin: '1111' }).ok, false);   // already set up

// Admin state.
const st = ok(call('state', {}, token));
assert.strictEqual(st.me.role, 'admin');
assert.strictEqual(st.members.filter(m => m.active).length, 50);
assert.strictEqual(st.members.filter(m => m.leader).length, 11);
assert.strictEqual(st.attendance.filter(a => /^\d{4}-/.test(a.date)).length, 50 * 6 + 20);
assert.strictEqual(st.attendance.filter(a => a.date.indexOf('ev_') === 0).length, 50 + 15);
assert.strictEqual(st.source.sheetName, '2025-2026');
assert.strictEqual(st.reporters.length, 12);
const fauconLeads = st.reporters.filter(r => r.patrols.join() === 'Faucon');
assert.strictEqual(fauconLeads.length, 3);

// Leader accounts: second run creates nothing, PINs are 6 digits.
const again = ok(call('createLeaderAccounts', {}, token));
assert.strictEqual(again.created.length, 0);
assert.strictEqual(again.existing.length, 11);

// Login by typed name (case / accents / spaces ignored), scope and lockout.
const lead = fauconLeads[0];
assert.match(call('login', { name: lead.name, pin: '0000' }).error, /Wrong name or PIN/);
assert.match(call('login', { name: 'Nobody Here', pin: DEMO_PIN }).error, /Wrong name or PIN/);
const pTok = ok(call('login', { name: '  ' + lead.name.toUpperCase() + ' ', pin: DEMO_PIN })).token;
const pst = ok(call('state', {}, pTok));
assert.strictEqual(pst.reporters.length, 0);
assert.strictEqual(pst.source, null);
const fauconIds = new Set(pst.members.filter(m => m.patrol === 'Faucon').map(m => m.id));
assert.ok(pst.attendance.every(a => fauconIds.has(a.memberId)));
const requin = st.members.find(m => m.patrol === 'Requin');
assert.match(call('saveAttendance', { entries: [{ date: '2026-10-17', memberId: requin.id, phase: 'wed', status: 'coming' }] }, pTok).error, /not in charge/);
const faucon = st.members.find(m => m.patrol === 'Faucon');
const saved = ok(call('saveAttendance', { entries: [{ date: '2026-10-17', memberId: faucon.id, phase: 'sat', status: 'late', reason: ' Traffic ' }] }, pTok));
assert.strictEqual(saved.rows[0].satReason, 'Traffic');
assert.strictEqual(saved.rows[0].satBy, lead.name);
assert.strictEqual(call('saveSettings', { lowPct: 10 }, pTok).ok, false);
for (let i = 0; i < 5; i++) call('login', { name: lead.name, pin: '9999' });
assert.match(call('login', { name: lead.name, pin: DEMO_PIN }).error, /Too many/);
assert.match(call('state', {}, 'bad.token.x').error, /AUTH/);

// Cancelled meeting blocks reporters.
ok(call('setMeeting', { date: '2026-10-24', cancelled: true, note: 'Holiday' }, token));
const bisonLead = st.reporters.find(r => r.patrols.join() === 'Bison');
const bTok = ok(call('login', { name: bisonLead.name, pin: DEMO_PIN })).token;
const bison = st.members.find(m => m.patrol === 'Bison');
assert.match(call('saveAttendance', { entries: [{ date: '2026-10-24', memberId: bison.id, phase: 'wed', status: 'coming' }] }, bTok).error, /no réunion/);

// Settings validation.
assert.strictEqual(call('saveSettings', { lowPct: 90, warnPct: 80 }, token).ok, false);
assert.strictEqual(ok(call('saveSettings', { minMeetings: 4 }, token)).settings.minMeetings, 4);

// Re-import: a scout removed from the sheet becomes inactive and keeps history.
const srcSheet = fakes.SpreadsheetApp.openById('TMP').getSheetByName('2025-2026');
const lastName = sheet.grid[18][7];                                        // H19
const renamed = sheet.grid[17][3];                                         // D18
srcSheet.getRange(19, 8, 1, 1).setValues([['']]);
srcSheet.getRange(18, 4, 1, 1).setValues([[renamed.replace(/e/, 'é')]]);   // same id after accent removal
srcSheet.getRange(19, 4, 1, 1).setValues([['New Scout']]);
const preview = ok(call('syncSource', { url: SOURCE_URL, apply: false }, token));
assert.deepStrictEqual(preview.sheetNames, ['2025-2026']);
assert.deepStrictEqual(preview.diff.added, ['New Scout']);
assert.deepStrictEqual(preview.diff.removed, [lastName]);
assert.strictEqual(preview.diff.leaders.length, 11);
assert.strictEqual(ok(call('state', {}, token)).members.filter(m => m.active).length, 50);  // preview changes nothing
ok(call('syncSource', { url: SOURCE_URL, apply: true }, token));
const after = ok(call('state', {}, token));
assert.strictEqual(after.members.filter(m => m.active).length, 50);
const gone = after.members.find(m => m.name === lastName);
assert.strictEqual(gone.active, false);
assert.ok(after.attendance.some(a => a.memberId === gone.id));
assert.strictEqual(call('syncSource', { url: 'not a link' }, token).ok, false);

// Emergency PIN reset via the sheet ("plain:" prefix).
const reporters = fakes.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('reporters');
const rows = reporters.getRange(2, 1, reporters.getLastRow() - 1, 6).getDisplayValues();
const rowIdx = rows.findIndex(r => r[1] === DEMO_ADMIN);
reporters.getRange(rowIdx + 2, 3, 1, 1).setValues([['plain:4321']]);
ok(call('login', { name: DEMO_ADMIN, pin: '4321' }));
ok(call('login', { name: DEMO_ADMIN, pin: '4321' }));   // hash was upgraded and still works
assert.notStrictEqual(reporters.getRange(rowIdx + 2, 3, 1, 1).getDisplayValues()[0][0], 'plain:4321');

// Last admin cannot be demoted or self-deleted.
assert.match(call('saveReporter', { id: st.me.id, name: DEMO_ADMIN, role: 'reporter', patrols: [] }, token).error, /at least one chief/);
assert.match(call('deleteReporter', { id: st.me.id }, token).error, /yourself/);

// Fresh install: leader accounts come with 4-digit PINs.
const f2 = makeFakes({ source: source });
const s2 = loadServer(code, f2);
const c2 = (a, p, t) => ok(s2.api({ action: a, payload: p, token: t }));
const t2 = c2('setup', { name: 'Chief', pin: '1234' }).token;
assert.match(s2.api({ action: 'createLeaderAccounts', payload: {}, token: t2 }).error, /No CP or SP found/);
c2('syncSource', { url: SOURCE_URL, apply: true }, t2);
const made = c2('createLeaderAccounts', {}, t2);
assert.strictEqual(made.created.length, 11);
// Green name = CP, red name = SP.
const roles2 = {};
made.reporters.forEach(r => { roles2[r.name] = r.role; });
made.created.forEach(x => assert.strictEqual(roles2[x.name], x.leader === 'red' ? 'sp' : 'cp'));
assert.strictEqual(made.created.filter(x => roles2[x.name] === 'cp').length, 5);
assert.strictEqual(made.created.filter(x => roles2[x.name] === 'sp').length, 6);
const asSp = c2('saveReporter', { name: 'Extra Person', pin: '4321', role: 'sp', patrols: ['Panda'] }, t2);
assert.strictEqual(asSp.reporters.find(r => r.name === 'Extra Person').role, 'sp');
const odd = c2('saveReporter', { name: 'Odd Role', pin: '4321', role: 'reporter', patrols: [] }, t2);
assert.strictEqual(odd.reporters.find(r => r.name === 'Odd Role').role, 'cp');
assert.ok(made.created.every(x => /^\d{4}$/.test(x.pin)));
c2('login', { name: made.created[0].name, pin: made.created[0].pin });

// Standalone script: setup with the members link creates the DB, imports, and moves the DB next to the file.
const f3 = makeFakes({ source: source, standalone: true });
const s3 = loadServer(code, f3);
const c3 = (a, p, t) => ok(s3.api({ action: a, payload: p, token: t }));
const setup3 = c3('setup', { name: 'Chief', pin: '1234', sourceUrl: SOURCE_URL });
assert.strictEqual(setup3.importError, '');
let st3 = c3('state', {}, setup3.token);
assert.strictEqual(st3.members.filter(m => m.active).length, 50);
assert.strictEqual(f3.drive.dbFolder, 'Scouts 2026-2027');
assert.strictEqual(st3.membersSync, null);

// Live sync: the file changes in Drive -> next forced refresh imports it; unchanged -> nothing.
const src3 = f3.SpreadsheetApp.openById('TMP').getSheetByName('2025-2026');
src3.getRange(19, 4, 1, 1).setValues([['Late Joiner']]);
st3 = c3('state', { sync: true }, setup3.token);
assert.strictEqual(st3.membersSync, null);                       // file date unchanged -> no re-import
f3.drive.updated = new Date('2026-10-12T09:00:00Z');
st3 = c3('state', {}, setup3.token);
assert.strictEqual(st3.membersSync, null);                       // checked < 5 min ago -> skipped
st3 = c3('state', { sync: true }, setup3.token);                 // ↻ button
assert.deepStrictEqual(st3.membersSync.added, ['Late Joiner']);
assert.ok(st3.members.some(m => m.name === 'Late Joiner' && m.active));
assert.strictEqual(st3.source.lastImportBy, 'Auto-sync');
assert.strictEqual(c3('state', { sync: true }, setup3.token).membersSync, null);

// The database is moved only once: after the chief moves it, imports leave it alone.
f3.drive.dbFolder = 'Secretariat/HP App';
f3.drive.updated = new Date('2026-10-13T09:00:00Z');
c3('state', { sync: true }, setup3.token);
assert.strictEqual(f3.drive.dbFolder, 'Secretariat/HP App');

// Camps & special events.
const evs = st3.events;
assert.deepStrictEqual(evs.map(e => e.title), ['Camp Patrouille', 'Camp Noël', 'Camp Pâques', 'Camp d\'Été']);
assert.ok(evs.every(e => e.kind === 'camp'));
const noel = evs[1].id;
let evRes = c3('saveEvent', { id: noel, title: 'Camp Noël', date: '2026-12-27', endDate: '2026-12-30' }, setup3.token);
assert.strictEqual(evRes.events[1].date, '2026-12-27');
evRes = c3('saveEvent', { title: 'Sortie Jamboree', date: '2026-11-05' }, setup3.token);
const special = evRes.id;
assert.deepStrictEqual(evRes.events.map(e => e.kind), ['camp', 'camp', 'camp', 'camp', 'special']);
assert.match(s3.api({ action: 'saveEvent', payload: { title: 'X', date: '2026-11-05', endDate: '2026-11-01' }, token: setup3.token }).error, /before/);
const someone = st3.members[0].id;
c3('saveAttendance', { entries: [
  { date: noel, memberId: someone, phase: 'wed', status: 'out', reason: 'Travel' },
  { date: special, memberId: someone, phase: 'sat', status: 'present' },
] }, setup3.token);
assert.match(s3.api({ action: 'saveAttendance', payload: { entries: [{ date: 'ev_nope', memberId: someone, phase: 'sat', status: 'present' }] }, token: setup3.token }).error, /does not exist/);
let st5 = c3('state', {}, setup3.token);
assert.strictEqual(st5.attendance.filter(a => a.date === noel || a.date === special).length, 2);
c3('deleteEvent', { id: special }, setup3.token);
st5 = c3('state', {}, setup3.token);
assert.strictEqual(st5.events.length, 4);
assert.strictEqual(st5.attendance.filter(a => a.date === special).length, 0);
c3('deleteEvent', { id: noel }, setup3.token);
assert.strictEqual(c3('state', {}, setup3.token).events.length, 3);   // deleted camps do not come back

// Extra chiefs with PIN 0000: equal rights, sign in with name + PIN, any 4 digits allowed.
['Chief Two', 'Chief Three'].forEach(n => c3('saveReporter', { name: n, pin: '0000', role: 'admin', patrols: [] }, setup3.token));
const two = c3('login', { name: 'chief two', pin: '0000' });
assert.strictEqual(two.mustChangePin, undefined);
const twoState = c3('state', {}, two.token);
assert.strictEqual(twoState.me.role, 'admin');
assert.ok(twoState.source && twoState.reporters.length >= 3);          // same access as the first chief
c3('saveEvent', { title: 'Made by chief two' }, two.token);
assert.match(s3.api({ action: 'saveReporter', payload: { name: 'Chief Four', pin: '12345', role: 'admin' }, token: two.token }).error, /4 digits/);
assert.match(s3.api({ action: 'changePin', payload: { pin: '9999', newPin: '1111' }, token: two.token }).error, /current PIN is wrong/);
c3('changePin', { pin: '0000', newPin: '1111' }, two.token);
c3('login', { name: 'Chief Two', pin: '1111' });
assert.strictEqual(s3.api({ action: 'login', payload: { name: 'Chief Two', pin: '0000' } }).ok, false);

// ---- Reminders (push). Real crypto: the VAPID signature must verify with Node's ECDSA.
const crypto = require('crypto');
const f6 = makeFakes({ source: source, realCrypto: true });
const s6 = loadServer(code, f6);
const c6 = (a, p, t) => ok(s6.api({ action: a, payload: p, token: t }));
const t6 = c6('setup', { name: 'Chief', pin: '1234', sourceUrl: SOURCE_URL }).token;
const vapidKey = c6('bootstrap', {}).vapidKey;
assert.match(vapidKey, /^[A-Za-z0-9_-]{87}$/);                         // 65-byte uncompressed P-256 key
assert.strictEqual(c6('bootstrap', {}).vapidKey, vapidKey);             // stable
const raw = Buffer.from(vapidKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
for (let i = 0; i < 5; i++) {
  const jwt = s6.vapidJwt_('https://fcm.googleapis.com');
  const [h, pl, sig] = jwt.split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.strictEqual(JSON.parse(Buffer.from(pl, 'base64url')).aud, 'https://fcm.googleapis.com');
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + pl), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'VAPID signature must verify');
}

// Leaders subscribe; triggers; who gets notified.
const st6 = c6('state', {}, t6);
assert.strictEqual(st6.reminders, false);
s6.setupReminders();
assert.deepStrictEqual(f6.net.triggers.map(t => t.fn + '@' + t.day + ' ' + t.hour), ['notifyWednesday@WEDNESDAY 17', 'notifyThursday@THURSDAY 17', 'notifySaturday@SATURDAY 17', 'notifySunday@SUNDAY 17']);
s6.setupReminders();
assert.strictEqual(f6.net.triggers.length, 4);                           // running it twice does not duplicate
assert.strictEqual(c6('state', {}, t6).reminders, true);
const made6 = c6('createLeaderAccounts', {}, t6).created;
const panda6 = made6.filter(x => x.patrol === 'Panda');
const bison6 = made6.find(x => x.patrol === 'Bison');
const tokOf = (x) => c6('login', { name: x.name, pin: x.pin }).token;
c6('savePush', { endpoint: 'https://fcm.googleapis.com/fcm/send/panda-1' }, tokOf(panda6[0]));
c6('savePush', { endpoint: 'https://web.push.apple.com/panda-2' }, tokOf(panda6[1]));
c6('savePush', { endpoint: 'https://updates.push.services.mozilla.com/bison' }, tokOf(bison6));
assert.match(s6.api({ action: 'savePush', payload: { endpoint: 'http://evil' }, token: t6 }).error, /Bad subscription/);
assert.match(s6.api({ action: 'testPush', payload: {}, token: t6 }).error, /Turn on reminders/);

// Wednesday 14 Oct 2026, nothing filled for Saturday 17 -> all three phones.
f6.net.now = new Date(2026, 9, 14, 17, 0);
s6.notifyWednesday();
assert.strictEqual(f6.net.requests.length, 3);
const req = f6.net.requests[0];
assert.strictEqual(req.params.method, 'post');
assert.strictEqual(req.params.payload, '');
assert.match(req.params.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
assert.strictEqual(req.params.headers.TTL, '86400');
assert.ok(f6.net.requests.some(r => JSON.parse(Buffer.from(r.params.headers.Authorization.split('.')[1], 'base64url')).aud === 'https://web.push.apple.com'));

// Thursday: Panda filled everything -> only Bison's phone gets the reminder.
const st6b = c6('state', {}, t6);
c6('saveAttendance', { entries: st6b.members.filter(m => m.patrol === 'Panda').map(m => ({ date: '2026-10-17', memberId: m.id, phase: 'wed', status: 'coming' })) }, t6);
f6.net.requests = [];
f6.net.now = new Date(2026, 9, 15, 17, 0);
s6.notifyThursday();
assert.deepStrictEqual(f6.net.requests.map(r => r.url), ['https://updates.push.services.mozilla.com/bison']);

// Saturday: "They came" is a different question -> everyone again. A dead phone (410) is forgotten.
f6.net.requests = [];
f6.net.respond = (url) => (url.indexOf('apple') >= 0 ? 410 : 201);
f6.net.now = new Date(2026, 9, 17, 17, 0);
s6.notifySaturday();
assert.strictEqual(f6.net.requests.length, 3);
f6.net.requests = [];
f6.net.now = new Date(2026, 9, 18, 17, 0);
s6.notifySunday();                                                       // still about Saturday 17
assert.strictEqual(f6.net.requests.length, 2);
assert.ok(!f6.net.requests.some(r => r.url.indexOf('apple') >= 0));

// No meeting that Saturday -> no notifications.
c6('setMeeting', { date: '2026-10-24', cancelled: true }, t6);
f6.net.requests = [];
f6.net.now = new Date(2026, 9, 21, 17, 0);
s6.notifyWednesday();
assert.strictEqual(f6.net.requests.length, 0);

// Test button and turning reminders off.
f6.net.respond = () => 201;
const bisonTok = tokOf(bison6);
assert.strictEqual(c6('testPush', {}, bisonTok).sent, 1);
c6('removePush', { endpoint: 'https://updates.push.services.mozilla.com/bison' }, bisonTok);
assert.match(s6.api({ action: 'testPush', payload: {}, token: bisonTok }).error, /Turn on reminders/);

// ---- Money (chief only): troupe orders, single orders, given / paid.
const st7 = c3('state', {}, setup3.token);
assert.deepStrictEqual([st7.money.orders, st7.money.lines], [[], []]);
const everyone = st7.members.filter(m => m.active).map(m => m.id);
let mon = c3('saveOrder', { kind: 'troupe', title: 'Prêt', price: '12.5', memberIds: everyone }, setup3.token);
const pret = mon.id;
assert.strictEqual(mon.lines.filter(l => l.orderId === pret).length, everyone.length);
assert.ok(mon.lines.every(l => l.price === 12.5 && l.qty === 1 && !l.given && !l.paid && l.item === 'Prêt'));
const pl = mon.lines.filter(l => l.orderId === pret);
let up = c3('updateLine', { id: pl[0].id, given: true }, setup3.token).line;
assert.ok(up.given && up.givenAt && !up.paid);
up = c3('updateLine', { id: pl[0].id, paid: true, variant: 'M' }, setup3.token).line;
assert.ok(up.given && up.paid && up.variant === 'M');
c3('updateLine', { id: pl[1].id, price: '10' }, setup3.token);                     // a discount for one scout
mon = c3('setLines', { ids: pl.slice(2, 6).map(l => l.id), paid: true }, setup3.token);
assert.strictEqual(mon.lines.filter(l => l.orderId === pret && l.paid).length, 5);
// Renaming / repricing the order moves only the lines that still had the old price.
mon = c3('saveOrder', { id: pret, kind: 'troupe', title: 'Prêt 2026', price: '15', note: '' }, setup3.token);
const pl2 = mon.lines.filter(l => l.orderId === pret);
assert.ok(pl2.every(l => l.item === 'Prêt 2026'));
assert.strictEqual(pl2.find(l => l.id === pl[1].id).price, 10);
assert.strictEqual(pl2.find(l => l.id === pl[0].id).price, 15);
// Remove one scout, add him back (no duplicates).
mon = c3('deleteLines', { ids: [pl[3].id] }, setup3.token);
mon = c3('addLines', { orderId: pret, memberIds: everyone }, setup3.token);
assert.strictEqual(mon.lines.filter(l => l.orderId === pret).length, everyone.length);
// Single order: Chemise S (paid, not found yet) + Ceinture 110 (paid and given).
mon = c3('saveOrder', { kind: 'single', memberId: everyone[4], items: [
  { item: 'Chemise', variant: 'S', price: '25' }, { item: 'Ceinture', variant: '110', price: '8', qty: 1 }] }, setup3.token);
const single = mon.id;
const sl = mon.lines.filter(l => l.orderId === single);
assert.deepStrictEqual(sl.map(l => l.item + ' ' + l.variant), ['Chemise S', 'Ceinture 110']);
assert.ok(sl.every(l => l.memberId === everyone[4]));
c3('setLines', { ids: sl.map(l => l.id), paid: true }, setup3.token);
c3('updateLine', { id: sl[1].id, given: true }, setup3.token);
mon = c3('addLines', { orderId: single, items: [{ item: 'Badge', price: '2', qty: 3 }] }, setup3.token);
assert.strictEqual(mon.lines.filter(l => l.orderId === single).length, 3);
assert.strictEqual(mon.lines.find(l => l.item === 'Badge').qty, 3);
assert.match(s3.api({ action: 'saveOrder', payload: { kind: 'single', memberId: everyone[4], items: [{ item: 'X', price: '-3' }] }, token: setup3.token }).error, /Bad price/);
assert.match(s3.api({ action: 'saveOrder', payload: { kind: 'troupe', title: '', price: 1, memberIds: everyone }, token: setup3.token }).error, /name/);
assert.match(s3.api({ action: 'saveOrder', payload: { kind: 'single', memberId: 'nobody', items: [{ item: 'X', price: 1 }] }, token: setup3.token }).error, /Choose the scout/);
// CP / SP cannot see or touch money.
const cpTok = c3('login', { name: 'Chief Two', pin: '1111' }).token;   // chief: allowed
assert.ok(c3('state', {}, cpTok).money);
c3('saveReporter', { name: 'Simple Cp', pin: '2222', role: 'cp', patrols: ['Panda'] }, setup3.token);
const simpleTok = c3('login', { name: 'Simple Cp', pin: '2222' }).token;
assert.strictEqual(c3('state', {}, simpleTok).money, null);
assert.match(s3.api({ action: 'updateLine', payload: { id: sl[0].id, given: true }, token: simpleTok }).error, /Only the chief/);
// Item catalog: the troupe's items, sizes, prices and how they can be ordered.
const cat = c3('state', {}, setup3.token).money.catalog;
assert.deepStrictEqual(cat.map(c => c.name), ['Chemise', 'Ceinture', 'Short', 'Prêt', 'Cotisation de l\'année']);
assert.deepStrictEqual(cat[0].sizes, ['14', '16', 'S', 'M', 'L', 'XL', 'XXL']);
assert.deepStrictEqual(cat[1].sizes, ['110', '125', '140']);
assert.deepStrictEqual(cat[2].sizes, ['16', 'S', 'M', 'L', 'XL', 'XXL']);
assert.ok(cat.slice(0, 3).every(c => c.price === 15 && c.scope === 'single'));
assert.strictEqual(cat[3].scope, 'both');
assert.strictEqual(cat[3].price, null);
assert.strictEqual(cat[4].scope, 'troupe');
const err = (a, p) => s3.api({ action: a, payload: p, token: setup3.token }).error;
assert.match(err('saveOrder', { kind: 'single', memberId: everyone[5], items: [{ item: 'Chemise', variant: '', price: 15 }] }), /Choose a size for Chemise/);
assert.match(err('saveOrder', { kind: 'single', memberId: everyone[5], items: [{ item: 'Ceinture', variant: 'M', price: 15 }] }), /size for Ceinture/);
assert.match(err('saveOrder', { kind: 'single', memberId: everyone[5], items: [{ item: 'Cotisation de l\'année', price: 50 }] }), /only for the whole troupe/);
assert.match(err('saveOrder', { kind: 'troupe', title: 'Chemise', price: 15, memberIds: everyone }), /scout by scout/);
assert.match(err('saveOrder', { kind: 'troupe', title: 'Cotisation de l\'année', price: '', memberIds: everyone }), /Enter a price/);
c3('saveOrder', { kind: 'troupe', title: 'Cotisation de l\'année', price: 50, memberIds: everyone }, setup3.token);
mon = c3('saveOrder', { kind: 'single', memberId: everyone[5], items: [{ item: 'Prêt', price: 12 }, { item: 'Short', variant: 'XL', price: 15 }] }, setup3.token);
const shortLine = mon.lines.find(l => l.orderId === mon.id && l.item === 'Short');
assert.match(err('updateLine', { id: shortLine.id, variant: '125' }), /size for Short/);
c3('updateLine', { id: shortLine.id, variant: 'L' }, setup3.token);
// New items later.
mon = c3('saveCatalogItem', { name: 'Foulard', sizes: '', price: '8', scope: 'both' }, setup3.token);
assert.ok(mon.catalog.some(c => c.name === 'Foulard' && c.price === 8 && !c.sizes.length));
mon = c3('saveCatalogItem', { name: 'Pull', sizes: 'S, M, L', price: '20', scope: 'single' }, setup3.token);
assert.deepStrictEqual(mon.catalog.find(c => c.name === 'Pull').sizes, ['S', 'M', 'L']);
assert.match(err('saveCatalogItem', { name: 'pull', sizes: '', price: '', scope: 'single' }), /already in the list/);
const pull = mon.catalog.find(c => c.name === 'Pull');
mon = c3('saveCatalogItem', { id: pull.id, name: 'Pull', sizes: 'S,M,L,XL', price: '22', scope: 'single' }, setup3.token);
assert.strictEqual(mon.catalog.find(c => c.name === 'Pull').price, 22);
mon = c3('deleteCatalogItem', { id: pull.id }, setup3.token);
assert.ok(!mon.catalog.some(c => c.name === 'Pull'));
assert.strictEqual(c3('state', {}, setup3.token).money.catalog.length, 6);   // deleted items do not come back

// Delete the single order with its lines.
mon = c3('deleteOrder', { id: single }, setup3.token);
assert.strictEqual(mon.lines.filter(l => l.orderId === single).length, 0);
assert.strictEqual(ok(s3.api({ action: 'saveSettings', payload: { currency: 'LBP' }, token: setup3.token })).settings.currency, 'LBP');

// Setup with a bad link still creates the chief and reports the problem.
const f4 = makeFakes({ source: source, standalone: true });
const s4 = loadServer(code, f4);
const setup4 = ok(s4.api({ action: 'setup', payload: { name: 'Chief', pin: '1234', sourceUrl: 'nope' } }));
assert.ok(setup4.token && setup4.importError);

console.log('All server tests passed.');

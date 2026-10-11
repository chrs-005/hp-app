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
assert.strictEqual(call('setup', { name: 'X', pin: '1111' }).ok, false);

// Admin state.
const st = ok(call('state', {}, token));
assert.strictEqual(st.me.role, 'admin');
assert.strictEqual(st.members.filter(m => m.active).length, 50);
assert.strictEqual(st.members.filter(m => m.leader).length, 11);
assert.strictEqual(st.attendance.length, 50 * 6 + 20);
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
assert.match(call('login', { name: lead.name, pin: '000000' }).error, /Wrong name or PIN/);
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
for (let i = 0; i < 5; i++) call('login', { name: lead.name, pin: '999999' });
assert.match(call('login', { name: lead.name, pin: DEMO_PIN }).error, /Too many/);
assert.match(call('state', {}, 'bad.token.x').error, /AUTH/);

// Cancelled meeting blocks reporters.
ok(call('setMeeting', { date: '2026-10-24', cancelled: true, note: 'Holiday' }, token));
const bisonLead = st.reporters.find(r => r.patrols.join() === 'Bison');
const bTok = ok(call('login', { name: bisonLead.name, pin: DEMO_PIN })).token;
const bison = st.members.find(m => m.patrol === 'Bison');
assert.match(call('saveAttendance', { entries: [{ date: '2026-10-24', memberId: bison.id, phase: 'wed', status: 'coming' }] }, bTok).error, /no meeting/);

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

// Fresh install: leader accounts come with 6-digit PINs.
const f2 = makeFakes({ source: source });
const s2 = loadServer(code, f2);
const c2 = (a, p, t) => ok(s2.api({ action: a, payload: p, token: t }));
const t2 = c2('setup', { name: 'Chief', pin: '1234' }).token;
assert.match(s2.api({ action: 'createLeaderAccounts', payload: {}, token: t2 }).error, /No patrol leaders/);
c2('syncSource', { url: SOURCE_URL, apply: true }, t2);
const made = c2('createLeaderAccounts', {}, t2);
assert.strictEqual(made.created.length, 11);
assert.ok(made.created.every(x => /^\d{6}$/.test(x.pin)));
c2('login', { name: made.created[0].name, pin: made.created[0].pin });

console.log('All server tests passed.');

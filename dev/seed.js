// Demo data for the local mock backend and the node tests. Not deployed.
// Demo logins (local only): every account below uses PIN 1234.
(function (root) {
  'use strict';

  const DEMO_PIN = '1234';
  const DEMO_ADMIN = 'Chief Demo';
  const SOURCE_URL = 'https://docs.google.com/spreadsheets/d/DEMO_FILE_ID_0000000000000/edit';

  function seedDemo(api) {
    const call = (action, payload, token) => {
      const r = api({ action: action, payload: payload, token: token });
      if (!r.ok) throw new Error(action + ': ' + r.error);
      return r.data;
    };
    const token = call('setup', { name: DEMO_ADMIN, pin: DEMO_PIN }).token;
    const sync = call('syncSource', { url: SOURCE_URL, apply: true }, token);

    // Leader accounts get random PINs; set them all to the demo PIN.
    const leaders = call('createLeaderAccounts', {}, token);
    leaders.reporters.filter(r => r.role !== 'admin').forEach(r => {
      call('saveReporter', { id: r.id, name: r.name, pin: DEMO_PIN, role: r.role, patrols: r.patrols }, token);
    });

    // Six past Saturdays with a few patterns worth flagging.
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const saturdays = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10'];
    const members = sync.members;
    const reasons = ['Sick', 'Family trip', 'Exams', 'Birthday party', 'Football match'];
    saturdays.forEach((date, w) => {
      const entries = [];
      members.forEach((m, i) => {
        let sat = rand() < 0.82 ? 'present' : 'absent';
        if (sat === 'present' && rand() < 0.12) sat = 'late';
        if (i === 3 && w >= 3) sat = 'absent';          // missed the last 3
        if (i === 17 && w >= 4) sat = 'absent';         // missed the last 2
        if (i === 30 && w % 2 === 0) sat = 'absent';    // low percentage
        if (i === 41 && w !== 1) sat = 'absent';        // very low percentage
        let wed = sat === 'absent' ? (rand() < 0.5 ? 'out' : 'noreply') : sat === 'late' ? 'late' : 'coming';
        if (sat === 'absent' && rand() < 0.25) wed = 'coming';   // said yes, did not come
        const reason = reasons[Math.floor(rand() * reasons.length)];
        entries.push({ date: date, memberId: m.id, phase: 'wed', status: wed, reason: wed === 'out' || wed === 'late' ? reason : '' });
        entries.push({ date: date, memberId: m.id, phase: 'sat', status: sat, reason: sat !== 'present' && rand() < 0.6 ? reason : '' });
      });
      call('saveAttendance', { entries: entries }, token);
    });

    // Next Saturday: Wednesday answers are coming in for two patrols.
    const next = members.filter(m => m.patrol === sync.patrols[0] || m.patrol === sync.patrols[1]).map((m, i) => ({
      date: '2026-10-17', memberId: m.id, phase: 'wed',
      status: i % 6 === 0 ? 'out' : i % 7 === 0 ? 'late' : 'coming', reason: i % 6 === 0 ? 'Travelling' : i % 7 === 0 ? 'Music class' : '',
    }));
    call('saveAttendance', { entries: next }, token);

    // Camps: Camp Patrouille happened, Camp Noël answers are coming in.
    const evs = call('state', {}, token).events;
    call('saveEvent', { id: evs[0].id, title: evs[0].title, date: '2026-10-02', endDate: '2026-10-04' }, token);
    call('saveEvent', { id: evs[1].id, title: evs[1].title, date: '2026-12-27', endDate: '2026-12-30' }, token);
    call('saveAttendance', { entries: members.map((m, i) => ({
      date: evs[0].id, memberId: m.id, phase: 'sat', status: i % 9 === 4 ? 'absent' : 'present', reason: i % 9 === 4 ? 'Sick' : '',
    })) }, token);
    call('saveAttendance', { entries: members.slice(0, 15).map((m, i) => ({
      date: evs[1].id, memberId: m.id, phase: 'wed', status: i % 5 === 2 ? 'out' : 'coming', reason: i % 5 === 2 ? 'Travelling' : '',
    })) }, token);
    // Money: a troupe order (Prêt) half handed out, and one scout's single order.
    let mon = call('saveOrder', { kind: 'troupe', title: 'Prêt', price: 12, memberIds: members.map(m => m.id) }, token);
    const pret = mon.lines.filter(l => l.orderId === mon.id);
    call('setLines', { ids: pret.filter((l, i) => i % 3 !== 0).map(l => l.id), given: true }, token);
    call('setLines', { ids: pret.filter((l, i) => i % 4 !== 1).map(l => l.id), paid: true }, token);
    mon = call('saveOrder', { kind: 'single', memberId: members[4].id, items: [
      { item: 'Chemise', variant: 'S', price: 25 }, { item: 'Ceinture', variant: '110', price: 8 }] }, token);
    const single = mon.lines.filter(l => l.orderId === mon.id);
    call('setLines', { ids: single.map(l => l.id), paid: true }, token);
    call('updateLine', { id: single[1].id, given: true }, token);
    return { token: token };
  }

  root.HPSeed = { seedDemo: seedDemo, DEMO_PIN: DEMO_PIN, DEMO_ADMIN: DEMO_ADMIN, SOURCE_URL: SOURCE_URL };
  if (typeof module !== 'undefined') module.exports = root.HPSeed;
})(typeof window !== 'undefined' ? window : globalThis);

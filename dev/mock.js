// Local preview backend: runs the real Code.gs in the browser against fake Google
// services, saved in localStorage. Loaded by Index.html only when it is NOT served
// by Apps Script. Add ?demo to the URL to start with demo data, ?reset to wipe.
(function () {
  'use strict';
  const base = document.currentScript.src.replace(/[^/]+$/, '');
  const KEY = 'hp.mockdb';

  function load(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  window.HPMockReady = (async function () {
    await load('gas-fakes.js');
    await load('sample-source.js');
    await load('seed.js');
    const code = await fetch('Code.gs', { cache: 'no-store' }).then(r => r.text());
    const params = new URLSearchParams(location.search);
    if (params.has('reset')) { localStorage.removeItem(KEY); localStorage.removeItem('hp.token'); }

    const fakes = window.HPFakes.makeFakes({
      source: window.HP_SAMPLE_SOURCE,
      load: () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } },
      save: (s) => localStorage.setItem(KEY, JSON.stringify(s)),
    });
    const server = window.HPFakes.loadServer(code, fakes);

    if (params.has('demo') && server.api({ action: 'bootstrap' }).data.needsSetup) {
      window.HPSeed.seedDemo(server.api);
      fakes.persist();
    }

    window.HPMock = {
      api(req) {
        return new Promise((resolve) => setTimeout(() => {
          const res = server.api(JSON.parse(JSON.stringify(req)));
          fakes.persist();
          resolve(JSON.parse(JSON.stringify(res)));
        }, 200 + Math.random() * 300));
      },
    };
  })();
})();

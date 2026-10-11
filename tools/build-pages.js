// Builds the installable app (PWA) for GitHub Pages into docs/.
//   node tools/build-pages.js
// docs/config.js is created once and then left alone: it holds the Apps Script link.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');
const src = fs.readFileSync(path.join(root, 'apps-script', 'Index.html'), 'utf8');

const head = [
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">',
  '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '<meta name="apple-mobile-web-app-title" content="HP App">',
  '<script src="config.js"></script>',
  '<script>window.HP_PWA = true;</script>',
].join('\n');
if (!src.includes('<!--PWA-HEAD-->')) throw new Error('Marker <!--PWA-HEAD--> missing in Index.html');
const html = src.replace('<!--PWA-HEAD-->', head);
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, 'index.html'), html);

const configPath = path.join(docs, 'config.js');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, [
    '// Link of the Google Apps Script web app (Deploy → Manage deployments → Web app URL, ends with /exec).',
    "window.HP_API_URL = '';",
    '// Link people open to install the app (this GitHub Pages site).',
    "window.HP_APP_URL = '';",
    '',
  ].join('\n'));
}

// The service worker's cache name changes with the page, so phones pick up updates.
const version = crypto.createHash('sha1').update(html).digest('hex').slice(0, 10);
fs.writeFileSync(path.join(docs, 'sw.js'), fs.readFileSync(path.join(__dirname, 'sw.template.js'), 'utf8').replace('__VERSION__', version));
fs.writeFileSync(path.join(docs, '.nojekyll'), '');
console.log('docs/ built, version', version);

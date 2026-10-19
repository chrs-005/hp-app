# HP App — Troupe Griffons

Attendance app for the Saturday réunions. The CP and SP fill the **Presence** tab on
Wednesday (who is coming) and on Saturday (who came). The chief sees **Stats** and manages
everything in **Admin**. It installs on iPhone and Samsung like a normal app (PWA) and opens
full screen on a laptop.

How it is built:

```
docs/          the installable app (GitHub Pages). docs/config.js holds the server link.
apps-script/   the server, run for free by Google Apps Script. Data is saved in a Google Sheet.
  Code.gs          saves attendance, logins, reads the members file from Google Drive
  Index.html       the app screen (source of docs/index.html)
  appsscript.json  turns on the Drive service (to read the .xlsx members file)
tools/         node tools/build-pages.js  → rebuilds docs/ from apps-script/Index.html
dev/           local testing only (fake Google services, made-up names)
```

No scout data is stored in this repository. Everything lives in the chief's Google account.

## 1. Server (Google Apps Script), one time

Use the Google account that owns the members file in Drive. You don't create any sheet: the app
reads your members file, and creates its own small sheet **"HP App – Database (do not edit)"** for the
answers (an .xlsx can't be written to). It moves that sheet into the same Drive folder as your members file.

1. Open <https://script.google.com/create> (a new Apps Script project opens).
2. Rename it **HP App** (click "Untitled project" at the top).
3. ⚙️ **Project Settings** → tick **Show "appsscript.json" manifest file in editor**.
4. Back in the editor (`< >`):
   - `appsscript.json` → replace everything with [apps-script/appsscript.json](apps-script/appsscript.json)
   - `Code.gs` → replace everything with [apps-script/Code.gs](apps-script/Code.gs)
   - **+ → HTML**, name it `Index`, paste [apps-script/Index.html](apps-script/Index.html)
   - 💾 Save
5. **Deploy → New deployment** → ⚙️ **Web app** → Execute as **Me**, Who has access **Anyone** → **Deploy**
   → **Authorize access** (Google says "unverified app": **Advanced → Go to … (unsafe)** → **Allow**).
6. Copy the **Web app URL** (ends with `/exec`).

## 2. Connect the installable app

Edit [docs/config.js](docs/config.js) on GitHub (✏️ pencil icon), paste the `/exec` link, **Commit changes**:

```js
window.HP_API_URL = 'https://script.google.com/macros/s/XXXXXXXX/exec';
```

GitHub Pages updates within a minute.

## 3. First use (chief)

1. Open the app link, create the **chief account** (name + PIN + link of the members file in Drive).
   The scouts load right away.
2. The app stays connected to that file: when you edit it in Drive, the change shows in the app
   within 5 minutes (or tap ↻ to check now). Admin shows the connection status.
3. **Admin → CP & SP → Create accounts with PINs**. CP = names written in **green**, SP = names in **red**
   in the members file; each gets a 4-digit PIN for his own patrol. Press **Send**
   next to each one (WhatsApp, SMS…) — PINs are shown only once.

## 4. Install on the CP and SP phones

Open the app link:

- **iPhone (Safari)**: Share ⬆️ → **Add to Home Screen** → Add.
- **Samsung / Android (Chrome or Samsung Internet)**: ⋮ menu → **Install app** / **Add to Home screen**.

Then sign in with full name + PIN (asked only once).

## Members file rules

- One row with the patrol names side by side, the names under each patrol, birth years in a column
  on the left, a "Total" row at the end.
- **Green name = CP, red name = SP** (each gets an account and fills his own patrol).
- Edit the same file in Drive and the app follows automatically. To switch to another file or tab:
  **Admin → Members list** → new link / tab → **Preview** → **Import**.
  Scouts removed from the file keep their history. A scout is recognised by his name.

## Tabs

- **Presence** — *Réunions* (Saturdays) or *Camps & events* (Camp Patrouille, Camp Noël, Camp Pâques,
  Camp d'Été, plus any special event the chief creates). Two moments for each: **They said** (the answer
  before — by Wednesday for réunions) and **They came** (what really happened).
- **Presence → Overview / Stats** (chief) — the grid like the Excel register, and the statistics.
- **Progression** — CPs and chiefs: étapes to Promesse, Seconde classe, Première classe, Troupe Raider, and badges. The chief edits the lists (one per line).
- **Money** and **Admin** — chief only. SPs do not have access to the app.

## Rules

- Red glow: missed 2 réunions in a row. Percentages are judged from the 5th réunion: amber under 75 %,
  red under 60 %. Change them in **Admin → Rules & season**. "Late" counts as came.
- The chief can cancel a réunion: **Home** or **Presence → No réunion this Saturday?** — everyone sees it: it does not count anywhere.

## Updating

- Server: edit in Apps Script, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**
  (the link stays the same).
- App: edit `apps-script/Index.html`, run `node tools/build-pages.js`, commit, push.
  Also paste the new Index.html in Apps Script if you use the Apps Script link directly.

## Forgot a PIN

- CP / SP: chief → **Admin → Accounts → Edit** → new PIN.
- Chief: in the **HP App – Database (do not edit)** sheet, tab `reporters`, type `plain:1234` in your `pinHash` cell,
  sign in with 1234 (it is re-encrypted automatically), then change it.

## Testing on a computer

```bash
node dev/test-server.js
```

```bash
python -m http.server 8765
```

Open <http://localhost:8765/apps-script/Index.html?demo> (made-up demo data, logins in `dev/seed.js`).

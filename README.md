# The Cutline

A self-hosted production OS for a sign shop, presented as a proper web
app: left sidebar navigation (Dashboard / Jobs / Quotes / Calendar /
Materials / Equipment), a KPI dashboard, and a clean light-first design
(dark mode included) in the spirit of ShopVox / Printavo — without the
subscription.

The core model: a **job** travels through a fixed pipeline —
**Design → Print → Laminate → Cut → Install → Complete** — and you advance
it stage by stage. The stage is a structural property you set explicitly
(click a stage step, or drag the card on the kanban board), never
something inferred from a title.

The dashboard adds a full weather center (current conditions, next 12
hours, 7-day outlook with install jobs pinned to their day and
bad-weather flags), a pipeline distribution bar, today's board, quick
notes, and shop tasks. Frontend files are `static/app.js` +
`static/theme.css`; every render guards missing data, so no stray
"undefined" ever shows up in the UI.

## Run it in under a minute

Needs Python 3.9+ and pip. No other services required — data lives in a
local SQLite file (`dashboard.db`) that's created automatically the first
time you run it.

```bash
cd signshop-dashboard
pip install -r requirements.txt
python3 app.py
```

Then open **http://localhost:5000** (or `http://<your-server-ip>:5000` from
another device on your network).

## Keeping it running (self-hosted, always-on)

The dev server above works fine for trying it out, but for actually running
this on a shop floor box day to day, use a real process manager so it
survives reboots and restarts if it crashes.

**Option A — systemd (Linux box/mini PC):**

```ini
# /etc/systemd/system/dashboard.service
[Unit]
Description=Production Dashboard
After=network.target

[Service]
WorkingDirectory=/path/to/signshop-dashboard
ExecStart=/usr/bin/python3 app.py
Restart=always
User=youruser

[Install]
WantedBy=multi-user.target
```

Then: `sudo systemctl enable --now dashboard`

**Option B — a production WSGI server** instead of Flask's built-in dev
server (recommended once more than one person is using it):

```bash
pip install gunicorn
gunicorn -w 2 -b 0.0.0.0:5000 app:app
```

**Windows:** see `setup-autostart.ps1` in this folder — registers the app
to auto-start on login and opens the firewall port in one step.

## What's in the box

- **Job board (the main event)** — each job has a customer, a job name, a
  substrate, a due date, an optional install date, and a priority. It sits
  at exactly one pipeline stage at a time: Design, Print, Laminate, Cut,
  Install, or Complete. Click any stage pip on a job card to jump it
  straight there — moving a job forward (or back) is a deliberate click,
  never a guess from text. Filter the board by stage using the tabs across
  the top (each stage tab shows its live job count).
- **Quoting** — build quotes with real sign-shop line items: width × height
  × qty × $/sqft (or flat-price lines), tax, live totals. Track status
  (draft → sent → accepted/declined); accepting a quote creates the job in
  one click and links them (Q-0007 → WO-0031). Print a clean customer-ready
  quote straight from the browser.
- **Calendar view** — the 🗓 toggle shows a month grid of due dates (orange)
  and installs (teal), with ⚠ on forecast bad-weather days. Click any chip
  to open the job.
- **Search** — one box filters the board (list and kanban) by job name,
  customer, WO number, or assignee.
- **Printable work orders** — "Print ticket" in the job detail panel prints
  a shop-floor sheet: specs, dates, substrate, notes, and the checklist
  with tick boxes.
- **CSV export** — flip the ticket header and hit "export jobs.csv" for a
  full dump of the jobs table (spreadsheet-ready).
- **Customer autocomplete** — the customer field suggests every customer
  you've entered before, across jobs and quotes.
- **Kanban view** — hit the "▦ Kanban" toggle on the tab row to switch the
  board to true kanban columns (one per stage). Drag a card into another
  column to move the job; click a card to open its details. Your last-used
  view is remembered.
- **Job details, notes & checklists** — click any job (in either view) to
  open its detail panel: freeform job notes, an "assigned to" field so
  everyone knows whose plate it's on, and a per-job checklist ("order 3
  sheets ACM", "confirm permit"). Cards show the assignee and checklist
  progress (☑ 2/5) at a glance.
- **Substrates + batching** — every job can carry a substrate tag (ACM,
  Coroplast, Aluminum, PVC, Acrylic, Banner, Vinyl, Magnetic, MDO, Other).
  A second filter row shows only the substrates currently on the board;
  click one to see just those jobs, or hit **Batch by material** to group
  the whole board by substrate — so same-material jobs run back to back
  with one printer load and one set of cutter settings.
- **Aging indicator** — each card shows how long it's been sitting at its
  current stage ("3d in Print") and turns red at 5+ days, so stuck jobs
  surface themselves instead of hiding mid-pipeline.
- **Hold flag** — the ⏸ button on a card marks a job "waiting on material".
  Held jobs go dashed-amber, sink below active jobs at the same stage, and
  are flagged on Today's board, so blocked work never masquerades as
  runnable work.
- **Materials inventory** — a sidebar card tracking on-hand stock per
  material (sheets, rolls, linear ft, pcs) with a reorder point. Anything
  at or below its reorder point gets flagged and floats to the top; +/−
  buttons log usage and received stock in one click.
- **7-day outlook** — daily forecast card in the sidebar. Any day flagged
  rain/snow/storms/high wind is marked. If a job's install date lands on
  one of those days, a warning shows right on the job card and on Today's
  board — so a bad-weather install doesn't sneak up on you.
- **Today's board** — any job due or installing today (or overdue), plus
  any shop task due today, merged into one glance.
- **Shop tasks** — a small flat list in the sidebar for things that aren't
  tied to a specific job: supplier calls, shop errands. No stage, no
  category — just a title, an optional due date, and priority.
- **Equipment log** — tracks last service date and a service interval per
  machine, flags anything due within 7 days, with a pulse bar showing how
  close it's getting. Comes pre-seeded with your GFP 363TH laminator.
- **Weather strip** — live conditions for your shop's location via
  Open-Meteo (no API key needed), plus a shop-relevant callout when
  conditions matter (cold snaps for vinyl adhesion, wind for banner
  installs, heat for print curling). Change the location in Settings
  (gear icon, top right).
- **Quick notes** — the pinned strip right under the header. No category
  or due date, just type and hit Post. Check a note off (✓) and it moves
  into the collapsible "things you didn't forget" tally below instead of
  vanishing.
- **Flippable ticket header** — click any corner mark on the header to
  flip it over and see a running tally: open jobs, overdue, installs this
  week, equipment due for service. Click a corner again (or the back
  itself) to flip it back.
- **Google Calendar card** — currently a placeholder. See below for what's
  involved in wiring it up for real.

## Data and settings

- `dashboard.db` — SQLite database (jobs + shop tasks + equipment +
  materials + quick notes). Back this file up if you care about the
  history. Existing databases are migrated in place on startup (the new
  substrate/hold/aging columns are added automatically). Note: the
  older flat `tasks` table from earlier versions is preserved as-is under
  "Shop tasks" — nothing is deleted or migrated automatically.
- `config.json` — shop name, location name, and lat/lon for weather. Created
  automatically on first run; edit directly or through the Settings modal
  in the UI.

## Connecting Google Calendar (next step, not yet built)

This needs a small OAuth flow since Calendar access requires the user (you)
to explicitly grant access — it can't be done with a static API key. At a
high level, when you're ready:

1. Create a project in Google Cloud Console, enable the Calendar API, and
   create an OAuth client ID (type: "Desktop app" or "Web application"
   depending on how you're hosting this).
2. Add a `/auth/google` route that redirects to Google's consent screen,
   and a callback route that stores the resulting refresh token (in
   `config.json` or a small `tokens.json`, not committed anywhere public).
3. Add a background job (or an on-demand button) that reads/writes events
   using the stored token via the `google-api-python-client` library —
   pushing each job's install date to the calendar as an event, and
   optionally pulling calendar changes back to update `install_date`.

The `install_date` field on every job already exists for exactly this —
it's not overloaded with anything else, so syncing it to a calendar event
later is a clean one-to-one mapping.

## Extending it

The Flask routes in `app.py` are small and flat on purpose — `jobs`,
`tasks`, `equipment`, and `notes` tables, plain REST endpoints, no ORM.
Easiest things to add next as your workflow firms up:
- A `job_id` foreign key on shop tasks, if you find yourself wanting to
  attach a sub-checklist to a specific job rather than tracking it purely
  by stage.
- Linking jobs to materials, so moving a job past Print auto-decrements
  the sheet count it consumed.
- Multi-user login if more than one person needs to use this.

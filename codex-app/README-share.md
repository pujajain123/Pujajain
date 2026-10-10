# Umami Studios dashboard

## Open in Claude Code

Open this project folder in Claude Code:

`/Users/shubhamjain/Documents/ChatGPT/Umami dashboard project`

The project contains the dashboard source (`index.html`, `app.js`, `portal-updates.js`, `styles.css`), the imported rope inventory snapshot (`rope_inventory_data.json`), and a browser workspace export (`umami-workspace-data-2026-10-08.json`).

Recent portal updates add Rope, Fabric and Powder Color inventory flows, staff-attributed order and stock entries, and a WhatsApp monthly-report draft for +91 98336 28272. The report view can save a monthly schedule preference, but this static browser-only app cannot deliver unattended messages. That needs a server-side scheduler, shared server storage and WhatsApp Business API credentials. The WhatsApp action opens a prefilled message for review and sending.

## Transfer browser data

The included JSON file is a point-in-time export from the local dashboard browser on 8 October 2026. It contains the workspace's orders and operations, production tracker, rope inventory data, and any product photos saved in that browser. Claude Code can inspect this file alongside the app source.

The local dashboard and the Vercel site store browser data separately. Export from the Vercel site separately if you need that browser's data too. These exports are snapshots; they do not create live sync between browsers or users.

## Run locally

From this folder, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8000` in a browser.

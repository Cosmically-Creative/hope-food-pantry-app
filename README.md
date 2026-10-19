# Hope Volunteer

Volunteer shift signup for Hope Food Pantry in Sioux Center, Iowa.

Copyright (C) 2026 Hope Food Pantry

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

**This is not ready for a public launch, and it is not ready for real volunteer records.** Phase 1A has public browsing, individual signup, cancellation, queued email, and coordinator sign-in for events, one-off shifts, rosters, and cancellation. A coordinator can add a walk-in, mark attendance, and move a signup from a shift roster. A volunteer can switch shifts from their private link. An active weekly template fills shifts for the next eight weeks. A coordinator can add, change, or end a weekly template, and can remove a cancelled person, a finished empty shift, an ended template, or an event that is off the public list and already empty. A confirmed signup can receive a reminder 48 hours before the shift and again 2 hours before, and can turn reminders off without cancelling. A coordinator can download a roster for one shift, one event, or a local date range. A coordinator can import a contact list, download it, use a saved contact when adding a walk-in, and add a saved contact to an open shift. A coordinator can set the two reminder times, the reply-to address, how many months to keep a signup, and the wording on the privacy page. After 1:00 AM Central Time, signups older than that many months lose their name and contact details in this app. After 2:30 AM Central Time, the app saves a database backup on this computer. A container can run that same app on this computer, on port 3020, without opening it to the network. This is not a public launch. Around 1:00 AM in each event's time zone, the app adds any missing weekly shifts for the next eight weeks, once that local day. Development prints mail in the server log. It does not send real email.

## Current step

| Step | State |
| --- | --- |
| Configuration, database, time zones, fallback brand, fake seed | Done |
| Public event and shift pages | Done |
| Individual signup with capacity and duplicate checks | Done |
| Cancel your own signup from its private link | Done |
| Confirmation and cancellation email | Done |
| Coordinator sign-in, events, one-off shifts, roster, and cancellation | Done |
| Add a walk-in from a shift roster | Done |
| Mark attendance on a shift roster | Done |
| Move a signup to another shift | Done |
| Switch your own signup to another shift | Done |
| Manage other signups from one private link | Disabled; requires a separate verified identity flow |
| Add weekly shifts for the next eight weeks | Done |
| Add, change, or end a weekly template | Done |
| Remove a cancelled person, a finished shift, an ended template, or an empty hidden event | Done |
| Reminder emails, 48 hours and 2 hours, with a way to stop them | Done |
| Download a roster for a shift, an event, or a date range | Done |
| Import and download a contact list | Done |
| Set reminder times, reply-to, privacy wording, and retention months | Done |
| Refill weekly shifts around 1:00 AM in each event time zone | Done |
| Remove personal details after the saved retention period | Done |
| Save a database backup after 2:30 AM Central Time | Done |
| Run the app in Docker and check that a restart keeps the database | Ready for review |

The core tables for later steps are already in `migrations/001_init.sql`. Behavior for those tables is not built yet. While this database only holds fake seed data, the schema can still change by replacing that first migration. After a database you care about has applied it, the app refuses to start if the file is edited. Add a new numbered file instead.

## Decisions still open

Do not treat this repository as an approved privacy policy or an approved operating setup.

- [ ] **D1.** SMTP2GO is the email provider. The pantry verifies the sender and the reply-to.
- [ ] **D2.** Whether a group signup is essential. A shared email can already sign up more than one person on the same shift. Each person takes one spot and gets their own confirmation and private link. The same person, matched by name and email, cannot take a second spot on that shift. `group_size` stays 1. Group signup still needs its own decision: who the reservation is for, how minors work, what happens when the count changes, and who receives mail.
- [ ] **D3.** The pantry approves privacy wording, minor and guardian requirements, and retention periods, including copies and exports.
- [ ] **D4.** The pantry confirms the coordinator list, who owns the administrator account, and the recovery contact.
- [ ] **D5.** Configure production Turnstile keys and the allowed hostname.
- [ ] **D6.** The host owner confirms the offsite backup destination, who owns it, the recovery target, and a restore test.

## TODO(Phase 2)

SignUpGenius shift import. The people export is a contact list, and that list can be imported. A shift import still needs an export that includes the slot, date, and time, plus a rule for someone who is already signed up for that shift.

Password login, waitlists, volunteer accounts, SMS, analytics, and payments are out of scope.

## Local setup

Requires Node 22.

```bash
cp .env.example .env
npm install
npm test
npm run seed
```

`npm run dev` serves the site on `127.0.0.1` at `BASE_URL` (from `.env`, `http://127.0.0.1:3000`). It is loopback only. Stop it with Ctrl+C.

Open `/` for the weekly pantry schedule. `/e/weekly-pantry` is the same seeded event. `/privacy` is the unapproved privacy notice. `/healthz` returns `{"ok":true,"database":"ok"}` and nothing else. Volunteer names, emails, and notes are not on the public list. A shift shows how many spots are filled, such as 3/5 spots filled. A shift with space left uses a soft green label. A full shift uses a soft red label.

An open shift has a signup form. It asks for one person. Another person can use the same email and takes another spot. The same person cannot take a second spot. It asks for a parent or guardian when the volunteer is under 18. The form needs JavaScript because of the Turnstile check. Wait a few seconds after the page loads before submitting. The confirmation page shows a private link and says a confirmation email is on the way. That page works without JavaScript. Cancel this signup there to open the spot again. A cancellation email is queued, and a confirmation that has not been sent yet is dropped. That person can sign up again once the cancellation is saved. Someone else can use the email while the first signup is still confirmed. A cancelled signup stays on that private page until the link expires. A private link controls only that signup. Use the separate link for each signup.

With `MAIL_DRIVER=console`, the development server tries to send queued mail every 30 seconds and prints each accepted message in its terminal. That is not delivery to a real inbox. `sent` means the driver accepted the message. A lost result is marked uncertain and is not sent again. SMTP2GO is the mail provider. Set `MAIL_DRIVER=smtp2go` and `SMTP2GO_API_KEY` to send through it. Postmark and SES remain available.

Coordinator sign-in is at `/login`. The first time the app starts with an empty coordinators table, it creates one administrator from `BOOTSTRAP_ADMIN_EMAIL`. The name on that account is Administrator. It does not create another account on later starts, and it does not change an account that is already there. Sign-in emails a link that expires in 15 minutes and works once. Opening the link does not sign you in. Use the button on that page. The link is printed in the development server log with the rest of the mail. There is no password.

After sign-in, `/admin` lists events, including events that are off the public list. A coordinator can add and edit an event, show or hide it, add and edit a one-off shift, read that shift's roster, cancel one signup, or cancel the shift. Cancelling keeps the roster. It does not delete the shift or the signup. A time, role, or location change emails the people who are signed up and replaces their private links. The old link stops working when that email is queued.

On an open shift, **Add a walk-in** records one person who is here. It takes one spot, uses the same person rule as the public form, and queues a confirmation email. The name stays off the public list. A full, cancelled, or ended shift does not take a walk-in.

On a confirmed signup, **Attended** and **No-show** record whether that person came. **Clear** removes the mark. The mark stays on the roster. It does not send email, and it does not change how many spots are open. A cancelled signup cannot be marked.

**Move to** puts that person on another open shift in the same event. The first shift gets its spot back and keeps the signup as cancelled. The other shift takes one spot. A change email is queued, and a reminder that is still waiting is dropped. The old private link stops working. The new link is in the change email. A full, cancelled, or ended shift cannot receive the person. A shift that already has that person cannot receive them again. Someone else at the same email can. A failed move leaves them on the original shift.

On the private signup page, **Switch to** does the same thing for the volunteer. The next page has the new link. A full, cancelled, ended, or unpublished shift is not offered. A switch is rejected if that name and email already occupy the destination shift. The destination list does not reveal which other shifts match those details. If the switch cannot be saved, the original signup stays.

Public switching permits 10 validated attempts per IP per 10-minute window and 5 per recipient per local calendar day (`DEFAULT_TZ`). Volunteer and guardian addresses share the same recipient counter; a shared address is counted once. These HMAC-keyed counters live in SQLite and survive link changes, new signup IDs, and restarts. A blocked request returns HTTP 429 with `Retry-After`, leaves the signup unchanged, and queues no email. Invalid origins, invalid proofs, and completed replays do not spend recipient allowances. Valid attempts that fail because a destination is full or unavailable still count. Viewing or cancelling a signup remains available when switching is limited. Coordinator roster moves use their authenticated workflow and are not subject to these public switch limits.

**Management link scope:** names and email addresses entered in a public form are unverified. Each private link authorizes only its own signup, including links from confirmation cookies, email, and guardian copies. Cross-signup listing, cancellation, and switching are disabled, and the old `/m/:token/also/...` routes return 404. This also applies to existing links. A future multi-signup view must verify identity separately.

**Add weekly shifts**, on a coordinator event page, fills the next eight weeks from that event's active weekly templates. Starting the app does the same thing for every event. A shift that is already on that date stays as it is, including a cancelled one, so the template cannot recreate it. A 9:00 shift stays 9:00 when daylight saving time changes. A local time that does not exist, or that happens twice, is skipped.

**Add a weekly template** saves a repeating role, day, and time. **Edit this template** changes later weeks only. Shifts already on the schedule keep their role, time, and number of spots. **End this template** stops later weeks from being added. It does not cancel shifts already listed, and it does not email anyone.

**Remove from roster** deletes a cancelled signup, including the name, email, and notes. A confirmed signup has to be cancelled first. **Remove this shift** deletes a cancelled or ended shift after the roster is empty. If that date came from a weekly template that is still active, the next weekly fill can add the date again. **Remove this template** deletes an ended template. The shifts stay on the schedule and are no longer tied to that weekly pattern. **Remove this event** asks for confirmation, then deletes that event and the shifts, weekly templates, and signups on it, including names and emails. An event on the public list comes off that list. It does not send email. Other events stay.

A reminder is queued at each saved time before a confirmed signup, while the shift has not started. The defaults are 48 hours before and 2 hours before. The check runs every five minutes. If the app was off and more than one reminder is already due, only the closest one is sent. A person who signs up after an earlier reminder was due does not get that missed reminder. A reminder is not sent after the shift starts. Changing the shift, moving the signup, or cancelling it drops a reminder that has not been sent yet. Mail that was already accepted cannot be recalled. **Stop reminder emails**, on the private signup page or in the reminder itself, turns reminders off for that signup. The signup stays. Confirmation, change, and cancellation emails still arrive. The reminder asks the person to use the link in the confirmation email to cancel. Mail sent to the reply-to address is read by the pantry.

**Download this roster**, on a shift, and **Download this event**, on an event, save a spreadsheet of the signups. **Download this date range**, on the coordinator page, uses each event's local shift date. The file includes cancelled signups and attendance. A cell that would be a spreadsheet formula is saved as text. The download is not cached. A copy on a coordinator's computer is outside this app, and the app does not delete it later.

**Contacts**, on the coordinator page, keeps a list of people. A confirmed signup is saved on this list. The name is split at the last space. A signup name with no space is saved with a hyphen as the last name. A different name is a separate contact, even when the email matches. The same name and email updates that contact. Cancelling the signup does not remove the contact. Saving someone here does not sign them up for a shift. **Import this list** reads a spreadsheet with First Name, Last Name, Email, and Phone, including the SignUpGenius people export. An Address column is ignored. The same name and email updates that person. A different name stays a separate person, even when the email matches. A different email stays a separate person, even when the name matches. A blank phone does not erase a phone already saved. Names are capitalized. A word that already mixes upper and lower case stays as written. A phone number with ten digits is saved with dashes, like 712-555-0100. A leading 1 is left off. Email addresses are stored in lowercase. Importing does not take a spot and does not send email. **Download contacts** saves that list. A cell that would be a spreadsheet formula is saved as text. A downloaded copy stays on the coordinator's computer. The signup retention job does not clear this list. The list is the contacts table in `app.db`. The list shows 20 people. **See more** shows the next 20 on this page, without returning to the top, and keeps a search. **Choose a name**, then choose the shift from **Shift**. That takes one spot and queues a confirmation email. A full, cancelled, or ended shift is not in that list, and a shift they are already on is not in that list. A shift that is not on the public list can still be chosen. **Remove** deletes that person from the list only. On an open shift, **Saved contact** fills a walk-in. The walk-in still takes one spot and queues a confirmation email. **Add a contact** saves one person who has not signed up. It does not take a spot and does not send email. The same name and email updates that person. A different name is saved separately, even with the same email. Typing a walk-in who is not on the list saves them here too.

**Settings**, on the coordinator page, saves the two reminder times, the reply-to address, the privacy-page wording, and how many months to keep a signup after the shift ends. The defaults are 48 hours, 2 hours, the reply-to address from the server configuration, a blank privacy notice, and 24 months. The two reminder times have to be different whole hours from 1 to 336. The month count is a whole number from 1 to 120. A blank privacy notice leaves the public page saying a notice is not approved yet. Saved wording is shown on `/privacy` as written. Saving it does not by itself make that wording an approved privacy policy. New mail uses the saved reply-to address. Mail already queued keeps the address it was given. The sending address stays in the server configuration.

Around 1:00 AM in an event's time zone, the app adds any missing shifts from that event's active weekly templates. It does this once for that local date. If 1:00 happens twice when the clocks change, the second hour does not add them again. If 1:00 does not exist that day, the fill runs once the local clock is past 1:00. A restart later that day still fills the date if it was missed. A date that already has a shift, including a cancelled one, stays as it is. Starting the app, and **Add weekly shifts**, still fill the schedule as well.

After 1:00 AM Central Time, once that local date, the app removes the name, email, phone, guardian, notes, and private link from each signup whose shift ended more than the saved number of months ago. The default is 24. The shift, the signup status, and attendance stay, so the count remains. The minor answer is cleared. A spreadsheet downloaded from an old shift leaves those personal cells blank. This changes the live database. It does not change a spreadsheet already on a coordinator's computer, a message already in someone's inbox, or an older database backup. Clearing a value does not promise that the old bytes are immediately gone from the disk. The contact list is separate. Clearing an old signup does not remove that person from the contact list.

Finished mail loses its recipient, subject, and body 30 days after it was sent, cancelled, or given up on. Mail that is still waiting after 30 days is cancelled and cleared, so it is not sent late. Mail for a signup is cleared in the same cleanup that removes that signup's details. A sign-in message is cleared once its link is used or expired. Every hour, the app clears those sign-in messages, finished mail past 30 days, expired sign-in sessions, used or expired sign-in links, and rate-limit counters older than about two days. Audit notes older than 24 months are deleted. Those notes are counts and ids. Starting the app runs this cleanup before it accepts requests. If 1:00 AM happens twice when the clocks change, the second hour does not run it again. A restart after 1:00 AM still runs it when that date was missed.

After 2:30 AM Central Time, once that local date, the app saves a copy of the database in the backups folder next to the live database. The copy is made with SQLite's backup tool, then stored as one ordinary database file, so it stays consistent even while the app is running. Copying `app.db` by itself is not a substitute. The app keeps 14 daily copies and 8 Sunday copies. A copy made before a signup is cleared still has the old details until that copy is old enough to be removed. These files stay on this computer. The app does not encrypt them and does not send them anywhere else. Offsite storage is still decision D6.

If 2:30 AM does not exist when the clocks spring forward, the backup runs once the local clock is past 2:30. A second check the same day does not save another copy. A failed backup leaves the older copies in place and tries again on the next check. A backup taken before a migration in production is a separate file and is not removed by this schedule. The coordinator page says when the newest daily copy was saved, or that it is behind.

`npm run seed` refuses to run when `NODE_ENV=production`. The people in the seed are fake and use `@example.invalid` addresses. The weekly template is stored. The seed command itself does not add those weekly shifts; starting the app does. Seeding again refuses until you delete the development database file.

`npm run sync-brand` copies `BRAND_SRC/tokens.css` and `fonts/` into `public/brand/`. The sibling website does not have that brand directory yet. A missing source keeps the bundled tokens and prints a warning. Font files are copied unchanged. No fonts are downloaded from Google.

## Configuration

`.env.example` lists every variable. The app reads them only through `src/config.ts`.

`BASE_URL` is the public origin, such as `http://127.0.0.1:3000` or `https://example.org`. `BASE_PATH` is an optional mount prefix, empty by default or `/volunteer` later. A path on `BASE_URL` is rejected so the prefix lives in one place. Trailing slashes are removed. Routes, assets, cookie paths, and future mail links all go through `src/url.ts`.

Production startup rejects:

- missing configuration
- `http://` or a local hostname in `BASE_URL`
- Cloudflare's documented Turnstile test keys
- `MAIL_DRIVER=console`
- missing credentials for SMTP2GO, Postmark, or SES when that driver is selected
- a session secret shorter than 32 characters, a placeholder, or a secret that does not look random

Development may use the console driver and the always-pass Turnstile test keys in `.env.example`. Those keys are not a launch setting. The console driver prints mail in the development server log and does not contact a provider. SMTP2GO is the provider for real mail. This copy of the app must not send real mail until `SMTP2GO_API_KEY` and a verified sender are configured on purpose.

`DATA_DIR` defaults to `/data`. Local development uses `./data`. The database file is `app.db` inside that directory.

`BOOTSTRAP_ADMIN_EMAIL` is the address used to create the first administrator, and only when no coordinator exists yet. The app does not overwrite an existing account. Password login is not built. `password_hash` stays empty.

## Time

`src/time.ts` uses `@js-temporal/polyfill`. Node 22 does not provide a stable Temporal API. The polyfill rejects a local time that falls in a daylight-saving gap or overlap instead of moving it.

Stored instants look like `2026-01-15T15:00:00.000Z`. Local dates stay `YYYY-MM-DD`. Local times stay `HH:MM`. Weekday `0` is Sunday. A 9:00 shift in `America/Chicago` stays 9:00 local in January and in July. The default zone is `America/Chicago`.

Shifts in this version must start and end on the same day. Overnight templates are later work. A coordinator can add, change, or end a weekly template. Ending it does not cancel shifts already on the schedule. The eight-week fill also runs around 1:00 AM in each event's time zone, once that local date. It still runs when the app starts and when a coordinator uses Add weekly shifts.

## Database

SQLite runs in WAL mode with foreign keys on. Migrations in `migrations/` are applied once, in order, at startup. Each applied file is stored with a SHA-256 checksum. A failed migration stops startup and rolls back that file. In production, a database that already has migrations is backed up with SQLite's backup API before a new migration runs. Copying the live `app.db` file by itself is not a consistent backup while WAL mode is on.

There is no cascade delete. A shift that still has signups cannot be deleted out from under the roster. A coordinator cancels a signup or a shift first. Removing a cancelled person, then an empty finished shift, is a separate step. Removing an ended template leaves its shifts in place. An event can be removed only when it is off the public list and nothing remains on it.

Confirmed signups have a partial unique index on shift, normalized email, and name, without regard to case. Normalization of the email is trim, Unicode normalize, and lowercase. Dots and plus-tags stay. A different person can use that email and takes their own spot. Anonymized rows clear the name and email, so they do not collide with that index. A minor who is not anonymized needs a guardian name and email. `group_size` cannot be anything but 1.

`reminders_sent.queued_at` means the reminder was queued. `sent_at` means a provider accepted it. Queueing mail is not delivery. A closer reminder that replaces an older overdue one is stored as not sent.

## Client IP and a future Caddy proxy

`TRUST_PROXY` defaults to `false`. Forwarding headers from the public internet are ignored, and the client address is the TCP peer.

Do not set `TRUST_PROXY=true`. Name the proxy:

- `loopback` when Caddy on the same machine connects to a non-Docker process on `127.0.0.1`
- the Compose subnet, `172.30.0.0/24`, when the app is in a container. The peer is the bridge gateway under Docker, or the container's own address under rootless Podman, and never `127.0.0.1` inside the container

With `TRUST_PROXY=false` behind a proxy, every visitor arrives from the proxy's address and shares one set of rate limits. Eleven sign-in requests in an hour would then lock out every coordinator. Production startup prints a warning when `TRUST_PROXY` is false and the app listens on `0.0.0.0`.

The app reads `X-Forwarded-For` only from that peer, and only when the header is a single IP. Caddy has to replace any client-supplied forwarding header. A list of addresses is ignored, because the left-most address can be forged if the proxy appends instead of replacing. `BASE_URL` decides https links. A client cannot turn on secure cookies by sending `X-Forwarded-Proto`.

## Docker

The image is built from this repository with `docker build -t hope-volunteer .`. It uses Node 22, compiles the app, keeps production packages, and runs as the image's `node` user, which is uid 1000. The database and backups live in `/data`. The image does not contain `.env`.

`compose.yaml` publishes `127.0.0.1:3020` to port 3000 inside the container. It sets production mode, `DATA_DIR=/data`, and `BIND_HOST=0.0.0.0` so the published port can connect. `npm run dev` stays on `127.0.0.1`. Compose reads the other settings from `.env`. The development `.env` in this project will not start the container, because production refuses the console mail driver, the Turnstile test keys, and an `http://` address.

Create the data directory before the first start and give it to uid 1000. Do not make it writable by everyone:

```bash
mkdir -p data
sudo chown 1000:1000 data
sudo chmod 700 data
```

Copy `.env.production.example` to `.env` on the server and fill in the SMTP2GO API key, Turnstile keys, public `https` address, and session secret. Protect the filled `.env` with `chmod 600 .env`. Then:

```bash
docker compose up -d
```

`http://127.0.0.1:3020/healthz` should return `{"ok":true,"database":"ok"}`. A restart keeps `./data`. Backups are written under `./data/backups` by that same user. Copying only `app.db` while the app is running is not a consistent backup. Restoring a saved copy is described in `scripts/restore-backup.md`. Sending those copies off this computer is still decision D6.

When Caddy is on the host and the app is in a container, `TRUST_PROXY` is the Compose subnet, not `loopback`. `compose.yaml` pins the network to `172.30.0.0/24` and sets `TRUST_PROXY=172.30.0.0/24`. Under Docker the peer is the gateway, `172.30.0.1`. Under rootless Podman 5 with pasta, the port forwarder connects from the container's own address on that network, such as `172.30.0.2`. Trusting the subnet covers both. Only this service is on that network, and the port is published on `127.0.0.1` only. Do not attach other containers to it. If that subnet is already used on the host, change the subnet, gateway, and `TRUST_PROXY` together. Check it once on the real host: send requests through Caddy from two clients and confirm one is not limited by the other's attempts. The Caddy snippets below stay on the host. They are not started by Compose. HTTPS ends at Caddy. The container does not obtain a certificate.

Gmail is not a mail driver. Production expects SMTP2GO.

```caddy
volunteer.example.org {
	request_body {
		max_size 65536
	}
	@private_links path /m/* /u/* /login/link/*
	log_skip @private_links
	reverse_proxy 127.0.0.1:3020 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto {scheme}
		header_up -X-Forwarded-Host
	}
}
```

For a `/volunteer` prefix, forward the path through to the app. Do not strip it if `BASE_PATH=/volunteer`.

```caddy
example.org {
	@private_links path /volunteer/m/* /volunteer/u/* /volunteer/login/link/*
	log_skip @private_links
	@volunteer path /volunteer /volunteer/*
	handle @volunteer {
		request_body {
			max_size 65536
		}
		reverse_proxy 127.0.0.1:3020 {
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
		}
	}
}
```

## Security and deployment checks

Every response has a Content Security Policy, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a `Permissions-Policy` that turns off camera, microphone, location, payment, and USB. When `BASE_URL` is https, responses also send `Strict-Transport-Security: max-age=31536000` for this host only. It does not use `includeSubDomains`, so other pantry subdomains are not affected.

The app limits request bodies to 64 KiB before parsing. Caddy examples apply the same limit. Rejected origins and rate-limited signup/login requests do not parse and redisplay submitted fields. Turnstile has a 10-second deadline; SMTP2GO, Postmark, and SES have 15-second deadlines. A mail timeout is an uncertain delivery, not an automatic resend. SES automatic retries are disabled to avoid duplicate sends after ambiguous failures.

Compose uses a read-only root filesystem, drops all capabilities, prevents privilege escalation, and limits the container to 512 MiB memory, one CPU, and 100 processes. `/data` remains writable and `/tmp` is a bounded temporary filesystem. Adjust resource limits using measured usage. The app runs as uid 1000. Local snapshots remain on the same disk and are not an offsite backup.

Before deployment, verify these on the actual host:

- Set `TRUST_PROXY` to the observed Docker bridge peer, then verify different clients have independent limits and forged forwarding headers cannot change their identity.
- Confirm the public HTTPS origin, real Turnstile hostname/action checks, and coordinator/volunteer mail delivery.
- Validate the Caddyfile before reloading it. The examples use [request_body](https://caddyserver.com/docs/caddyfile/directives/request_body) and [log_skip](https://caddyserver.com/docs/caddyfile/directives/log_skip). Do not enable debug logging or record bearer URLs in upstream/CDN logs. The skip rules protect matched access logs, not every possible diagnostic log.
- Restrict access to `.env`, `/data`, and backup copies. The app runs with umask `077`, so the database, its WAL files, and new backups are readable only by uid 1000. At startup it also sets `0600` on an existing database and backup files it owns. Select an offsite destination, protect its credentials, and restore a snapshot into a separate temporary database before relying on it.

## Brand

`public/brand/tokens.css` is the bundled fallback from the October 14, 2026 specification. `public/css/app.css` uses those variables. Lexend and Charm are named in the font stack and fall back to `system-ui` and `cursive` until OFL files are synced into `public/brand/fonts/`. Ink `#222` on yellow `#f9e194` is about 15.7:1.

## Host recovery

There is no web page that resets a coordinator. On the machine that holds the database, this revokes that person's sessions and unused sign-in links:

```bash
node --env-file=.env --import tsx scripts/recover-coordinator.mjs coordinator@example.invalid
```

If they cannot reach the old mailbox, replace the address and revoke the old sessions in the same step:

```bash
node --env-file=.env --import tsx scripts/recover-coordinator.mjs old@example.invalid --replace new@example.invalid
```

In the container, run the built copy. It uses the container's configuration and database, and the running app sees the change at once:

```bash
docker compose exec hope-volunteer node dist/recover-coordinator.js old@example.invalid --replace new@example.invalid
```

There is one administrator. The address set in `BOOTSTRAP_ADMIN_EMAIL` at the first production start becomes that account. Changing `.env` later does not change it. Use `--replace` to move the account to another address. Before the pantry's mailbox becomes the sign-in address, turn on 2-Step Verification for it: anyone who can read that inbox can sign in.

The command prints the coordinator id, not the address. It does not deactivate anyone. Deactivating coordinators in the browser is not built. Do not delete the last administrator without another one ready. The person then requests a new sign-in link at `/login`.

## What is still unverified

Real inbox delivery, a production host, and a public launch. The container was checked on this computer with a temporary database, separate from the development database: it starts, the weekly page loads, `/healthz` answers, a path prefix is included in that health address, and a restart keeps the database. The development settings were refused. This computer does not have the Docker daemon running, so that check used Podman. It has not been deployed. Decision D6 is still open. The console driver only prints mail. SMTP2GO is the selected provider and is not connected on this computer yet. Gmail is not connected. The privacy page is waiting on decision D3 and is not a privacy policy. A real Turnstile hostname check still needs the production keys from decision D5. Development uses Cloudflare's always-pass test keys. Those keys succeed with hostname `example.com` and no action, so the hostname and action checks apply to real keys. Coordinator sign-in is covered here with the console driver, not with a real inbox.

# POC: Nubitel in SAP C4C, with a SAP BTP customer view

Proof of concept for the design where:

```
SAP C4C  ──(mashup iframe)──▶  Nubitel agent app  ──(iframe)──▶  BTP lean view  ──▶  SAP C4C data
```

It answers the questions that decide whether the design works:

1. Does a three-layer iframe chain (C4C → Nubitel → BTP) render, and what do the
   frame permissions need to be?
2. Can each section of the customer view load on its own, so the agent sees the
   customer first instead of waiting for the whole panel?
3. Is the data safe: right customer only, no data in URLs, stale data dropped,
   no messages accepted from the wrong place?
4. Security option B only: Nubitel passes a signed token (phone number and the phone
   call activity's external ID) and the BTP view calls C4C itself. The view link is
   not public: opened directly it shows a locked screen.
5. Inside C4C: do the microphone, clipboard and Nubitel's login cookie still work,
   and does Nubitel survive C4C navigation?

Questions 1–4 are answered locally. Question 5 can only be answered in your real
C4C tenant (see `docs/TEST-CHECKLIST.md`, Stage 2).

## What's in the box

| Folder | What it is | Goes to production? |
|---|---|---|
| `btp-view/` | The BTP lean view: page + small Node server (locked screen, security headers, token API) | Yes, this is the build |
| `lib/` | Phone normalisation, signed tokens, C4C adapter (mock now; real OData mapping from `$metadata`) | Yes |
| `mock-nubitel/` | Stand-in for Nubitel: conversation list, token signing, browser checks | No, reference for Nubitel |
| `mock-c4c-host/` | Simulated C4C shell with switchable mashup settings | No, local testing only |
| `docs/MESSAGE-CONTRACT.md` | What Nubitel must send and receive | Hand to Nubitel |
| `docs/C4C-ODATA.md` | The C4C technical user, the External ID, open-in-C4C links, data mapping | C4C administrator |
| `docs/TEST-CHECKLIST.md` | Local and real-tenant test cases | Test team |

No npm dependencies. Node 18 or later.

## Run locally (5 minutes)

```bash
npm start
```

Open **http://localhost:8081**. The three parts run on ports 8081 (C4C host),
8082 (Nubitel) and 8083 (BTP view), so the browser treats them as different
origins and applies real cross-origin rules.

Sign in to the mock Nubitel first. **Local demo users** (they exist nowhere else):
`james.theng` or `nur.aina`, password `local-demo-only`. The session cookie is
`HttpOnly; Secure; SameSite=None; Partitioned`, the session ends after 30 minutes
without activity, and **Sign out** makes the view forget every customer it held.
The deployed copy on Vercel has its own demo users: see `docs/DEPLOY.md`.

Try the conversations on the left; each one exercises a case:

| Conversation | Shows |
|---|---|
| Jenna Hopkins | Happy path, found through the phone call activity's external ID |
| Kumar Singh | Slow sections |
| June Wong | Two contacts share the number: the agent picks one |
| Ali Hassan | Last sales order fails, the rest still load |
| Mei Ling Tan | No sales order, no tasks |
| +60 11-5555 0000, +60 18-222 9999 | Unknown caller: add to an existing contact, or create a new one (popups) |

Also try the **refresh icon** (top right of the view), **Rapid switch test**,
**Token expiry test**, the **Browser checks** buttons, and the mashup settings at the
top of the C4C host. Open http://localhost:8083 directly: it shows a locked screen.

### Automated test

```bash
npm i -D playwright && npx playwright install chromium
CACHE_TTL_SECONDS=12 npm start   # in one terminal (short saved-copy life so expiry can be tested)
npm test                         # in another: 66 checks, screenshots in local/screens/
npm run test:adapter             # 45 checks of the real C4C adapter against a fake C4C (no tenant, no servers needed)
npm run test:links               # 10 checks that the open-in-C4C links match real C4C links byte for byte
```

Once a C4C technical user exists, `npm run check:c4c` asks for the tenant address, user and
password (hidden) and prints PASS or FAIL for every object the view reads. It shows no customer
data: see `docs/C4C-ODATA.md`.

On Windows PowerShell set the variable first: `$env:CACHE_TTL_SECONDS = '12'`.

### What the agent sees

A compact panel for a narrow side pane: refresh icon top right; customer with open-in-C4C
icons (contact, account); **last sales order** and each **open task** with their own
open-in-C4C icon (tasks are shown with due dates, overdue in red); **recommended products of
the current month** in a table that scrolls inside its own section. An unknown number gets
its own screen with two choices, each opening a popup (greyed out with a note when
`ALLOW_WRITES` is off). Data is mock until `DATA_SOURCE` is set to `c4c`: see
`docs/C4C-ODATA.md`.

### Saved copy and Refresh

The view keeps what it loaded per chat in page memory, so switching back to a
chat shows it at once without asking C4C again. **Refresh** (the icon top right)
reloads the chat. The mock Nubitel's "C4C queries" counter shows the saving.
Lifetime: `CACHE_TTL_SECONDS` (default 300, `0` = off). Details:
`docs/MESSAGE-CONTRACT.md`.

Note: ports on `localhost` are different *origins* but the same *site*, so the
session-cookie check always passes locally. Run it on real domains.

## Deploy: GitHub, Vercel and BTP trial

Step-by-step for the POC setup (mock Nubitel on Vercel, view on a BTP trial,
added to C4C as a mashup): see **`docs/DEPLOY.md`**. The `api/` folder and
`vercel.json` are the Vercel version of the mock Nubitel.

## Deploy to SAP BTP (Cloud Foundry)

1. Edit `manifest.yml`: Nubitel domain, C4C tenant URL, technical user.
2. `cf login` to your subaccount and space, then `cf push`.
3. Set secrets outside the manifest:
   ```bash
   cf set-env c4c-lean-view TOKEN_SECRET "<long random string>"
   cf set-env c4c-lean-view C4C_PASSWORD "<technical user password>"   # only for DATA_SOURCE=c4c
   cf restage c4c-lean-view
   ```
4. `mock-nubitel` (second app in the manifest) is optional: deploy it to test
   the C4C mashup before Nubitel's build is ready. Give the mock Nubitel the
   same `TOKEN_SECRET` if you test Option B.

**FRAME_ANCESTORS must include both Nubitel's domain and your C4C tenant**
(`https://<tenant>.crm.ondemand.com`). Browsers check every frame in the chain.

## Connect to real C4C data

The adapter in `lib/c4c-adapter.js` is written against the test tenant's `$metadata` (the
standard service and the custom recommendation service) and checked with a fake C4C. The
full guide, including the text to send the C4C administrator, is **`docs/C4C-ODATA.md`**:

1. A C4C **technical user** with read access to the objects the view shows, and its secret
   in Kyma (you create it, so the password never passes through a chat or a file).
2. `npm run check:c4c` lists every object the user can read (PASS or FAIL).
3. `DATA_SOURCE=c4c`. Decide `ALLOW_WRITES` on purpose: it lets agents create contacts and
   save numbers, which is written but not yet tried against a tenant.

How the customer is found: Nubitel sends the **External ID of the C4C phone call activity**.
The view looks that activity up (`C4C_ACTIVITY_FIELD`, default `ID`), takes its contact, and
falls back to the phone number if the activity is not found. Recommendations are the current
month's snapshot from the custom service (`C4C_RECO_FALLBACK_LATEST` shows the newest earlier
month on a test tenant that has none). The open-in-C4C icons are built from real C4C links
(`lib/c4c-links.js`).

For production, replace the basic-auth technical user with the BTP Destination
service (OAuth or certificate), and keep credentials out of app settings.

## Security built into the POC

* `frame-ancestors` CSP on both apps: only approved hosts can embed them.
* Strict CSP on the view: own scripts and styles only, no inline code.
* postMessage checked on both sides: exact origin, and source must be the
  parent or child frame.
* No customer data in URLs, browser storage or cookies. Rendered with
  `textContent` only (no HTML injection).
* Option B: HMAC-signed token, 60-second life, account derived from the token
  on the server, per-token request limit, audit log with masked phone numbers.
* The view's address is not public: opened outside the agent application it shows a
  locked screen. C4C credentials live only on the BTP server, never in the browser.

## Not in the POC

* AI coach (later phase).
* Writing to C4C beyond the unknown-caller screen (create a contact, save a number). Even
  that is off unless `ALLOW_WRITES=true` and has not been tried against a tenant yet.
* Production key management (asymmetric token keys, key rotation), BTP
  Destination service, monitoring.

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
```

On Windows PowerShell set the variable first: `$env:CACHE_TTL_SECONDS = '12'`.

### What the agent sees

A compact panel for a narrow side pane: refresh icon top right; customer with open-in-C4C
icons (contact, account); **last sales order**; **open tasks** (due dates, overdue in red);
**recommended products of the current month** in a table that scrolls inside its own
section. An unknown number gets its own screen with two choices, each opening a popup.
Data is mock until the OData mapping is filled in: see `docs/C4C-ODATA.md`.

### Saved copy and Refresh

The view keeps what it loaded per chat in page memory, so switching back to a
chat shows it at once without asking C4C again. **Refresh** (next to "Open in C4C")
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

Set `DATA_SOURCE=c4c` and the `C4C_*` variables. Before that, confirm the
queries in `lib/c4c-adapter.js` against your tenant's metadata:
`https://<tenant>.crm.ondemand.com/sap/c4c/odata/v1/c4codataapi/$metadata`.
Each query is marked `TODO confirm`. In particular:

* **Phone lookup**: C4C usually stores formatted numbers. Use a normalised
  phone field if your tenant has one, or add an extension field.
* **Recommended items**: no standard OData entity. Point
  `RECOMMENDED_ITEMS_PATH` at your custom object or report.
* **Technical user**: read-only, only the objects above.

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
* Option A: C4C credentials stay on Nubitel's server, never in the browser.

## Not in the POC

* AI coach (later phase).
* Writing anything back to C4C (the view is display only).
* Production key management (asymmetric token keys, key rotation), BTP
  Destination service, monitoring.

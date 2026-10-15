# Deploy: GitHub → Vercel (mock Nubitel) + BTP trial (lean view) → C4C mashup

Order matters: deploy the BTP view first (you need its URL for Vercel), then
Vercel, then come back and give the BTP view the Vercel URL.

Keep `DATA_SOURCE=mock` on both. Personal Vercel and BTP trial accounts are not
company-controlled: no C4C credentials or real customer data there.

---

## 1. Push the project to GitHub

The project is already a git repository with a first commit.

1. On github.com, create a **new, private, empty** repository
   (no README, no .gitignore), e.g. `c4c-nubitel-btp-poc`.
2. In a terminal, inside the unzipped project folder:

   ```bash
   git remote add origin https://github.com/<your-username>/c4c-nubitel-btp-poc.git
   git branch -M main
   git push -u origin main
   ```

   If asked for a password, use a GitHub personal access token
   (Settings → Developer settings → Personal access tokens), or sign in
   with GitHub Desktop / VS Code instead.

---

## 2. Deploy the BTP lean view to the BTP trial

Prerequisites: Cloud Foundry CLI (`cf`), and Cloud Foundry enabled in your
trial subaccount with a space (the trial "dev" space is fine).

1. Find your API endpoint in the BTP cockpit → subaccount → Overview
   (e.g. `https://api.cf.ap21.hana.ondemand.com`).
2. In the project folder:

   ```bash
   cf login -a <api-endpoint>
   cf push c4c-lean-view
   ```

   (`cf push c4c-lean-view` deploys only the view, not the optional mock-nubitel app in `manifest.yml`.)
3. Note the route `cf push` prints, e.g.
   `https://c4c-lean-view-<random>.cfapps.ap21.hana.ondemand.com`.
   Check `https://<route>/health` returns `{"ok":true,"source":"mock"}`.

You will set its environment in step 4, once you have the Vercel URL.

---

## 3. Deploy the mock Nubitel to Vercel

1. **Edit `vercel.json`** before importing: replace
   `REPLACE-WITH-TENANT` with your C4C tenant host, so the line reads e.g.
   `frame-ancestors 'self' https://my123456.crm.ondemand.com`. Commit and push:
   ```bash
   git commit -am "Set C4C tenant in frame-ancestors" && git push
   ```
2. vercel.com → **Add New → Project → Import** your GitHub repository.
   Leave Framework as **Other** and Root Directory as the repo root.
   `vercel.json` already sets everything else.
3. **Environment variables** (Project → Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `VIEW_URL` | your BTP route from step 2, with trailing `/` |
   | `FRAME_ANCESTORS` | `https://<tenant>.crm.ondemand.com` |
   | `HOST_ORIGIN` | `https://<tenant>.crm.ondemand.com` |
   | `TOKEN_SECRET` | a long random string (same value goes to BTP) |
   | `DATA_SOURCE` | `mock` |

   Redeploy after adding them (Deployments → … → Redeploy).
4. **Turn off Deployment Protection** for production
   (Project → Settings → Deployment Protection), or Vercel shows a login page
   inside the C4C iframe.
5. Use the **production** URL, `https://<project>.vercel.app`, everywhere.
   Preview URLs change on every deploy.

---

## 4. Point the BTP view at Vercel and C4C

Settings in `manifest.yml` are re-applied on every `cf push`, so put the
addresses there (not in `cf set-env`, which the next push would overwrite).
Only the secret goes in `cf set-env`, because it is not in the manifest.

1. In `manifest.yml`, under `c4c-lean-view` → `env`, set:
   ```yaml
   MESSAGE_ORIGINS: https://<project>.vercel.app
   FRAME_ANCESTORS: https://<project>.vercel.app,https://<tenant>.crm.ondemand.com
   C4C_UI_URL: https://<tenant>.crm.ondemand.com
   ```
2. Set the secret and redeploy:
   ```bash
   cf set-env c4c-lean-view TOKEN_SECRET "<same value as Vercel>"
   cf push c4c-lean-view
   git commit -am "Point BTP view at Vercel and C4C" && git push
   ```

Quick check: open `https://<project>.vercel.app` directly in a browser.
The mock Nubitel should load and show the BTP view on the right; click
Jenna Hopkins. (It loads standalone because `'self'` is allowed.)

---

## 5. Add it to C4C as a mashup

In C4C (as an admin, in the adaptation mode your tenant uses):

1. Create a **URL mashup** (or HTML mashup) pointing to
   `https://<project>.vercel.app/`.
2. Place it on the screen where agents will work (ideally an area that stays
   loaded while agents move around C4C), and publish.
3. Open that screen and run **Stage 2** of `docs/TEST-CHECKLIST.md`:
   Microphone, Clipboard, Session cookie buttons, navigation, narrow pane.

If the mashup area is blank: open the browser console (F12). A
`frame-ancestors` error names which frame refused to load and which origin
is missing from its list.

---

## Keeping it running

* BTP trial apps can be stopped automatically and trials expire: run
  `cf apps` and `cf start c4c-lean-view` before each test session.
* Every `git push` to `main` redeploys Vercel automatically. The BTP view
  redeploys only when you run `cf push c4c-lean-view` again.

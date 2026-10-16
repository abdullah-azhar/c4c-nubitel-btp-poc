# POC test checklist

Run each test in **Chrome and Edge** (and Safari if any agents use Mac).
Stage 1 is local. Stage 2 is the one that matters: real C4C tenant, real domains.

Record: Pass / Fail / Notes.

## Stage 1: local (all automated by `npm test`)

| # | Test | Expected | Result |
|---|---|---|---|
| L1 | Open http://localhost:8081 | C4C host shows Nubitel, Nubitel shows the BTP view. Diagnostics: "Nubitel loaded inside C4C". | |
| L2 | Open http://localhost:8083 directly in a browser | A "locked" screen (403), no app and no data. | |
| L3 | Click **Jenna Hopkins** | Customer name appears first; last sales order, open tasks and the recommendations table fill in with grey placeholders until ready. Refresh icon top right. | |
| L4 | Look at the recommendations | Title shows the current month and year; the table scrolls inside its own section and the header stays put. | |
| L5 | Click the open-in-C4C icons (contact, account, order, task) | Each opens the right object in a new C4C tab. | |
| L6 | Click **Ali Hassan** | "Last sales order" shows "Could not load" + Retry. Tasks and recommendations load normally. | |
| L7 | Click **Mei Ling Tan** | "No sales orders yet" and "No open tasks" (empty, not error). | |
| L8 | Click **June Wong** | "2 contacts share this number" with a Select button each; picking one loads that account. | |
| L9 | Click **+60 11-5555 0000** | "Unknown caller" screen with two options and no popup yet. | |
| L10 | Choose **Add to an existing contact**, search "siti", pick one, Save | Popup on top; Save stays disabled until a contact is picked; after saving the customer loads. | |
| L11 | Click **+60 18-222 9999**, choose **Create a new contact** | Popup asks for last name and account, rejects a bad email, shows the call number read-only; Esc closes it without saving; after creating, the new customer loads. | |
| L12 | Click **Rapid switch test** | Ends on Jenna Hopkins with only her data. Footer shows "stale dropped" > 0. | |
| L13 | Click **Token expiry test** | The view still loads: it asks Nubitel for a new token after the first call is refused. | |
| L14 | Forged, missing or another customer's token to `/api` | 401 / 403. | |
| L15 | Open http://127.0.0.1:8081 (not an approved host) | Nubitel area stays blank: framing refused by CSP. | |
| L16 | Choose "rebuilt (reloads Nubitel)", click Accounts | Diagnostics flags "Nubitel reloaded … calls and chats would drop". | |
| L17 | Open Jenna, open Mei, switch back to Jenna | Jenna appears at once with no placeholders and no data calls; footer shows "cache: hit". | |
| L18 | Open Ali, switch away and back | Only "Last sales order" is asked again; footer shows "cache: partial". | |
| L19 | Press the **refresh icon** | Label shows "Updating…" then "Updated just now"; everything is loaded again. | |
| L20 | Wait past `CACHE_TTL_SECONDS`, switch back | The chat is loaded from C4C again. | |
| L21 | Open http://localhost:8081 before signing in | Only the Nubitel sign-in card shows; no conversations. | |
| L22 | Sign in with a wrong password, then correctly (`james.theng` / `local-demo-only`) | Generic error for the wrong one; after the right one the agent name and a session clock (about 30:00) show. | |
| L23 | Reload the page, or choose "rebuilt (reloads Nubitel)" and click Accounts | Still signed in; no second sign-in. | |
| L24 | Open a customer, then press **Sign out** | Back to the sign-in card; the view is empty and its saved customers are gone (footer "0 saved"). | |
| L25 | Leave the session idle past its limit, then click | Returns to sign-in with "Your session expired". | |
| L26 | Start with writes off (`ALLOW_WRITES=false npm start`, PowerShell: `$env:ALLOW_WRITES = 'false'`), click **+60 11-5555 0000** | Both options are greyed out and a note says saving contacts is turned off. Not covered by `npm test`, which runs with writes on. | |

## Stage 2: real C4C tenant (the decisive tests)

Setup: deploy `c4c-lean-view` and `mock-nubitel` to BTP (`cf push`), then add
the mock Nubitel URL to C4C as a mashup. Later, repeat with the real Nubitel.

| # | Test | How | Expected | Result |
|---|---|---|---|---|
| C1 | Nesting renders in C4C | Open the C4C screen with the mashup | Nubitel and BTP view both visible, no blank frames | |
| C2 | Microphone | Click **Microphone** in the mock Nubitel | PASS. If FAIL: C4C mashup iframe lacks `allow="microphone"` → voice calls cannot work inside C4C. | |
| C3 | Clipboard | Click **Clipboard** | PASS. If FAIL: copying suggested replies (later phase) blocked. | |
| C4 | Session cookie | Click **Session cookie** | PASS. If FAIL: third-party cookies blocked → Nubitel login may not stay signed in inside C4C. Ask Nubitel how they handle this (partitioned cookies, token login). | |
| C5 | Navigation keeps Nubitel alive | Start a call or chat, move between C4C screens and back | Call and chat continue; Nubitel does not reload. | |
| C6 | Section loading on real C4C data | Set `DATA_SOURCE=c4c`, open chats for real test customers | Customer first, sections fill independently; note timings from the view's footer. | |
| C7 | Phone format | Test numbers stored in different formats in C4C | All found. | |
| C8 | Open in C4C | Click each icon: contact, account, last sales order, task | Each opens the right object in a new C4C tab (C4C asks to sign in first if the agent is not). | |
| C9 | Narrow pane | Resize the mashup pane / browser window | View stays readable; tiles wrap. | |
| C10 | Session timeout | Leave idle past C4C and Nubitel timeouts | Clear sign-in prompt, no silent blank panel. | |
| C11 | Sign-in inside the C4C mashup | Open the mock Nubitel in C4C, sign in (Chrome, then Edge, then Safari) | Signed in and stays signed in. If the sign-in card says the browser blocked the cookie, note which browser: that is the third-party cookie risk. | |
| C12 | Session survives C4C navigation and reload | Sign in, move between C4C screens, reload C4C | Still signed in, no second sign-in. | |
| C13 | Sign out clears the view | Open a customer, press **Sign out** | Sign-in card shows and the view is empty. Sign in again and open the same customer: it loads from C4C again. | |
| C14 | Technical user | `npm run check:c4c` with the technical user | `9/9 objects readable`, every line PASS. A FAIL line says which right is missing (`docs/C4C-ODATA.md` 1.6). | |
| C15 | Found through the phone call activity | Open a conversation whose External ID is the ID of a real C4C phone call activity, ideally one whose contact has a different number saved | The activity's contact is shown. Pod log: `customer via=activity`. | |
| C16 | Falls back to the phone number | Open a conversation whose External ID matches no activity but whose number is saved on a contact | That contact is shown. Pod log: `customer via=phone`. | |
| C17 | Customer outside the usual territory | Open a conversation for a contact the technical user's team would not normally own | Found, with the same data a normal user sees. If it shows as unknown, the user has a data restriction (`docs/C4C-ODATA.md` 1.4). | |
| C18 | Read-only | With `ALLOW_WRITES: "false"`, open an unknown caller | Options greyed out, note says saving is turned off, nothing is sent to C4C. | |
| C19 | First real write (only when writes are wanted) | `ALLOW_WRITES: "true"`; save a number on a throwaway contact in the test tenant | The number is in Mobile (or Phone if Mobile is taken), never over an existing number; C4C shows the technical user as the changer. | |

## Exit criteria for the POC

* C1, C2, C5 pass: the nested design is viable for voice + WhatsApp.
* C4 passes, or Nubitel confirms a login approach that works inside C4C.
* C6 shows the customer header in under ~1 second and all sections in under ~3 seconds on typical data.
* Decision recorded: Option B (signed token). Nubitel confirms that the External ID it keeps for a conversation is the C4C phone call activity ID (C15).

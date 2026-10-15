# POC test checklist

Run each test in **Chrome and Edge** (and Safari if any agents use Mac).
Stage 1 is local. Stage 2 is the one that matters: real C4C tenant, real domains.

Record: Pass / Fail / Notes.

## Stage 1: local (all automated by `npm test`)

| # | Test | Expected | Result |
|---|---|---|---|
| L1 | Open http://localhost:8081 | C4C host shows Nubitel, Nubitel shows the BTP view. Diagnostics: "Nubitel loaded inside C4C". | |
| L2 | Click **Jenna Hopkins** (Option A) | Customer name appears first; tiles and items fill in one by one with grey placeholders until ready. | |
| L3 | Click **Ali Hassan** | "Last order" shows "Could not load" + Retry. Other sections load normally. | |
| L4 | Click **Mei Ling Tan** | "No open quote" and "No open tickets" (empty, not error). | |
| L5 | Click **+60 11-5555 0000** | "Customer not found". | |
| L6 | Click **June Wong** | "2 matching contacts" with an Open link for each. | |
| L7 | Click **Rapid switch test** | Ends on Jenna Hopkins with only her data. Footer shows "stale dropped" > 0. | |
| L8 | Switch Security option to **B**, click Jenna | Footer shows "mode: B (token)"; all sections load. | |
| L9 | Forged or missing token to `/api` | 401. | |
| L10 | Open http://127.0.0.1:8081 (not an approved host) | Nubitel area stays blank: framing refused by CSP. | |
| L11 | Choose "rebuilt (reloads Nubitel)", click Accounts | Diagnostics flags "Nubitel reloaded … calls and chats would drop". | |
| L12 | Open Jenna, open Mei, switch back to Jenna | Jenna appears at once with no grey placeholders; "C4C queries" does not go up; footer shows "cache: hit". | |
| L13 | Open Ali, switch away and back | Only "Last order" is asked again (queries +1); footer shows "cache: partial". | |
| L14 | Press **Refresh** | Label shows "Updating…" then "Updated just now"; queries go up by 5. | |
| L15 | Wait past `CACHE_TTL_SECONDS`, switch back | The chat is loaded from C4C again. | |

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
| C8 | Open in C4C | Click the button | Opens the right account in a new C4C tab. | |
| C9 | Narrow pane | Resize the mashup pane / browser window | View stays readable; tiles wrap. | |
| C10 | Session timeout | Leave idle past C4C and Nubitel timeouts | Clear sign-in prompt, no silent blank panel. | |

## Exit criteria for the POC

* C1, C2, C5 pass: the nested design is viable for voice + WhatsApp.
* C4 passes, or Nubitel confirms a login approach that works inside C4C.
* C6 shows the customer header in under ~1 second and all sections in under ~3 seconds on typical data.
* Decision recorded: Option A or B.

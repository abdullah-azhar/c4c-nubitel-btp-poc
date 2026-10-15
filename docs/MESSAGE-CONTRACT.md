# Message contract: Nubitel ↔ BTP lean view

This is what Nubitel needs to build on their side. The mock Nubitel in this POC
(`mock-nubitel/public/nubitel.js`) is a working reference implementation.

Nubitel only has to do three things:

1. When the agent opens a conversation, get a **signed token** from its own backend
   and post `conversation.open` with that token.
2. Answer `view.refresh` with `conversation.open` (`refresh: true`) and a new token.
3. Answer `view.needToken` with `token.update` and a new token.

The view then calls C4C itself through BTP. Nubitel never calls C4C for this view.

## How it fits together

```
SAP C4C (mashup iframe)
  └─ Nubitel agent app                      https://<nubitel-domain>
       └─ BTP lean view (iframe)            https://<btp-route>
```

* Nubitel embeds the BTP view with a plain URL. **No phone numbers or customer
  data in the URL.** Everything goes in by `window.postMessage` and the token.
* Nubitel always posts with an exact target origin (the BTP view's origin),
  never `"*"`.
* The view only accepts messages whose `event.source` is its parent and whose
  `event.origin` is in `MESSAGE_ORIGINS` (Nubitel's origin).
* Every message has `v: 1` (contract version) and a `type`.
* **The view link is not a public page.** Opened directly in a browser (top-level
  navigation) the BTP server answers `403` with a "locked" screen. It is only handed
  out when the browser loads it as a frame (`Sec-Fetch-Dest: iframe`). Data is only
  returned for a valid token, so a copied link or a guessed phone number gets nothing.

## Recommended iframe tag (inside Nubitel)

```html
<iframe src="https://<btp-route>/"
        title="C4C customer view"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"></iframe>
```

## Messages from Nubitel to the view

### `conversation.open`
Sent every time the agent opens or switches to a conversation.

| Field | Type | Notes |
|---|---|---|
| `type` | `"conversation.open"` | |
| `v` | `1` | |
| `conversationId` | string | Nubitel's conversation ID. |
| `channel` | `"whatsapp"` \| `"voice"` | |
| `token` | string | Required. Short-lived signed token, see below. |
| `refresh` | boolean | Optional. `true` after the agent pressed Refresh: the view ignores what it saved for this chat and loads everything again. |

### `token.update`
Answer to `view.needToken`. Replaces the token without resetting the screen.
`{ v: 1, type: "token.update", conversationId, token }`

### `conversation.close`
Optional. Clears the view and its saved copy when a conversation is wrapped up.
`{ v: 1, type: "conversation.close", conversationId }`

## Messages from the view to Nubitel

| `type` | When | Fields |
|---|---|---|
| `view.ready` | View has loaded. Nubitel should (re)send `conversation.open` for the current chat. | none |
| `view.refresh` | Agent pressed the refresh icon. Answer with `conversation.open` with `refresh: true` and a **new** token. | `conversationId` |
| `view.needToken` | A call found the token expired (retry later in a long call, a popup left open). Answer with `token.update`. | `conversationId` |
| `view.contactSaved` | The agent saved the caller's number on an existing contact or created a contact (unknown-caller flow). For logging, or to update Nubitel's own display. | `conversationId`, `mode` (`update` \| `create`), `contactId`, `accountId` |
| `view.action` | Agent clicked an open-in-C4C icon. For logging only; the view opens the link itself. | `action`, `object` (`contact` \| `account` \| `order` \| `task`), `id`, `conversationId` |

Nubitel must check `event.origin === <BTP view origin>` and
`event.source === iframe.contentWindow` before acting on any of these.

## The token

Nubitel's **backend** (never the browser) signs a token per conversation:

```
token   = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload_part, TOKEN_SECRET))
payload = { cid, phone, ext, agent, iat, exp, jti }      exp - iat <= 60 seconds
```

| Claim | Meaning |
|---|---|
| `cid` | Nubitel's conversation ID |
| `phone` | The caller's number as received. C4C lookup normalises it (`lib/phone.js`). |
| `ext` | **External ID of the C4C phone call activity** for this conversation. Optional but recommended: the activity already points to the right contact, so a number shared by several contacts is not ambiguous. |
| `agent` | The agent's ID, for the audit log |
| `iat`, `exp`, `jti` | Issued-at, expiry (at most 60 s later), unique ID |

Reference: `lib/token.js` (`sign` and `verify`). The view sends it as
`Authorization: Bearer <token>` to its own `/api`. BTP takes the phone number and
external ID from the token, never from the browser, so a token can only read its own
customer. For production, switch to an asymmetric key (Nubitel signs with a private
key, BTP verifies with the public key) and agree key rotation.

## What the view asks C4C

1. **Who is on the line:** the phone call activity by `ext` first (when present),
   then the contact by phone number.
2. **Then, in parallel and each on its own:** the account's **last sales order**,
   its **open tasks**, and the **product recommendations of the current month and
   year** (the monthly snapshot, in the sales team's time zone).
3. **Only if the agent asks** (unknown caller): search contacts or accounts, and
   create a contact / save the number on a contact. Writes need `ALLOW_WRITES=true`
   and a C4C technical user that may write. The number saved is always the one on the
   token, never a value typed in the browser.

Every section has its own loading, empty and error state, its own timeout and Retry.
Answers for an earlier conversation are dropped.

## Saved copy and Refresh

The view remembers what it loaded for each chat, so switching back to a chat shows
it at once and C4C is not asked again.

* **Where:** the page's memory only. Nothing goes to localStorage, cookies or a
  server. It disappears when the page is closed or reloaded.
* **How long:** `CACHE_TTL_SECONDS` on the view (default 300 = 5 minutes, `0` turns it
  off). The last 20 chats are kept. `conversation.close` forgets that chat.
* **What is saved:** a customer that was found and any section that loaded (`ok` or
  `empty`). **Errors are never saved**, so a failed section is asked again next time.
  Unknown callers are never saved.
* **Refresh icon** (top right): forgets the saved copy of that chat and loads it all
  again. A label next to it shows how old the data is ("Updated 3 min ago").

The saved copy keeps customer data in the browser for up to the TTL. If security
requires no data at rest in the page, set `CACHE_TTL_SECONDS=0`.

## Phone numbers

Send the number as received; the C4C lookup normalises it (`lib/phone.js`):
`+60 12-345 6789`, `012-345 6789` and `0060123456789` all become `60123456789`.
Confirm with the SAP team which format C4C stores.

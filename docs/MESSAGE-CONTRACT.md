# Message contract: Nubitel ↔ BTP lean view

This is what Nubitel needs to build on their side. The mock Nubitel in this POC
(`mock-nubitel/public/nubitel.js`) is a working reference implementation.

## How it fits together

```
SAP C4C (mashup iframe)
  └─ Nubitel agent app                      https://<nubitel-domain>
       └─ BTP lean view (iframe)            https://<btp-route>
```

* Nubitel embeds the BTP view with a plain URL. **No phone numbers or customer
  data in the URL.** Everything goes in by `window.postMessage`.
* Nubitel always posts with an exact target origin (the BTP view's origin),
  never `"*"`.
* The view only accepts messages whose `event.source` is its parent and whose
  `event.origin` is in `MESSAGE_ORIGINS` (Nubitel's origin).
* Every message has `v: 1` (contract version) and a `type`.

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
| `conversationId` | string | Nubitel's conversation ID. Every later message for this chat carries it. |
| `channel` | `"whatsapp"` \| `"voice"` | |
| `mode` | `"push"` \| `"pull"` | `push` = Option A, `pull` = Option B |
| `token` | string | Option B only. Short-lived signed token, see below. |

### `section.update` (Option A only)
One message per section, sent as soon as that section's C4C call returns.
Do not wait for all sections.

| Field | Type | Notes |
|---|---|---|
| `type` | `"section.update"` | |
| `conversationId` | string | Must match the open conversation, or the view drops it. |
| `section` | `"customer"` \| `"quote"` \| `"order"` \| `"tickets"` \| `"items"` | |
| `status` | `"ok"` \| `"empty"` \| `"not_found"` \| `"multiple"` \| `"error"` | `not_found` and `multiple` apply to `customer` only. |
| `data` | object \| array \| null | Shapes below. |

Data shapes:

```js
customer (ok):        { accountId, contactId, name, account, owner }
customer (multiple):  [ { accountId, contactId, name, account }, ... ]
quote:                { id, status, items, value }
order:                { id, date, status, value }
tickets:              { count, latest }
items:                [ { product, qty, uom }, ... ]
```

Order of calls: look up the customer by phone first, send `customer`, then fire
the other four C4C calls **in parallel** using the account ID and send each one
as it returns.

### `conversation.close`
Optional. Clears the view when a conversation is wrapped up.
`{ v: 1, type: "conversation.close", conversationId }`

## Messages from the view to Nubitel

| `type` | When | Fields |
|---|---|---|
| `view.ready` | View has loaded. Nubitel should (re)send `conversation.open` for the current chat. | — |
| `view.retry` | Agent clicked Retry on a section (Option A). Re-run that one C4C call. | `conversationId`, `section` |
| `view.action` | Agent clicked "Open in C4C". For logging only; the view opens the link itself. | `action`, `conversationId`, `accountId` |

Nubitel must check `event.origin === <BTP view origin>` and
`event.source === iframe.contentWindow` before acting on any of these.

## Option B token

Nubitel's **backend** (never the browser) signs a token per conversation:

```
token   = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload_part, TOKEN_SECRET))
payload = { cid, phone, agent, iat, exp, jti }      exp - iat <= 60 seconds
```

Reference: `lib/token.js` (`sign` and `verify`). The view sends it as
`Authorization: Bearer <token>` to its own `/api`. BTP takes the phone number
from the token, never from the browser, so a token can only read its own
customer. For production, switch to an asymmetric key (Nubitel signs with a
private key, BTP verifies with the public key) and agree key rotation.

## Phone numbers

Send the number as received; the C4C lookup normalises it (`lib/phone.js`):
`+60 12-345 6789`, `012-345 6789` and `0060123456789` all become `60123456789`.
Confirm with the SAP team which format C4C stores.

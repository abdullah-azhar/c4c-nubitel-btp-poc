# C4C OData: technical user access and data mapping

Test tenant: `https://my335945.crm.ondemand.com`
Services: standard `/sap/c4c/odata/v1/c4codataapi/` and the custom recommendation service
`/sap/c4c/odata/cust/v1/duopharma_snapshotproductrecommendation/`

The BTP view reads C4C through OData with **one technical user**, never with an agent's own
login. This page covers:

1. [The technical user](#1-the-technical-user): what to create, what it must be allowed to read, how to prove it works
2. [How the view finds the customer](#2-how-the-view-finds-the-customer): the External ID of the phone call activity, the phone number, the open-in-C4C icons
3. [Data mapping and what we learned](#3-data-mapping-and-what-we-learned)

**Where things stand.** The real adapter (`createC4CAdapter` in `lib/c4c-adapter.js`) is
written against this tenant's `$metadata` and data. Every request it builds was replayed
read-only against the tenant (all HTTP 200), and `npm run test:adapter` checks the mapping
with a fake C4C. It has **not run end to end yet**, because that needs the technical user.
Until `DATA_SOURCE` is set to `c4c`, everything runs on mock data.

---

## 1. The technical user

### In short

1. The C4C administrator creates the user (send them the text in [1.5](#15-what-to-ask-the-c4c-administrator)).
2. You run `npm run check:c4c`. Every line must say PASS ([1.6](#16-prove-it-works-before-switching)).
3. You put the user and password into Kyma yourself ([1.7](#17-give-the-credentials-to-the-view)).
4. You switch `DATA_SOURCE` to `c4c` ([1.8](#18-switch-from-mock-to-c4c)).
5. You test with real callers, then decide about writes ([1.9](#19-writes-create-a-contact-save-a-number)).

### 1.1 Why a dedicated user

* Agents never see or type a C4C password. The browser only talks to the view's own server.
* The user gets only the rights the view needs. If the secret ever leaked, it could read a
  few objects and change nothing.
* Its password can be changed without touching any person's login.
* In C4C, anything the view creates or changes shows the technical user, not the agent. The
  agent is recorded in the BTP log (see [1.11](#111-data-protection-and-audit)).

Do not reuse a person's login.

### 1.2 How it signs in

Every call from the view to C4C carries the user and password (HTTP Basic, over HTTPS). So:

* The user **must be allowed to sign in with a password**, even if your people use single
  sign-on. A user that can only sign in through SSO does not work for this.
* The user must not be forced to change its password at the next sign-in, and no second
  factor may be required. If C4C asks for a new password at first sign-in, do that once in
  the browser first.
* Nothing is kept between calls. Only a write first asks C4C for a security token (and the
  cookie that goes with it) for that one call.

The view reads the credentials from the environment variables `C4C_USER` and `C4C_PASSWORD`,
which come from the Kyma secret `c4c-odata-credentials` ([1.7](#17-give-the-credentials-to-the-view)).

### 1.3 What it must be able to read

**Read only**, on all of these. The names in the last column are what `npm run check:c4c`
tests.

| What the agent sees | C4C object | OData entity set | Check line |
|---|---|---|---|
| Who is calling, the owner, contact search | Contacts | `ContactCollection` | Contacts |
| Account name, account search | Accounts (corporate) | `CorporateAccountCollection` | Accounts |
| Last sales order | Sales orders | `CustomerOrderCollection` | Sales orders |
| Open tasks | Tasks (activities) | `TasksCollection` | Tasks |
| Which contact the phone call activity belongs to | Phone calls (activities) | `PhoneCallCollection` | Phone calls |
| Owner's name | Employees | `EmployeeBasicDataCollection` (name only) | Employees |
| Product names in the recommendations | Products | `ProductCollection` | Products |
| Recommended products of the month | Custom OData service `duopharma_snapshotproductrecommendation` | `SnapshotProdRecCollection` | Recommendation snapshot |
| Unit names (Box, Bottle ...) | same custom service | `SnapshotProdRecQuantityUnitCodeCollection` | Recommendation unit names |

**Only if agents may create or update contacts** from the unknown-caller screen
(`ALLOW_WRITES`, see [1.9](#19-writes-create-a-contact-save-a-number)): also **create and
change** on Contacts. Nothing else is ever written. The view never deletes anything.

**Not needed:** administrator rights, other work centers, reports, any other custom service.
Nobody signs in to the screens with this user.

C4C checks the same access rights the screens use, and some tenants add a separate right for
using the API at all. The administrator knows where these are set in your tenant; the check
in [1.6](#16-prove-it-works-before-switching) tells them exactly which object is refused.

### 1.4 Things that go wrong without an error message

These are the ones worth telling the administrator about up front.

* **Data restrictions.** If the user's role limits which accounts or contacts it may see
  (by territory, owner, organisational unit), C4C does **not** give an error. It simply
  returns fewer records. A known customer then looks like an "unknown caller" and sections
  look empty. The user needs to see **all** customers your agents serve. The check script
  cannot catch this, because it only asks for one record per object: see the real-caller test
  in [1.8](#18-switch-from-mock-to-c4c).
* **The custom service has its own access.** A refusal on the two "Recommendation" lines
  while everything else passes means this right is missing.
* **Password expiry and lockout.** When the password expires or the user is locked, every
  section fails at once (HTTP 401 in the pod log). Ask for a password that does not expire,
  or write the expiry date in your calendar.
* **Address restrictions.** If your tenant limits which addresses may sign in, the cluster's
  outgoing address must be allowed. On a trial Kyma cluster that address is shared and can
  change, so this only suits the test tenant for now.

### 1.5 What to ask the C4C administrator

Copy, fill in the name, and send:

```text
Subject: Technical user for the lean customer view (read-only OData)

Please create a technical (API-only) user in tenant my335945:

- Name: for example SVC_LEAN_VIEW
- Sign-in: user and password over HTTPS (HTTP Basic). It must not need single sign-on or a
  second factor, must not be forced to change the password at next sign-in, and the password
  should not expire (or tell me the expiry date).
- Access: READ ONLY, on ALL records (no territory, owner or unit restriction), for:
    Contacts, Accounts (corporate), Sales orders, Tasks, Phone calls, Employees, Products,
    and the custom OData service duopharma_snapshotproductrecommendation
    (SnapshotProdRecCollection and SnapshotProdRecQuantityUnitCodeCollection).
- Nothing else: no administrator rights, no delete. Create/change on Contacts is a separate
  request that I will send later, only if we decide to allow it.
- Please send the password only to me, through a secure channel (not chat or e-mail).

When it is ready I run a check that lists every object as PASS or FAIL. I will send you any
FAIL line, so you can see exactly which right is missing.
```

### 1.6 Prove it works before switching

Run this on your machine. It asks for the C4C address, the user and the password (the
password is not shown as you type):

```powershell
npm run check:c4c
```

It reads **one record per object** and prints only PASS or FAIL per line. It does not print
any customer data, and the password never appears in the output or in an address. The exit
code is 0 when everything is readable, 1 when something is not.

What good looks like:

```text
PASS  Contacts                                               200  readable
PASS  Accounts                                               200  readable
PASS  Sales orders                                           200  readable
PASS  Tasks                                                  200  readable
PASS  Phone calls                                            200  readable
PASS  Employees                                              200  readable
PASS  Products                                               200  readable
PASS  Recommendation snapshot                                200  readable
PASS  Recommendation unit names                              200  readable
INFO  Write token (only needed to create or change contacts) 200  C4C issues a token. Whether the user may change contacts can only be tested by a real change.

9/9 objects readable
```

When a right is missing, the line says what to ask for. Send the FAIL lines to the
administrator:

```text
FAIL  Tasks                                                  403  signed in, but not allowed to read this: add the access right for it to the user's business role   [needed for: open tasks]
FAIL  Recommendation snapshot                                404  not found: the service is not released for this user or tenant (check the service name)   [needed for: recommended products of the month]

6/9 objects readable
```

| Answer | Meaning | Who fixes it |
|---|---|---|
| `200` PASS | Readable. | |
| `401` | User or password not accepted, or the user is locked or expired. | Administrator (user) or you (typo) |
| `200` but "got a web page, not data" | C4C answered with its sign-in page: this user may not sign in with a password for API calls. | Administrator |
| `403` | Signed in, but this object is not allowed for the user. | Administrator: add the access right |
| `404` | The service or object is not available to this user or tenant. For the two recommendation lines: the custom service is not released to the user. | Administrator |
| `429` / `503` | C4C is busy or limiting calls. | Wait a minute and run it again |
| "could not connect" | Wrong address, or no network from your machine. | You |

When **every** line fails the same way, the script says so once at the end ("this is about
signing in, not about access rights"), so you do not chase rights that were never the problem.

PASS means "allowed to read". It does **not** prove the user sees every record (see 1.4).

You can also test one object without this repository (PowerShell: `curl.exe`; it asks for the
password):

```powershell
curl.exe -u SVC_LEAN_VIEW 'https://my335945.crm.ondemand.com/sap/c4c/odata/v1/c4codataapi/ContactCollection?$top=1&$select=ContactID&$format=json'
```

### 1.7 Give the credentials to the view

Put them into Kyma yourself, so they never pass through a chat or a file. In PowerShell (the
password prompt does not echo, and nothing is kept in your history):

```powershell
$env:KUBECONFIG = "$env:USERPROFILE\.kube\kyma-trial.yaml"
$user = Read-Host "C4C technical user"
$pass = Read-Host "C4C password" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass))
kubectl create secret generic c4c-odata-credentials -n c4c-poc --from-literal=C4C_USER=$user --from-literal=C4C_PASSWORD=$plain
$plain = $null
```

The deployment already reads this secret (`optional: true`), so the view starts without it
while `DATA_SOURCE` is `mock`.

**Change the password** by deleting and recreating the secret, then restarting the view:

```powershell
kubectl delete secret c4c-odata-credentials -n c4c-poc
# create it again with the commands above, then:
kubectl rollout restart deploy/c4c-lean-view -n c4c-poc
```

Between changing the password in C4C and restarting the view, the sections show an error, so
do it at a quiet moment.

Never put the user or password into `kyma/configmap.yaml`, a committed file, a chat or a
ticket. `.env` files are listed in `.gitignore` for local tests only.

### 1.8 Switch from mock to C4C

1. The secret from 1.7 exists and `npm run check:c4c` says 9/9.
2. In `kyma/configmap.yaml`: `DATA_SOURCE: "c4c"`. Decide `ALLOW_WRITES` on purpose (1.9): it
   is `"true"` today, which is harmless on mock data but lets agents change real contacts
   once the data is real.
3. `kubectl apply -k kyma/`, then `kubectl rollout restart deploy/c4c-lean-view -n c4c-poc`.
   Check `https://c4c-lean-view.c-3905022.kyma.ondemand.com/health`: it shows `"source":"c4c"`.
4. **Real-caller test** (this is what proves the user sees every record):
   * a customer whose number is saved in C4C: the same contact, owner, last order, open
     tasks and recommendations as in C4C;
   * a customer **outside the usual team or territory**, if you use them: still found;
   * a number that is not in C4C: the unknown-caller screen;
   * a conversation whose phone call activity exists in C4C: found through the activity
     ([2.1](#21-the-external-id-is-the-phone-call-activity)).
5. Watch the pod log while you test (phone numbers are masked, no customer data):
   `kubectl logs deploy/c4c-lean-view -n c4c-poc --tail=50 -f`
6. **Roll back** by setting `DATA_SOURCE: "mock"` again and repeating step 3.

### 1.9 Writes: create a contact, save a number

The unknown-caller screen can create a contact or save the caller's number on an existing
one. Both are **written but not yet tried against the tenant**: the property names for a new
contact (`AccountID`, `Email`) and the PATCH headers need a first real test.

What each write does:

* **Save the number on a contact:** `PATCH` into `Mobile` if it is empty, else `Phone` if
  that is empty, else it refuses. It never overwrites a number.
* **Create a contact:** `POST` with last name, first name, account, email and the caller's
  number as `+60…`.
* Both need a security token from C4C first (the INFO line in the check). That the user is
  *allowed* to change contacts can only be proved by one real change.

Recommended order:

1. Go live **read-only**: `ALLOW_WRITES: "false"`. The unknown-caller screen then says
   "Saving contacts is turned off in this environment", greys out both options, and the agent
   adds the number to the contact in C4C.
2. When you want writes: give the user create and change on **Contacts only**, set
   `ALLOW_WRITES: "true"`, and test on a throwaway contact in the test tenant.
3. Check in C4C that the number landed where you expect and the contact shows the technical
   user as the one who changed it.

If `ALLOW_WRITES` is `true` but the user can only read, saving fails with "C4C did not
respond. Try again." and the pod log says `C4C HTTP 403`. Nothing is changed.

### 1.10 When it does not work

Open the pod log (`kubectl logs deploy/c4c-lean-view -n c4c-poc --tail=50`). Errors carry
only the HTTP status, never customer data.

| What you see | Likely cause | What to do |
|---|---|---|
| Every section shows an error; log says `C4C HTTP 401` | Wrong, expired or locked password; or the secret holds an old one | `npm run check:c4c`; fix the password; recreate the secret; restart |
| One section shows an error; log says `C4C HTTP 403` | The right for that object is missing | Run the check, send the FAIL line to the administrator |
| Recommendations show an error; log says `C4C HTTP 404` | The custom service is not released to the user | Same; also check `C4C_RECO_SERVICE` if you changed it |
| A known customer shows the unknown-caller screen | Number not stored as `+60…` in Mobile or Phone; **or** the user cannot see that contact (1.4); **or** the External ID is not the activity ID ([2.1](#21-the-external-id-is-the-phone-call-activity)) | Open the contact in C4C and compare the number; test with a customer from another team |
| Everything is empty for every customer | Data restriction on the user, or `DATA_SOURCE` still `mock` | Check `/health` shows `"source":"c4c"`; ask the administrator about restrictions |
| Log says `fetch failed` or `This operation was aborted` | Wrong `C4C_BASE_URL`, no route from the cluster, or C4C is slow | Check the address; raise `C4C_TIMEOUT_MS` (default 8000) if C4C is just slow |
| Works in the check but not in the view | The check runs from your machine, the view from the cluster | Address restrictions (1.4); the secret was created in another namespace |

### 1.11 Data protection and audit

* **What leaves C4C.** The view asks for named fields only (`$select`): the columns in the
  mapping below. It never asks for whole records.
* **What reaches the browser.** Only what is shown on the screen. The user, the password and
  the C4C token never do.
* **What is logged.** One `[audit]` line per request on the BTP side: agent, conversation,
  masked phone number, what was asked, status, time. Response bodies and customer data are
  never logged, and errors carry only the HTTP status. The pod log is where you answer "who
  looked at this customer"; C4C itself only knows the technical user.
* **What is saved.** The page keeps what it loaded in its own memory for
  `CACHE_TTL_SECONDS` (default 300) so switching between chats is instant. Nothing is stored
  on a server or in the browser's storage. Set `0` to turn it off.
* **Treat the secret like a master key.** The technical user sees every customer. Limit who
  may read secrets in the `c4c-poc` namespace, rotate the password on a schedule, and change
  it at once if it was ever shared in plain text.
* **Load.** Opening a conversation makes about 8 to 10 small requests. Switching back to it
  within the saved-copy time makes none. Each token may make at most 80 calls, and a search
  adds a few.
* **Test data only on the trial account.** The Kyma trial is not meant for real customer
  data. Use it with the test tenant only.

---

## 2. How the view finds the customer

### 2.1 The External ID is the phone call activity

For each conversation Nubitel keeps an **External ID**: the ID of the C4C phone call activity
for that conversation (the number you see for the activity in C4C). Nubitel's backend puts it
into the signed token as `ext`, and the view uses it first:

1. `PhoneCallCollection` where `ID` equals the External ID gives the activity's contact
   (`MainContactPartyID`).
2. That contact (`ContactCollection`, by `ContactID`) gives the account and the owner.
3. Orders, tasks and recommendations then follow from the account.

If the activity is not found, or it has no contact (a call from a number C4C does not know),
the view **falls back to the phone number by itself**: the normalised number in
`NormalisedMobile`, and separately `NormalisedPhone`. If that finds nobody either, the agent
gets the unknown-caller screen. If it finds two contacts, the agent chooses.

Which activity field is matched is `C4C_ACTIVITY_FIELD`:

* default and Kyma value: `ID`;
* `""` (empty): ignore the External ID and use the phone number only;
* another field name, if Nubitel stores its value elsewhere.

Phone call activities have **no `ExternalID` field** in this tenant. `GroupwareItemID` is
the id from the mail and calendar synchronisation, **not** a Nubitel value, so do not use it.

**To confirm (one check):** that the External ID Nubitel stores really is the activity's `ID`
as shown in C4C. Take one real conversation's External ID and, signed in to C4C in the
browser, open this address (replace the number):

```text
https://my335945.crm.ondemand.com/sap/c4c/odata/v1/c4codataapi/PhoneCallCollection?$filter=ID eq '4100234'&$select=ID,MainContactPartyID&$format=json
```

It should return that call and its contact. If it returns nothing, Nubitel's External ID is a
different value, and we need the field that holds it.

### 2.2 The open-in-C4C icons

Each icon opens the object in C4C in a new tab. The links were copied from real links of this
tenant and are rebuilt byte for byte by `btp-view/public/c4c-links.js`; `npm run test:links`
checks them against those real links.

| Icon | Opens | Found by | Comes from |
|---|---|---|---|
| Account | the account | the account's UUID | `AccountUUID` on the contact |
| Contact | the contact | the contact's `ContactID` | `ContactCollection` |
| Sales order | the order | the order `ID` | `CustomerOrderCollection` |
| Task | the task | the task's UUID | `UUID` in `TasksCollection` |

* An icon only appears when the ID is there; otherwise its place stays empty.
* The links hold object IDs only, nothing secret. If the agent is not signed in to C4C, C4C
  asks them to.
* The default link contains `saml2=disabled`, right for a tenant that signs in with user and
  password. For a **single sign-on tenant**, set `C4C_LINK_BASE` to the part of a real C4C
  link before the `#`, without `saml2=disabled`.
* If SAP ever changes the screens, copy one new link per object from the browser bar and
  update `lib/c4c-links.js`.

---

## 3. Data mapping and what we learned

### Confirmed mapping

| Screen | Entity set | Query | Fields used |
|---|---|---|---|
| Who is calling (by activity) | `PhoneCallCollection` | `<C4C_ACTIVITY_FIELD> eq '<External ID>'` | ID, MainContactPartyID (= ContactID) |
| Who is calling (by phone) | `ContactCollection` | `NormalisedMobile eq '+60…'`, and separately `NormalisedPhone eq '+60…'` | ContactID, Name, AccountID, AccountUUID, AccountFormattedName, ContactOwnerID, Mobile, Phone |
| Owner name | `EmployeeBasicDataCollection` | `EmployeeID eq '<ContactOwnerID>'` | FormattedName |
| Last sales order | `CustomerOrderCollection` | `BuyerPartyID eq '<AccountID>'`, `$orderby=DateTime desc`, `$top=1` | ID, DateTime, NetAmount, NetAmountCurrencyCode, OrderExternalLifeCycleStatusCodeText |
| Open tasks | `TasksCollection` | `MainAccountPartyID eq '<AccountID>' and (Status eq '1' or Status eq '2')`, `$orderby=DueDateTime asc`, `$inlinecount=allpages` | ID, UUID, Subject, DueDateTime, StatusText, PriorityCode |
| Recommended products | custom: `SnapshotProdRecCollection` | `C4CCustomerID eq '<AccountID>' and SnapshotMonthYear eq '<YYYY-MM>' and ShowInReport eq 'Yes'`, `$orderby=RecTypeID asc,Quantity desc`, `$top=50` | ProductID, RecType, Quantity, QuantityUnitCode |
| Product names | `ProductCollection` | `ProductID eq 'a' or ProductID eq 'b' …` (one call for the whole table) | Description |
| Unit names | custom: `SnapshotProdRecQuantityUnitCodeCollection` | the whole list, remembered for 6 hours | Code → Description (XBX = Box, ZBO = Bottle) |
| Search contacts | `ContactCollection` | `substringof('<text>',Name)` and `substringof('<text>',AccountFormattedName)` | as above |
| Search accounts | `CorporateAccountCollection` | `substringof('<text>',Name)` | AccountID, Name |
| Save number / create contact | `ContactCollection` | PATCH `Mobile` (or `Phone` if Mobile is taken), POST new contact | not yet tried, see 1.9 |

Account, contact, order, task and recommendation all join on the same **AccountID**
(`BuyerPartyID` on orders, `MainAccountPartyID` on tasks, `C4CCustomerID` in the snapshot).

### What we learned about this tenant

* **Phone numbers are stored as `+` and digits, no spaces** (`NormalisedMobile`,
  `NormalisedPhone`, for example `+60199999999`). The adapter converts the caller's number
  to that form. In a sample of 200 contacts **only 1 had any phone number**. Expect most
  callers to be "unknown" until numbers are added, which makes the unknown-caller screen the
  common path, not the exception.
* **C4C rejects `A or B` across two different fields** (error "Operands of logical
  operator '' are not valid"). Phone and name searches therefore run as two small
  queries and are merged. `or` on one field works.
* Task status codes: 1 Open, 2 In Process, 3 Completed, 4 Canceled. Priority: 1 Immediate,
  2 Urgent, 3 Normal, 7 Low. Dates arrive as `/Date(ms)/` and are shown in Malaysia time.
* `substringof` is case-insensitive. The owner name does not come through `$expand`, so it
  is a separate lookup (best effort: a missing owner never breaks the screen).
* **The recommendation snapshot** holds about 250,000 rows, one per account, month and
  product. The month is stored as text `YYYY-MM`. Recommendation types seen: RT02 Up-Sell,
  RT03 Special Price, RT07 Repeat Order - Low Priority. A typical account has about 6 rows
  in a month (up to 34), which is why the table scrolls. The snapshot has no product name,
  so names come from `ProductCollection`.
* **This tenant has no snapshot for the current month.** Snapshots exist for some past
  months only (the newest is `2026-08`). With the current-month rule the section is empty;
  see the decisions below.

### Decisions I made on the recommendations (please confirm)

1. **Only rows with `ShowInReport = 'Yes'`** are shown. About a quarter of the rows have a
   different value.
2. **Order:** recommendation type first (RT02 Up-Sell, RT03 Special Price, then RT07 Repeat
   Order), biggest quantity first inside a type. The "Why" column shows the type.
3. **Current month and year**, as requested (in Malaysia time). If this month's snapshot
   does not exist yet, `C4C_RECO_FALLBACK_LATEST=true` shows the newest earlier snapshot and
   labels it, for example "Aug 2026 (latest available)". It is switched **on** in the Kyma
   ConfigMap because the test tenant has no October snapshot; set it to `"false"` to show
   only the current month. When does the real snapshot for a new month get created?

### Still open

1. **External ID** is taken to be the phone call activity's `ID` (2.1). Please confirm with
   one real conversation.
2. **The technical user and its secret** (section 1). You create the secret; then
   `DATA_SOURCE` can go to `c4c`.
3. **`ALLOW_WRITES`** for real data, and the first real write test (1.9).
4. **C4C stores phone numbers in many formats.** If your callers' numbers are saved in a
   different form from `+60…`, the lookup misses them. A normalised field filled by a
   workflow or a data clean-up is the most reliable fix.

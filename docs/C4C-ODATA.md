# Using real C4C data (Phase 2)

The view, the server and the Nubitel side are built and tested on mock data that has
the same shape as the real objects. What is left is the **C4C OData mapping**: which
entity set and fields answer each question. It lives in one place, `lib/c4c-adapter.js`
(`createC4CAdapter`), behind the same interface the mock uses, so the screens do not
change. Until the mapping is filled in, `DATA_SOURCE=c4c` fails loudly instead of showing
guessed data.

Test tenant: `https://my335945.crm.ondemand.com`
Service root: `/sap/c4c/odata/v1/c4codataapi/`

## What the adapter must answer

| Question | Used for | Called |
|---|---|---|
| Phone call activity by external ID, then its contact and account | Who is on the line (preferred) | `resolve` |
| Contact(s) by phone number | Who is on the line (fallback), several contacts on one number | `resolve` |
| Last sales order of the account | Section "Last sales order" | `getSection('order')` |
| Open tasks of the account | Section "Open tasks" | `getSection('tasks')` |
| Product recommendations of the account for the **current month and year** | Section "Recommended products" | `getSection('reco')` |
| Contacts / accounts matching a typed name | Unknown-caller popups | `searchContacts`, `searchAccounts` |
| Create a contact, save a number on a contact | Unknown-caller popups | `createContact`, `updateContactPhone` |

## What I need from you

1. **The OData metadata.** While signed in to C4C, open
   `https://my335945.crm.ondemand.com/sap/c4c/odata/v1/c4codataapi/$metadata`, save the
   page as `docs/odata/c4c-metadata.xml` in the project folder and tell me. It has no
   secrets. If the recommendation snapshot is a **custom** object, also its own
   service's `$metadata` (custom OData services live under `/sap/c4c/odata/cust/v1/`).
2. **The recommendation snapshot**: which entity holds it, how it links to the account
   (and contact), and which fields are the year, the month, the product, the quantity,
   the unit and (if any) a reason.
3. **The phone call activity's external ID**: the field Nubitel writes its conversation
   ID into.
4. **Sample links.** In C4C open one account, contact, sales order and task, and paste
   me each address from the browser bar. I use them to set the open-in-C4C icons exactly.
5. **A technical user** (see below) with the minimum rights.

## Technical user and credentials

Create a dedicated C4C user for the OData calls: **read** access to accounts, contacts,
sales orders, activities/tasks and the recommendation snapshot. Give **write** access
(contacts only) only if agents may create or update contacts from the unknown-caller
screen. Do not reuse a person's login.

Put the credentials into Kyma yourself, so they never pass through a chat or a file.
In PowerShell (the password prompt does not echo and is not kept in your history):

```powershell
$env:KUBECONFIG = "$env:USERPROFILE\.kube\kyma-trial.yaml"
$user = Read-Host "C4C technical user"
$pass = Read-Host "C4C password" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass))
kubectl create secret generic c4c-odata-credentials -n c4c-poc --from-literal=C4C_USER=$user --from-literal=C4C_PASSWORD=$plain
```

The deployment already reads this secret (`optional: true`). Rotate it by deleting and
recreating the secret, then `kubectl rollout restart deploy/c4c-lean-view -n c4c-poc`.

## Switching from mock to C4C

1. Fill in the mapping (below), run `npm test` (mock) and a few manual tests with
   `DATA_SOURCE=c4c` locally against the test tenant.
2. In `kyma/configmap.yaml` set `DATA_SOURCE: "c4c"`, apply, restart the pod.
3. Decide `ALLOW_WRITES` on purpose. `true` lets agents change real C4C contacts.
4. Roll back by setting `DATA_SOURCE: "mock"` again.

## Mapping to fill in from `$metadata`

| Section | Entity set | Filter | Fields shown |
|---|---|---|---|
| Phone call activity | TBD | external ID = `ext` claim | contact ID, account ID |
| Contact by phone | TBD | normalised phone (mobile or phone) | contact ID, name, account ID and name, owner |
| Last sales order | TBD | account ID, `$orderby` date desc, `$top=1` | ID, date, status text, net amount + currency |
| Open tasks | TBD | account ID, status not completed | ID, subject, due date, priority, status |
| Recommendations | TBD | account ID, year = this year, month = this month | product, quantity, unit, reason |

Query rules: always `$select` only what is shown, `$top` the rows needed, no `$expand`,
one small call per section (they run in parallel). The current month is computed in
`Asia/Kuala_Lumpur` (`lib/period.js`), not in the server's time zone.

C4C stores phone numbers in many formats. Decide how the lookup matches: a normalised
extension field in C4C is the most reliable; otherwise match several formats.

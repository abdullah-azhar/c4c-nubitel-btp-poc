# Using real C4C data

Test tenant: `https://my335945.crm.ondemand.com`
Service root: `/sap/c4c/odata/v1/c4codataapi/`

The real adapter (`createC4CAdapter` in `lib/c4c-adapter.js`) is written against this
tenant's `$metadata` and data. The exact requests it builds were replayed against the
tenant and all returned HTTP 200; `npm run test:adapter` checks the mapping logic with a
fake C4C (21 checks). It has **not yet run end to end** because that needs the technical
user (below). Until `DATA_SOURCE` is set to `c4c` everything runs on mock data.

## Confirmed mapping

| Screen | Entity set | Query | Fields used |
|---|---|---|---|
| Who is calling (by phone) | `ContactCollection` | `NormalisedMobile eq '+60…'`, and separately `NormalisedPhone eq '+60…'` | ContactID, Name, AccountID, AccountFormattedName, ContactOwnerID |
| Owner name | `EmployeeBasicDataCollection` | `EmployeeID eq '<ContactOwnerID>'` | FormattedName |
| Who is calling (by activity) | `PhoneCallCollection` | `<C4C_ACTIVITY_FIELD> eq '<external ID>'` | MainContactPartyID (= ContactID) |
| Last sales order | `CustomerOrderCollection` | `BuyerPartyID eq '<AccountID>'`, `$orderby=DateTime desc`, `$top=1` | ID, DateTime, NetAmount, NetAmountCurrencyCode, OrderExternalLifeCycleStatusCodeText |
| Open tasks | `TasksCollection` | `MainAccountPartyID eq '<AccountID>' and (Status eq '1' or Status eq '2')`, `$orderby=DueDateTime asc`, `$inlinecount=allpages` | ID, Subject, DueDateTime, StatusText, PriorityCode |
| Search contacts | `ContactCollection` | `substringof('<text>',Name)` and `substringof('<text>',AccountFormattedName)` | as above |
| Search accounts | `CorporateAccountCollection` | `substringof('<text>',Name)` | AccountID, Name |
| Save number / create contact | `ContactCollection` | PATCH `Mobile` (or `Phone` if Mobile is taken), POST new contact | not yet tried, see below |

Account, contact, order and task all join on the same 9-digit **AccountID**
(`BuyerPartyID` on orders, `MainAccountPartyID` on tasks).

## What we learned about this tenant

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
* Phone call activities have **no `ExternalID` field**.

## Still needed

1. **The monthly recommendations.** Nothing in this service holds product recommendations
   for a month and year. The only related fields are on quote items
   (`KUT_Recommendation_ID_KUT`, `KUT_RecommendationType_KUT`). Is it a custom business
   object with its own OData service (`/sap/c4c/odata/cust/v1/<service>/`), a report, or
   data in another system? Send me where it lives and which fields hold the account, year,
   month, product, quantity and unit. Until then the section shows "Not connected to C4C yet".
2. **Where Nubitel stores its conversation ID on the phone call activity.** There is no
   `ExternalID`. Candidates: `GroupwareItemID` (filled on about half the calls in the
   test tenant and filterable), the activity's own `ID` (if Nubitel passes C4C's ID
   back), or a custom field. Put the field name in `C4C_ACTIVITY_FIELD`. Without it
   the view uses the phone number only.
3. **Sample links** for an account, contact, sales order and task (copy from the browser
   bar) to set the open-in-C4C icons exactly.
4. **A technical user** (below).

## Technical user and credentials

Create a dedicated C4C user for the OData calls: **read** access to accounts, contacts,
sales orders, tasks, phone calls and employees. Give **write** access (contacts only) only
if agents may create or update contacts from the unknown-caller screen. Do not reuse a
person's login.

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

1. Create the secret above and set `C4C_ACTIVITY_FIELD` in `kyma/configmap.yaml` if you
   know the field.
2. Set `DATA_SOURCE: "c4c"` in the ConfigMap, `kubectl apply -k kyma/`, restart the pod.
3. Test with a customer whose number is saved in C4C, a number that is not, and one that
   has open tasks and orders. Watch the pod log (`[audit]` lines, phone numbers masked).
4. Decide `ALLOW_WRITES` on purpose. `true` lets agents change real C4C contacts. The write
   calls (create contact, save number) are written but **not yet tried against the
   tenant**: the property names for create (`AccountID`, `Email`) and the PATCH
   headers need a first real test, ideally on a throwaway contact.
5. Roll back by setting `DATA_SOURCE: "mock"` again.

C4C stores phone numbers in many formats. If your callers' numbers are saved in a different
form from `+60…`, the lookup will miss them: a normalised field filled by a workflow or
a data clean-up is the most reliable fix.

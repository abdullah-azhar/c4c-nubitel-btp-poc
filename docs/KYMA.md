# Deploy the BTP lean view to SAP BTP Kyma

This replaces the Cloud Foundry `cf push` route in `DEPLOY.md` section 2. The
view runs as a container on your Kyma cluster. The mock Nubitel stays on Vercel.

```
GitHub (private repo) --Actions--> ghcr.io image --pulled by--> Kyma cluster
                                                                 |
   https://c4c-lean-view.<cluster-domain>/   <--APIRule--  Service -> Pod
```

Keep `DATA_SOURCE=mock`. A trial account is not company-controlled: no real
customer data and no C4C technical-user password here.

## What is in the repo

| File | Purpose |
|---|---|
| `Dockerfile`, `.dockerignore` | Image for `btp-view/` (+ `lib/`). Node 22 Alpine, non-root, no dependencies. |
| `.github/workflows/image.yml` | Builds the image in GitHub and pushes it to `ghcr.io/<you>/c4c-lean-view`. No local Docker needed. |
| `kyma/namespace.yaml` | Namespace `c4c-poc`, Istio sidecar enabled. |
| `kyma/configmap.yaml` | Origins and other non-secret settings. **Edit the tenant here.** |
| `kyma/deployment.yaml`, `service.yaml` | The pod (port 8080, `/health` probes, read-only filesystem). |
| `kyma/apirule.yaml` | Public HTTPS address on the Kyma domain. |
| `kyma/kustomization.yaml` | Ties it together and sets the image name and tag. |

## 1. One-time tools on your computer

* `kubectl` (already installed with Docker Desktop).
* The **kubelogin** plugin. BTP kubeconfigs sign you in through the browser with
  it, and they call a program named exactly `kubectl-oidc_login`, so the
  executable must have that name and be on your PATH:
  ```powershell
  # download kubelogin_windows_amd64.zip from github.com/int128/kubelogin/releases (Apache-2.0)
  # put kubelogin.exe in a folder on your PATH and copy it to the required name:
  Copy-Item kubelogin.exe kubectl-oidc_login.exe
  kubectl-oidc_login --help     # must print help
  ```
  (`winget install int128.kubelogin` installs it as `kubelogin.exe` only, so you
  still need the renamed copy.)

## 2. Get the kubeconfig (you sign in, in your browser)

1. BTP cockpit → your trial subaccount → **Overview** → **Kyma Environment**.
2. Wait until the cluster shows as available, then use the **KubeconfigURL**
   to download `kubeconfig.yaml`.
3. Save it **outside this repo**, for example `%USERPROFILE%\.kube\kyma-trial.yaml`.
   It identifies your cluster. Never commit it.
4. Use it and sign in when the browser opens:
   ```powershell
   $env:KUBECONFIG = "$env:USERPROFILE\.kube\kyma-trial.yaml"
   kubectl get namespaces
   ```

## 3. Build and publish the image

Push to `main` (or run the workflow by hand: GitHub → Actions → *Build BTP view
image* → Run workflow). It publishes `ghcr.io/<you>/c4c-lean-view:0.1.0`.

The package starts **private**. Kyma has to be able to pull it. Pick one:

* **Public package (simplest).** GitHub → your profile → Packages →
  `c4c-lean-view` → Package settings → Change visibility → Public. The image
  holds only the POC view code and no secrets (they are injected at run time).
* **Keep it private.** Create a GitHub personal access token (classic) with only
  `read:packages`, then:
  ```powershell
  kubectl create secret docker-registry regcred -n c4c-poc `
    --docker-server=ghcr.io --docker-username=<github-user> --docker-password=<token>
  ```
  `deployment.yaml` already refers to `regcred`.

## 4. Deploy

From the repo root, with `KUBECONFIG` set as in step 2:

```powershell
# Namespace first, then the secret (the pod will not start without it)
kubectl apply -f kyma/namespace.yaml
kubectl create secret generic c4c-lean-view-secret -n c4c-poc --from-env-file=.env

# Everything else
kubectl apply -k kyma/
kubectl rollout status deploy/c4c-lean-view -n c4c-poc
```

`.env` holds the same `TOKEN_SECRET` that is set on Vercel (it is git-ignored).
The view and the mock Nubitel must share one value for Option B.

## 5. Find the address and check it

```powershell
kubectl get gateways.networking.istio.io kyma-gateway -n kyma-system -o jsonpath='{.spec.servers[0].hosts[0]}'
# prints *.<id>.kyma.ondemand.com  ->  your view is https://c4c-lean-view.<id>.kyma.ondemand.com/
kubectl get apirule c4c-lean-view -n c4c-poc      # STATE should be Ready
curl.exe -s https://c4c-lean-view.<id>.kyma.ondemand.com/health
curl.exe -sI -H "Sec-Fetch-Dest: iframe" https://c4c-lean-view.<id>.kyma.ondemand.com/ | findstr /i "content-security-policy"
```

`/health` should return `{"ok":true,"source":"mock"}`, and the CSP header must
list the Vercel address and your C4C tenant under `frame-ancestors`.

The view link is **not public**: opened directly in a browser the page itself answers
`403` with a locked screen. Only a frame load (inside Nubitel) gets the app, and data
only comes back for a valid token. `curl -sI .../` therefore returns 403, which is
expected; use `/health` for probes. If agents use a very old browser that sends no
`Sec-Fetch-Dest` header, they would see the locked screen; `ALLOW_DIRECT_OPEN: "true"`
in the ConfigMap switches the check off (debugging only).

## 6. Connect it to the mock Nubitel and C4C

1. On Vercel set `VIEW_URL` to `https://c4c-lean-view.<id>.kyma.ondemand.com/`
   (trailing slash), plus `FRAME_ANCESTORS` and `HOST_ORIGIN` = your C4C tenant,
   then redeploy.
2. In `kyma/configmap.yaml` and `vercel.json` replace `REPLACE-WITH-TENANT`, then:
   ```powershell
   kubectl apply -k kyma/
   kubectl rollout restart deploy/c4c-lean-view -n c4c-poc
   ```
3. Use the production address `https://<project>.vercel.app/` in C4C. With
   Vercel's default Standard Protection that address is public, while the long
   per-deployment URLs ask for a Vercel login, so never use those in C4C.
   Then continue with `DEPLOY.md` section 5 (add the address to C4C as a mashup).

## Troubleshooting

| Symptom | Check |
|---|---|
| Pod `CreateContainerConfigError` | The secret is missing: `kubectl get secret c4c-lean-view-secret -n c4c-poc`. |
| Pod `ImagePullBackOff` | Package is private and `regcred` is missing or the token lacks `read:packages`; or the image name/tag in `kustomization.yaml` is wrong. |
| `kubectl get apirule` not Ready | `kubectl describe apirule c4c-lean-view -n c4c-poc`. If the CRD only has an older API version, change `apiVersion` in `apirule.yaml`. |
| Address returns 503 | The pod is not ready, or the namespace lost `istio-injection=enabled`. |
| View is blank inside Nubitel/C4C | `frame-ancestors` lacks the Vercel address or the C4C tenant (ConfigMap, then restart). |

Trial Kyma clusters are time-limited and may be hibernated or removed. Check the
expiry in the cockpit before each test session.

## Security notes

* Do not paste BTP or Vercel passwords into chats, files or this repo. Sign-in
  happens in your browser through the kubeconfig.
* Change any password that has been shared in plain text.

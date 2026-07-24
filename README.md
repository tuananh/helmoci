# helmoci

Classic Helm chart repositories, served as an OCI registry — on Cloudflare Workers, with R2 caching.

Inspired by [tuananh/helm-oci-proxy](https://github.com/tuananh/helm-oci-proxy).

**Proxy:** `https://helmoci.tuananh.net`

## Usage

Any classic Helm repo URL maps into the OCI path. Last segment is the chart name; everything before is `https://{host}/{repo-path}`:

| Classic | OCI |
|---------|-----|
| `helm repo add argo https://argoproj.github.io/argo-helm` + `argo/argo-cd` | `oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd` |
| `helm repo add jetstack https://charts.jetstack.io` + `jetstack/cert-manager` | `oci://helmoci.tuananh.net/charts.jetstack.io/cert-manager` |

```bash
helm pull oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd --version 7.7.12
```

Path layout:

```
oci://helmoci.tuananh.net/<host>/<repo-path...>/<chartName> --version <version>
```

| Segment | Example | Meaning |
|---------|---------|---------|
| `host` + `repo-path` | `argoproj.github.io/argo-helm` | Upstream `https://argoproj.github.io/argo-helm` |
| `chartName` | `argo-cd` | Looked up in that repo’s `index.yaml` |

No allowlist — if the upstream host is public and serves a valid Helm `index.yaml` with that chart/version, it works.

## How it works

1. Helm calls the OCI Distribution API (`/v2/…`).
2. On a cache miss, the Worker fetches `{repo}/index.yaml`, downloads the `.tgz`, and builds a Helm OCI artifact:
   - config: `application/vnd.cncf.helm.config.v1+json`
   - layer: `application/vnd.cncf.helm.chart.content.v1.tar+gzip`
3. Blobs and a tag pointer are stored in R2.
4. Subsequent pulls stream blobs from R2 (`ReadableStream`).

`index.yaml` responses are cached (~10 minutes) via the Cache API.

## Local development

```bash
npm install
npm run dev
```

Then:

```bash
helm pull oci://127.0.0.1:8787/argoproj.github.io/argo-helm/argo-cd --version 7.7.12 --plain-http
```

`--plain-http` is required for local HTTP. Create the R2 bucket once before deploying:

```bash
npx wrangler r2 bucket create helmoci-cache
npm run deploy
```

## Supported Helm operations

```bash
# Pull (version optional — uses tags/list for latest)
helm pull oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd --version 7.7.12
helm pull oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd

# Inspect
helm show chart  oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd --version 7.7.12
helm show values oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd --version 7.7.12
helm show all    oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd --version 7.7.12

# Render / dry-run install
helm template test oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd --version 7.7.12
helm install test oci://helmoci.tuananh.net/argoproj.github.io/argo-helm/argo-cd --version 7.7.12 --dry-run=client

# List versions (OCI tags/list)
curl -s https://helmoci.tuananh.net/v2/argoproj.github.io/argo-helm/argo-cd/tags/list | jq '.tags[:5]'
```

**Not applicable to OCI registries** (Helm limitation, not this proxy):

- `helm search repo` / `helm search hub` — search classic repos / Artifact Hub only
- `helm list` — lists cluster releases, not registry tags
- `helm repo add` — not needed for `oci://`

**Not supported (pull-only proxy):**

- `helm push`
- `/v2/_catalog`

## API surface

| Route | Behavior |
|-------|----------|
| `GET/HEAD /v2/` | Registry API version check |
| `GET/HEAD /v2/<name>/manifests/<tag\|digest>` | Helm OCI manifest |
| `GET/HEAD /v2/<name>/blobs/<digest>` | Stream blob from R2 |
| `GET/HEAD /v2/<name>/tags/list` | Versions from upstream `index.yaml` |

## Limits

- Chart packages larger than 50 MiB are rejected (Worker memory).
- Anonymous pull only.
- Only `https://` upstreams; localhost / raw IPs / single-label hosts are rejected.

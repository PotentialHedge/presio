# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/PotentialHedge/presio/security/advisories/new)
rather than in a public issue. If that isn't available to you, email
benedict.armstrong@gmail.com.

Expect an acknowledgement within a few days. Presio is maintained by one
person, so please allow reasonable time for a fix before disclosing publicly.

## Supported versions

Fixes land on the current major release line and are published as a new
patch release.

| Version | Supported |
| --- | --- |
| `1.x` (latest minor) | Yes |
| Older `1.x` minors | Upgrade to the latest minor |
| `:main` / unreleased builds | No — unstable by design |

See [Versions and upgrading](deploy/README.md#versions-and-upgrading) for the
container tags and how to upgrade.

## Scope

The hosted service at presio.ch / presio.xyz and this repository's self-hosted deployment
(`deploy/`, `docker-compose.yml`, `local.docker-compose.yml`) are both in
scope. Note that in `PRESIO_MODE=local` there is deliberately no
authentication — anyone who can reach the port can present. That mode is
intended for a personal machine or a trusted LAN, and running it on a public
address is a deployment choice rather than a vulnerability.

## Verifying a release

Published images carry a signed build provenance attestation:

```bash
docker buildx imagetools inspect ghcr.io/potentialhedge/presio-local:1 \
  --format '{{ json .Provenance }}'   # how and from what commit it was built
docker buildx imagetools inspect ghcr.io/potentialhedge/presio-local:1 \
  --format '{{ json .SBOM }}'         # what is inside it

# Releases from v1.2.0 onward also carry a Sigstore-signed attestation in
# GitHub's own store, which the CLI checks against this repository:
gh attestation verify --repo PotentialHedge/presio \
  oci://ghcr.io/potentialhedge/presio-local:1
```

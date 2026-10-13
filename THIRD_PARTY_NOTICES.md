# Third-Party Notices

This document summarizes third-party components used by AI Worker and their
license obligations, based on the audit in [docs/LICENSE_AUDIT.md](docs/LICENSE_AUDIT.md).

**Scope note:** The Apache-2.0 license for this repository covers AI Worker
source code and documentation in this repository. It does **not** relicense
proprietary vendor CLIs or third-party container base images.

## Direct npm dependencies (application)

| Package | License (declared) |
|---------|-------------------|
| `nuxt` | MIT |
| `vue` | MIT |
| `vue-router` | MIT |
| `zod` | MIT |
| `@nuxt/ui` | MIT |
| `@node-rs/argon2` | MIT |
| `@iconify-json/lucide` | ISC |
| `drizzle-orm` | Apache-2.0 |
| `postgres` | Unlicense |

Retain copyright and license notices from these packages when redistributing
corresponding source or substantial portions, as required by each license.

## Notable transitive / compliance notes

| Component | License | Notes |
|-----------|---------|-------|
| `lightningcss` (+ platform binaries) | MPL-2.0 | Weak copyleft: if you distribute modified MPL-covered files, source for those files must be available under MPL-2.0. Unmodified use as a dependency is typical for Nuxt/Vite builds. |
| `node-forge` | BSD-3-Clause OR GPL-2.0 | Dual-licensed; prefer BSD-3-Clause terms for permissive redistribution. |
| `vaul-vue` | Not declared in `package.json` (repo LICENSE is MIT) | Treat as MIT per upstream LICENSE; metadata gap flagged in the audit. |
| `caniuse-lite` | CC-BY-4.0 | Attribution required for the dataset. |
| Majority of transitive packages | MIT / ISC / BSD / Apache-2.0 / BlueOak-1.0.0 | Standard permissive notice retention. |

A full machine-readable inventory can be regenerated with:

```bash
pnpm licenses list
pnpm licenses list --prod
```

## Container base images and OS packages (runtime distribution)

These are installed or pulled when building/running the published Docker stack.
They are **not** part of this repository’s Apache-2.0 grant:

| Component | Typical license / terms | Source |
|-----------|-------------------------|--------|
| `node:22-bookworm` / `node:22-bookworm-slim` | Node.js: MIT; base OS packages: Debian licenses | Docker Hub `library/node` |
| Debian packages (`bash`, `curl`, `git`, `jq`, `openssh-client`, `rsync`, `python3`, `ca-certificates`, `util-linux`, …) | Various DFSG-compatible licenses | Debian |
| GitHub CLI (`gh`) | MIT | [cli/cli](https://github.com/cli/cli) |
| `postgres:16.6-alpine` (Compose service) | PostgreSQL License; Alpine packages various | Docker Hub `library/postgres` |

When redistributing container images, preserve applicable OS and package
copyright notices (for example Debian `/usr/share/doc/*/copyright`).

## Proprietary AI CLIs installed by the Docker build

The image build runs `scripts/install-ai-clis.sh`, which installs:

### Cursor Agent CLI

- **Vendor:** Anysphere / Cursor  
- **Install method:** `curl https://cursor.com/install \| bash`  
- **License:** Proprietary; use governed by [Cursor Terms of Service](https://cursor.com/terms-of-service) and related Cursor agreements  
- **Redistribution:** Not covered by this project’s Apache-2.0 license. Public redistribution of Cursor binaries inside a published image is **unverified** against Cursor’s terms — see unresolved questions in `docs/LICENSE_AUDIT.md`.  
- **Usage model for operators:** End users should authenticate with their own Cursor credentials / API key. Do not resell Cursor access under a shared account.

### Claude Code (`@anthropic-ai/claude-code`)

- **Vendor:** Anthropic PBC  
- **Install method:** `npm install -g @anthropic-ai/claude-code`  
- **License:** Proprietary — “SEE LICENSE IN README.md”; use subject to Anthropic’s Commercial / Consumer Terms  
- **Product guidance:** Anthropic documents conditions for preinstalling/running Claude Code in products (unmodified binary; each end user authenticates and is billed under their own credentials). See [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).  
- **Redistribution:** Whether publishing a pre-baked public Docker image that contains the Claude Code binary is fully permitted without further Anthropic agreement remains an **unresolved** compliance question — see `docs/LICENSE_AUDIT.md`.

## Attribution statement

AI Worker uses open-source libraries from the npm ecosystem and standard
container base images listed above. Proprietary Cursor and Anthropic CLIs, when
present, remain the property of their respective owners and are subject only to
those owners’ terms.

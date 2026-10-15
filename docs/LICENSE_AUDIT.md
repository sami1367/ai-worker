# License Audit — AI Worker

**Audit date:** 2026-10-13  
**Scope:** Direct and transitive npm dependencies (`pnpm-lock.yaml`), and CLIs / runtimes installed or pulled via the Docker / Compose stack.  
**Method:** `pnpm licenses list` / `pnpm licenses list --prod`, inspection of `package.json` / `Dockerfile` / `scripts/install-ai-clis.sh`, and review of vendor terms published by Cursor and Anthropic.

This audit supports open-source publication of **AI Worker source code**. It does **not** constitute legal advice. Unresolved items must not be assumed permitted.

---

## 1. Recommendation

**Recommended project license: Apache License 2.0**

### Justification (verified findings)

| Goal | Finding | Why Apache-2.0 fits |
|------|---------|---------------------|
| Open-source distribution of AI Worker | npm graph is overwhelmingly permissive (MIT/ISC/BSD/Apache); no AGPL/SSPL/BUSL copyleft blockers found | Apache-2.0 is compatible with redistributing those dependencies alongside project source |
| Attract international / enterprise customers for paid install & customization | Commercial services are allowed under both MIT and Apache-2.0 | Apache-2.0 adds an **express patent grant** and clearer contributor patent termination — useful when selling services to companies |
| Clarity vs MIT | MIT is shorter and also fine for this dependency mix | Apache-2.0’s NOTICE mechanism matches the need to document third-party and proprietary CLI boundaries |
| Docker-bundled proprietary CLIs | Cursor, Claude Code, Codex, and GitHub Copilot CLIs are **not** open source; redistribution of binaries in a public image is incompletely verified (Gemini CLI is Apache-2.0; CodeGraph is MIT) | Project license must cover **only this repository’s code**; proprietary CLIs stay under vendor terms (documented in `THIRD_PARTY_NOTICES.md`) |

**MIT alternative:** Acceptable if simplicity is preferred. It would not fix proprietary CLI redistribution questions. Prefer Apache-2.0 unless stakeholders explicitly want MIT.

**Applied in this change set:** `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `package.json` `"license": "Apache-2.0"`. Change these if a different choice is approved.

---

## 2. npm dependency audit

### 2.1 Direct dependencies

| Package | Declared license |
|---------|------------------|
| `nuxt` | MIT |
| `vue` | MIT |
| `vue-router` | MIT |
| `zod` | MIT |
| `@nuxt/ui` | MIT |
| `@node-rs/argon2` | MIT |
| `@iconify-json/lucide` | ISC |
| `drizzle-orm` | Apache-2.0 |
| `postgres` | Unlicense |

### 2.2 Production transitive summary (`pnpm licenses list --prod`)

Approximate counts at audit time:

| License | Approx. packages |
|---------|------------------|
| MIT | 566 |
| Apache-2.0 | 33 |
| ISC | 33 |
| BSD-2-Clause | 16 |
| BlueOak-1.0.0 | 12 |
| BSD-3-Clause | 8 |
| MPL-2.0 | 3 (`lightningcss` family) |
| Other permissive (0BSD, Unlicense, CC0, dual MIT/CC0, MIT OR Apache-2.0) | few |
| CC-BY-4.0 | 1 (`caniuse-lite`) |
| Python-2.0 | 1 (`argparse`) |
| BSD-3-Clause OR GPL-2.0 | 1 (`node-forge` — dual license) |
| Unknown (metadata) | 1 (`vaul-vue`) |

**Full tree (incl. devDependencies)** similarly dominated by MIT; no GPL-only or AGPL packages observed in the license list.

### 2.3 Attribution / notice requirements (OSS deps)

| Requirement | Applies to |
|-------------|------------|
| Retain copyright + license text | MIT, ISC, BSD, BlueOak, Apache-2.0, MPL-2.0 (for covered files) |
| Apache NOTICE handling | Apache-2.0 dependencies if they ship NOTICE files |
| Attribution | CC-BY-4.0 (`caniuse-lite`) |
| MPL-2.0 file-level copyleft | Only if distributing **modified** MPL-covered source files |
| Dual license choice | `node-forge`: use BSD-3-Clause branch for permissive products |

### 2.4 Metadata gap

- **`vaul-vue@0.4.1`:** `package.json` omits `license`; upstream repository LICENSE is **MIT** ([unovue/vaul-vue](https://github.com/unovue/vaul-vue) / related forks). Flagged as Unknown by `pnpm licenses` until metadata is fixed upstream.

---

## 3. Docker / CLI / runtime audit

Components referenced by `Dockerfile` and `docker-compose.yml` (audit only; those files were not modified for this task).

### 3.1 Base image and OS tooling

| Component | Role | License / terms (verified or typical) | Redistribution notes |
|-----------|------|----------------------------------------|----------------------|
| `node:22-bookworm` / `bookworm-slim` | Build & runtime base | Node.js MIT; Debian package licenses | Allowed under respective OS/package licenses; keep copyright files in images |
| apt packages (`bash`, `curl`, `git`, `jq`, `openssh-client`, `rsync`, `python3`, `gh`, …) | Worker utilities | Mostly GPL/MIT/BSD per package; `gh` is MIT | Standard Debian redistribution; `gh` MIT notice retention |
| `postgres:16.6-alpine` | Database service | PostgreSQL License + Alpine | Compose pulls official image; not relicensed by AI Worker |

### 3.2 Cursor Agent CLI

| Item | Detail |
|------|--------|
| Install | `scripts/install-ai-clis.sh` → `curl https://cursor.com/install \| bash` |
| Nature | Proprietary Cursor / Anysphere software |
| Governing terms | [Cursor Terms of Service](https://cursor.com/terms-of-service); related MSA / product terms |
| Verified constraints | ToS restricts reproducing/redistributing the Service and selling/reselling it; forum guidance distinguishes embedding Cursor CLI/SDK in your product (intended) vs reselling Cursor access |
| Covered by AI Worker Apache-2.0? | **No** |
| Publishing pre-baked public images containing the CLI | **Unresolved** — no explicit public grant found authorizing redistribution of Cursor Agent binaries via third-party Docker Hub images. Do not assume permission. |

### 3.3 Claude Code (`@anthropic-ai/claude-code`)

| Item | Detail |
|------|--------|
| Install | `npm install -g @anthropic-ai/claude-code` in image build |
| Nature | Proprietary; npm license field `SEE LICENSE IN README.md` (“All rights reserved”; Anthropic terms) |
| Product documentation | [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) allows preinstalling/running Claude Code in products under Commercial Terms if: binary unmodified; each end user authenticates and is billed under their own credentials; no resale/intermediation of usage |
| Covered by AI Worker Apache-2.0? | **No** |
| Publishing pre-baked public images | **Unresolved / elevated risk** — Anthropic’s docs address preinstall in customer products; community projects have questioned whether redistributing the binary in a **public pullable image** is “duplication/redistribution” beyond the use grant. Seek Anthropic confirmation before relying on Hub distribution of a baked-in CLI. |

### 3.4 Codex CLI (`@openai/codex`)

| Item | Detail |
|------|--------|
| Install | `npm install -g @openai/codex` in image build |
| Nature | Proprietary OpenAI software |
| Governing terms | OpenAI terms / Codex product documentation |
| Covered by AI Worker Apache-2.0? | **No** |
| Publishing pre-baked public images | **Unresolved** — confirm OpenAI redistribution terms before relying on Hub distribution of a baked-in CLI. |

### 3.4b Gemini CLI (`@google/gemini-cli`)

| Item | Detail |
|------|--------|
| Install | `npm install -g @google/gemini-cli` in image build |
| Nature | Open-source CLI (Apache-2.0 upstream); Gemini API usage subject to Google AI terms |
| Governing terms | [gemini-cli LICENSE](https://github.com/google-gemini/gemini-cli) + Google AI / Gemini API terms |
| Covered by AI Worker Apache-2.0? | CLI source is Apache-2.0 (compatible); API usage is not relicensed by this project |
| Publishing pre-baked public images | Lower risk than proprietary CLIs for the binary itself; still confirm Google AI API terms for operators |

### 3.4c GitHub Copilot CLI (`@github/copilot`)

| Item | Detail |
|------|--------|
| Install | `npm install -g @github/copilot` in image build (Node.js 22+) |
| Nature | Proprietary CLI; Copilot usage billed under the operator’s GitHub Copilot subscription |
| Governing terms | GitHub Terms of Service + GitHub Copilot / additional products terms |
| Covered by AI Worker Apache-2.0? | No — binary stays under GitHub / Microsoft terms |
| Publishing pre-baked public images | Unresolved — confirm whether bundling `@github/copilot` in a public pullable image is permitted |
| Auth model | Fine-grained PAT with **Copilot Requests** via `COPILOT_GITHUB_TOKEN` (classic `ghp_` tokens unsupported) |

### 3.4d CodeGraph CLI

| Item | Detail |
|------|--------|
| Install | Upstream install script via `scripts/install-ai-clis.sh` / `scripts/lib/codegraph.sh` |
| Nature | Open-source CLI (MIT); optional Pro waitlist signup uses admin email at bootstrap |
| Governing terms | [codegraph LICENSE](https://github.com/colbymchenry/codegraph) (MIT) |
| Covered by AI Worker Apache-2.0? | Upstream is MIT (compatible); retain notices when redistributing the CLI |
| Publishing pre-baked public images | Permissive for the MIT CLI binary; retain upstream attribution |

### 3.5 Operator credentials (AI CLIs)

AI Worker is designed so forge/AI tokens are supplied by the operator (env / UI), not baked into the image. That aligns with vendor expectations that end users use their own accounts. It does **not** by itself resolve binary redistribution questions for published images.

---

## 4. MIT vs Apache-2.0 comparison (project code only)

| Criterion | MIT | Apache-2.0 |
|-----------|-----|------------|
| Permissive use, modification, commercial services | Yes | Yes |
| Patent grant | Implicit / silent | Explicit |
| NOTICE file | Not required | Supported / expected for attribution |
| Compatibility with current npm graph | Yes | Yes |
| Enterprise familiarity | High | High (often preferred in enterprise OSS reviews) |
| Effect on Cursor / Claude / Codex / Gemini / Copilot redistribution | None | None |

Neither license can authorize redistribution of proprietary CLIs.

---

## 5. Unresolved licensing questions

Do **not** treat these as approved without vendor confirmation or counsel:

1. **Cursor Agent CLI in public Docker Hub images** — Is baking the CLI into `sami1367/ai-worker` and publishing for anonymous `docker pull` permitted under Cursor’s current Terms, or must end users install the CLI themselves (runtime install / local build)?
2. **Claude Code in public Docker Hub images** — Does Anthropic’s “preinstall in products” guidance cover third-party public image redistribution, or is a separate agreement / runtime-only install required?
3. **Codex CLI in public Docker Hub images** — Confirm whether baking `@openai/codex` into a public pullable image is permitted under OpenAI’s current terms.
4. **Gemini CLI in public Docker Hub images** — CLI is Apache-2.0; confirm Google AI API terms still fit your redistribution / operator model.
5. **GitHub Copilot CLI in public Docker Hub images** — Confirm whether baking `@github/copilot` into a public pullable image is permitted under GitHub’s current terms.
6. **Trademark / naming** — Confirm marketing language (“Cursor CLI”, “Claude Code”, “Codex”, “Gemini”, “GitHub Copilot”) stays within each vendor’s trademark guidelines (plain-text accurate description vs. endorsement implication).
7. **`vaul-vue` SPDX metadata** — Confirm ongoing MIT status when upgrading; package.json still lacks a license field.
8. **Full Debian / Alpine copyright aggregation** — For compliance-hardened commercial deliverables, generate a complete OS package copyright report from the built image (not done in this audit).
9. **Export controls** — Cursor, Anthropic, OpenAI, Google, and GitHub terms may reference export/trade controls; operators in restricted jurisdictions need their own compliance review.

---

## 6. Files added for open-source readiness

| File | Purpose |
|------|---------|
| `LICENSE` | Apache-2.0 for AI Worker repository content |
| `NOTICE` | Project copyright + pointer to third-party notices |
| `THIRD_PARTY_NOTICES.md` | Attribution and proprietary CLI boundaries |
| `docs/LICENSE_AUDIT.md` | This audit |
| `package.json` → `"license": "Apache-2.0"` | Package metadata |

**Out of scope for this task (intentionally unchanged):** application source, Dockerfiles, Compose files, install scripts. Any change to how CLIs are installed for redistribution compliance should be a separate, explicit change after unresolved questions are answered.

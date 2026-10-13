# AI Worker

Self-hosted AI agent platform for **GitHub** and **GitLab**. Label an issue or merge request, and AI Worker runs coding agents (Cursor CLI / Claude Code) in your environment to implement work or review changes.

AI Worker is designed for teams that want automation **on their own infrastructure**—including companies running **GitLab Self-Managed**—without sending repositories to a third-party hosted agent service.

**You do not need to clone this repository** for a standard deployment. Only Docker is required. The app image is pulled from Docker Hub.

| | |
|---|---|
| Image | [`sami1367/ai-worker`](https://hub.docker.com/r/sami1367/ai-worker) |
| Source | [github.com/sami1367/ai-worker](https://github.com/sami1367/ai-worker) |
| License | [Apache-2.0](LICENSE) (see [third-party notices](THIRD_PARTY_NOTICES.md) and [license audit](docs/LICENSE_AUDIT.md)) |

---

## Commercial Services

AI Worker is **self-hosted**. You run it on your servers (or private cloud) and connect it to your GitHub or GitLab instance with your own AI provider credentials.

For organizations—especially those using **GitLab Self-Managed**—paid professional services are available on request:

- **Installation and deployment** — production-oriented Docker Compose setup, networking, and operational handoff
- **Security hardening** — secret handling, access controls, and alignment with your environment’s security practices
- **GitLab Self-Managed integration** — webhooks, tokens, labels, and workflow fit for internal GitLab
- **AI workflow and prompt customization** — adapt implement/review behavior to your engineering standards
- **Optional maintenance and technical support** — ongoing help after go-live, by agreement

Services are scoped per engagement. Contact details are below; no public price list is published here.

---

## Contact

| Channel | |
|---------|--|
| GitHub | [github.com/sami1367/ai-worker](https://github.com/sami1367/ai-worker) · [github.com/sami1367](https://github.com/sami1367) |
| Business email | [sjd.rhm@gmail.com](mailto:sjd.rhm@gmail.com) |
| Website | [vibeplus1.com](https://vibeplus1.com/) |
| LinkedIn | [linkedin.com/in/sami-rahimi](https://www.linkedin.com/in/sami-rahimi/) |

---

## Quick start

One command — creates the folder, downloads Compose + `.env`, **auto-generates secure secrets**, and starts the stack:

```bash
mkdir -p ai-worker && cd ai-worker && \
curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/docker-compose.yml && \
curl -fsSL -o .env \
  https://raw.githubusercontent.com/sami1367/ai-worker/main/.env.example && \
curl -fsSL https://raw.githubusercontent.com/sami1367/ai-worker/main/scripts/generate-env.sh | bash && \
docker compose up -d && \
curl -fsS http://127.0.0.1:8080/api/v1/health && \
echo && echo "INITIAL_ADMIN_BOOTSTRAP_SECRET=$(cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt)" && \
echo "Open http://127.0.0.1:8080/setup and paste that secret."
```

You do **not** fill secrets by hand. After the command finishes, the bootstrap secret is printed again and saved in:

- `INITIAL_ADMIN_BOOTSTRAP_SECRET.txt` — `cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt`
- `.env` — `grep INITIAL_ADMIN_BOOTSTRAP_SECRET .env`

## Create admin

1. Open http://127.0.0.1:8080/setup  
2. Paste `INITIAL_ADMIN_BOOTSTRAP_SECRET` (`cat INITIAL_ADMIN_BOOTSTRAP_SECRET.txt`)  
3. Choose admin username + password (min 12 characters)

Optional forge / AI tokens (`GITHUB_TOKEN`, `CURSOR_API_KEY`, …) can be added to `.env` anytime, or set later in the UI. Restart after editing `.env`:

```bash
docker compose up -d
```

### Access the Web UI from your local computer

If AI Worker runs on a remote server, the UI listens on that machine’s `127.0.0.1:8080` and is not exposed to the public internet. Use an **SSH tunnel** so your laptop’s browser can reach it securely:

```bash
ssh -N -L 8080:127.0.0.1:8080 user@SERVER_IP
```

Replace `user` with your SSH username and `SERVER_IP` with the server’s hostname or IP.

What this does:

- `-L 8080:127.0.0.1:8080` — forwards your local port `8080` to the server’s `127.0.0.1:8080` (where AI Worker listens)
- `-N` — opens the tunnel only (no remote shell)

Keep that terminal open. On your computer, open http://127.0.0.1:8080 (or http://127.0.0.1:8080/setup for first-time admin setup).

### Removing `.env` after setup

On first successful start, required secrets are saved on the Docker `data` volume at `/data/config/app-secrets.env`. You may delete the host `.env` afterward if you do not need optional env overrides. Keep an offline backup of encryption/session secrets — see [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).

---

## Connect GitHub or GitLab

After admin setup, open **Connections** at http://127.0.0.1:8080/connections.

Use a **personal access token** for API access (issues, MRs, labels, comments).  
**Git clone/push** uses that same token over HTTPS when the forge allows it. A platform SSH key is **optional** (see below).

### GitHub token

1. Open [GitHub → Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens)  
   - Classic: [https://github.com/settings/tokens](https://github.com/settings/tokens) → **Generate new token (classic)**  
   - Fine-grained: [https://github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens) → **Generate new token**
2. In AI Worker → **Connections** → **Connect GitHub**, paste the token.

**Classic PAT — required scopes**

| Scope | Why |
|-------|-----|
| `repo` | Full private/public repo access (clone via HTTPS, issues, PRs, contents). Prefer this over `public_repo` alone. |
| `workflow` | Optional; only if agents must edit GitHub Actions workflows |

**Fine-grained PAT — required permissions**

| Permission | Access |
|------------|--------|
| Repository access | Select the repos AI Worker will use (or all) |
| **Metadata** | Read-only |
| **Contents** | Read and write |
| **Issues** | Read and write |
| **Pull requests** | Read and write |
| **Workflows** | Read and write (optional; same as classic `workflow`) |

For **organization private repos**, create the fine-grained token with that **organization as the resource owner**, and ensure the org allows fine-grained PATs.

### GitLab token

Works with **gitlab.com** and **self-managed** (e.g. `https://git.example.com`).

1. Open your GitLab → **Preferences → Access Tokens**  
   - gitlab.com: [https://gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens)  
   - Self-managed: `https://<your-gitlab-host>/-/user_settings/personal_access_tokens`
2. Create a token and in AI Worker → **Connections** → **Connect GitLab**, set the **server URL** (e.g. `https://gitlab.com` or `https://git.example.com`) and paste the token.

**Required scopes**

| Scope | Why |
|-------|-----|
| `api` | **Recommended.** API + repository access for issues, MRs, labels, comments, and HTTPS git when enabled |
| `read_api` | Minimum to *list* private projects only — not enough for full worker ops; use `api` |

### HTTPS git clone (token only) vs optional SSH

AI Worker clones with **HTTPS + your token by default**. That works when the forge allows git over HTTP(S).

**GitLab self-managed:** if clone fails with `Git access over HTTP is not allowed`, an admin can enable HTTPS git (no SSH required):

1. GitLab **Admin** → **Settings** → **General** → **Visibility and access controls**
2. **Enabled Git access protocols** → set to **Both** or **HTTP** (not “Only SSH”)
3. Save, then in AI Worker open the repository → **Retry clone**

(“HTTP” here means git over **HTTPS** to your `https://…` GitLab URL — not plain `http://`.)

**Platform SSH key (optional):** on first start AI Worker generates one shared key on the data volume. The **public** key is shown on **Connections**; the private key never leaves the volume. Add it only if you keep GitLab on **Only SSH**, or prefer SSH for git:

- GitLab: [Preferences → SSH Keys](https://gitlab.com/-/user_settings/ssh_keys) (self-managed: `https://<host>/-/user_settings/ssh_keys`)
- GitHub: [Settings → SSH and GPG keys](https://github.com/settings/keys)

If HTTPS git is enabled, you can ignore the SSH key and use the token alone for clone and push.

---

## Everyday use

| Goal | Action |
|------|--------|
| Implement an issue | Add label `ai` |
| Review a PR/MR | Add label `ai-review` |

Update later:

```bash
docker compose pull
docker compose up -d
```

Stop:

```bash
docker compose down
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `curl` 404 on GitHub raw URL | Repo must be **public** (Settings → Danger Zone → Change visibility) |
| Cannot pull image | Is `sami1367/ai-worker:latest` on Hub? Try `docker pull sami1367/ai-worker:latest` |
| Secrets missing / insecure | Re-run: `curl -fsSL https://raw.githubusercontent.com/sami1367/ai-worker/main/scripts/generate-env.sh \| bash` |
| `migrate` fails / CREATE SCHEMA | Password mismatch or old DB volume: see [docs/SECURITY.md](docs/SECURITY.md#migrating-from-older-compose-defaults) |
| Wrong bootstrap secret | Use the value printed by `generate-env.sh` / in `.env` (not a placeholder) |
| `Git access over HTTP is not allowed` | GitLab admin: enable **Both** or **HTTP** git protocols (see above), then Retry clone — or add the optional platform SSH public key from Connections |
| Clone works after enabling HTTPS git | Expected — token-only path; SSH not required |

---

## License and notices

- Project source: [Apache License 2.0](LICENSE)
- Copyright and notice: [NOTICE](NOTICE)
- Third-party and proprietary CLI terms: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- Audit findings and unresolved vendor questions: [docs/LICENSE_AUDIT.md](docs/LICENSE_AUDIT.md)

Cursor Agent CLI and Claude Code are proprietary products of their vendors. AI Worker does not relicense them. Operators must use their own provider credentials and comply with Cursor and Anthropic terms.

---

## Developers

Building, publishing, and local Node setup: [README.DEVELOPMENT.md](README.DEVELOPMENT.md)

Security and secret rotation: [docs/SECURITY.md](docs/SECURITY.md)

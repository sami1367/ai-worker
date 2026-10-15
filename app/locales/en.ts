/** English (source of truth for message keys) */
export const en = {
  'nav.dashboard': 'Dashboard',
  'nav.connections': 'Connections',
  'nav.repositories': 'Repositories',
  'nav.tasks': 'Tasks',
  'nav.providers': 'Providers',
  'nav.prompts': 'Prompts',
  'nav.settings': 'Settings',
  'nav.system': 'System',
  'nav.audit': 'Audit',
  'nav.howItWorks': 'How it works',
  'nav.about': 'About',
  'nav.logout': 'Logout',

  'layout.platform': 'Platform',
  'layout.mainNav': 'Main',
  'layout.footerNav': 'Footer',
  'layout.lightMode': 'Switch to light mode',
  'layout.darkMode': 'Switch to dark mode',
  'layout.language': 'Language',

  'setup.nav.needsAttention': 'Needs attention',
  'setup.warn.provider.title': 'Connect an AI provider',
  'setup.warn.provider.description': 'Enable and connect at least one AI provider (Cursor, Claude, Codex, or Gemini) before tasks can run.',
  'setup.warn.provider.action': 'Open providers',
  'setup.warn.connection.title': 'Connect GitHub or GitLab',
  'setup.warn.connection.description': 'Add at least one working forge connection, then register a repository.',
  'setup.warn.connection.unhealthyTitle': 'Forge connections need attention',
  'setup.warn.connection.unhealthyDescription': 'All forge connections have errors or are disconnected. Fix or reconnect one to continue.',
  'setup.warn.connection.action': 'Open connections',
  'setup.warn.repository.title': 'Enable a repository',
  'setup.warn.repository.description': 'Register and enable at least one repository so the worker can pick up labeled issues.',
  'setup.warn.repository.noneEnabledDescription': 'Repositories are registered but none are enabled. Enable at least one to start processing.',
  'setup.warn.repository.action': 'Open repositories',

  'footer.howItWorks': 'How it works',
  'footer.about': 'About',
  'footer.repository': 'Repository',
  'footer.license': 'License',
  'footer.contact': 'Contact',

  'howItWorks.title': 'How it works',
  'howItWorks.subtitle': 'Tutorial for GitHub, GitLab, and this panel',
  'howItWorks.intro.heading': 'Overview',
  'howItWorks.intro.p1':
    'AI Worker is a self-hosted coding assistant for GitHub and GitLab. Day-to-day work is driven by labels on issues and pull/merge requests. This panel is for setup, monitoring, and configuration.',
  'howItWorks.intro.p2':
    'Start by connecting your forge and AI providers here, enable repositories, then use labels in GitHub or GitLab to queue implement, Q&A, or review jobs. The AI agent only edits the assigned workspace; commit, push, pull/merge requests, and forge comments are performed by the trusted AI Worker orchestration layer — the agent cannot use your forge tokens on its own.',

  'howItWorks.forge.heading': 'Working in GitHub and GitLab',
  'howItWorks.forge.intro':
    'Day-to-day work happens in GitHub or GitLab — not in a terminal on the AI Worker host. After a repository is connected and enabled, open an issue or PR/MR, describe one clear goal, add the right label(s), and leave the item open while the worker runs. Watch status labels for progress, then review the PR/MR, the issue comment, or (if force-push is on) the commits on the target branch.',
  'howItWorks.forge.practice.heading': 'How to work in the forge',
  'howItWorks.forge.practice.item1':
    'Treat each issue or PR/MR as one request: a specific title and body give the agent a single clear goal.',
  'howItWorks.forge.practice.item2':
    'You only add trigger labels — ai (implement), ai + no-change (Q&A), or ai-review (review). Do not add status labels yourself; the worker owns those.',
  'howItWorks.forge.practice.item3':
    'Set the repository target branch in this panel before implement jobs. Prefer the default PR/MR flow; turn on force-push only when you intentionally want direct commits on that branch.',
  'howItWorks.forge.practice.item4':
    'Keep the issue or PR/MR open until the job finishes. To retry after failure, fix the request if needed, then add ai or ai-review again. For another Q&A turn: keep no-change, remove ai-answered, and add ai.',
  'howItWorks.forge.tokens.heading': 'Tokens and access',
  'howItWorks.forge.tokens.github':
    'GitHub: use a classic PAT with the repo scope (workflow optional), or a fine-grained token with Metadata read plus Contents, Issues, and Pull requests read/write. Paste it under Connections → Connect GitHub.',
  'howItWorks.forge.tokens.gitlab':
    'GitLab (gitlab.com or self-managed): create a personal access token with the api scope, then under Connections → Connect GitLab set the server URL and paste the token. read_api alone is not enough for full worker operations.',
  'howItWorks.forge.tokens.git':
    'Git clone and push use HTTPS with your token by default. Forge tokens and SSH keys stay with the trusted worker orchestration process; they are not given to the AI agent process. If GitLab blocks HTTP(S) git, enable Both or HTTP in GitLab admin Git access protocols, or add the platform SSH public key shown on Connections.',

  'howItWorks.workflows.heading': 'Common forge workflows',
  'howItWorks.workflows.implement.heading': 'Implement a change',
  'howItWorks.workflows.implement.step1': 'Confirm the repository target branch (and optional force-push setting) on the repository page.',
  'howItWorks.workflows.implement.step2': 'Open an issue (or an open PR/MR) with a clear title and description.',
  'howItWorks.workflows.implement.step3': 'Add the ai label.',
  'howItWorks.workflows.implement.step4': 'Watch labels move: ai → ai-working → ai-pr (or ai-failed).',
  'howItWorks.workflows.implement.step5':
    'Review the PR/MR the worker opened, or — if force-push is enabled — review the commits on the target branch and the issue comment.',

  'howItWorks.workflows.qa.heading': 'Ask a question (no code changes)',
  'howItWorks.workflows.qa.step1': 'Open an issue with your question.',
  'howItWorks.workflows.qa.step2': 'Add both ai and no-change.',
  'howItWorks.workflows.qa.step3': 'Wait for an issue comment. Final labels: ai-answered + no-change.',
  'howItWorks.workflows.qa.step4': 'To ask again: keep no-change, remove ai-answered, and add ai again.',

  'howItWorks.workflows.review.heading': 'Review a pull or merge request',
  'howItWorks.workflows.review.step1': 'Open a PR on GitHub or an MR on GitLab.',
  'howItWorks.workflows.review.step2': 'Add the ai-review label.',
  'howItWorks.workflows.review.step3': 'Watch labels: ai-review → ai-reviewing → ai-reviewed (or ai-review-failed).',
  'howItWorks.workflows.review.step4': 'Read the review comment on the PR/MR.',

  'howItWorks.lifecycle.heading': 'Label lifecycle',
  'howItWorks.lifecycle.intro':
    'Labels follow a short lifecycle for each workflow. You add the start label(s); the worker replaces them with status labels as the job runs and finishes. Do not remove status labels mid-run.',
  'howItWorks.lifecycle.implement.heading': 'Implement (code change)',
  'howItWorks.lifecycle.implement.body':
    'Start: you add ai on an open issue (or open PR/MR). Running: the worker takes a fresh checkout of the target branch and sets ai-working. Success: ai-pr, and either a new/updated PR/MR against the target branch or a force-push to that branch plus an issue comment. Failure: ai-failed. Retry by fixing the request if needed and adding ai again.',
  'howItWorks.lifecycle.qa.heading': 'Q&A (no code changes)',
  'howItWorks.lifecycle.qa.body':
    'Start: you add ai and no-change on an open issue. Running: ai-working stays together with no-change. Success: ai-answered + no-change, with the answer in an issue comment (no branch, no PR/MR). Failure: ai-failed + no-change. Ask again by removing ai-answered, keeping no-change, and adding ai.',
  'howItWorks.lifecycle.review.heading': 'Review (PR/MR)',
  'howItWorks.lifecycle.review.body':
    'Start: you add ai-review on an already open PR (GitHub) or MR (GitLab). Running: ai-reviewing. Success: ai-reviewed plus a review comment on the PR/MR. Failure: ai-review-failed. Retry by adding ai-review again.',

  'howItWorks.repoOptions.heading': 'Repository options',
  'howItWorks.repoOptions.intro':
    'On each repository page you can control which branch jobs start from and how implement results are published.',
  'howItWorks.repoOptions.targetBranch':
    'PR / MR target branch — base branch for new pull/merge requests (for example main, master, or develop). Also used as the clean checkout for each run.',
  'howItWorks.repoOptions.freshCheckout':
    'Fresh checkout — before each job the worker fetches origin/<target branch>, hard-resets to that tip, and discards uncommitted workspace changes so every run starts clean.',
  'howItWorks.repoOptions.forcePush':
    'Force-push to target branch (skip PR/MR) — off by default. When enabled, issue implement force-pushes onto the target branch instead of opening a PR/MR, and posts a result comment on the issue. This overwrites the remote branch; use with care.',

  'howItWorks.labels.heading': 'Label reference',
  'howItWorks.labels.intro':
    'You normally only add ai, ai + no-change, or ai-review. The worker manages status labels through the lifecycle above (ai-working, ai-pr, ai-answered, ai-failed, ai-reviewing, ai-reviewed, ai-review-failed).',
  'howItWorks.labels.youAdd': 'You add',
  'howItWorks.labels.workerAdds': 'Worker adds',
  'howItWorks.labels.ai': 'Queue implement, or Q&A when combined with no-change',
  'howItWorks.labels.noChange': 'With ai: answer only — no branch and no PR/MR',
  'howItWorks.labels.aiWorking': 'Implement or Q&A is in progress',
  'howItWorks.labels.aiPr':
    'Implement finished; PR/MR created or updated (or force-pushed to the target branch when that option is on)',
  'howItWorks.labels.aiAnswered': 'Q&A finished; answer posted as a comment',
  'howItWorks.labels.aiFailed': 'Implement or Q&A failed — check tasks or logs',
  'howItWorks.labels.aiReview': 'Queue an AI review on an open PR/MR',
  'howItWorks.labels.aiReviewing': 'Review is in progress',
  'howItWorks.labels.aiReviewed': 'Review comment posted',
  'howItWorks.labels.aiReviewFailed': 'Review failed — check tasks or logs',

  'howItWorks.tips.heading': 'Forge tips',
  'howItWorks.tips.item1': 'Keep the issue or PR/MR open while the worker runs.',
  'howItWorks.tips.item2': 'Write a clear title and body; newer comments override older ones when they conflict.',
  'howItWorks.tips.item3': 'To retry after failure, fix the issue if needed, then add ai or ai-review again.',
  'howItWorks.tips.item4': 'Labels are created automatically when a repo is registered; you can also run Setup labels on the repository page.',
  'howItWorks.tips.item5':
    'Set the target branch on the repository page before implement jobs. Leave force-push off unless you intentionally want direct pushes to that branch.',

  'howItWorks.panel.heading': 'Working in this panel',
  'howItWorks.panel.intro':
    'Use the panel to connect forges and AI providers, enable repositories, tune prompts and settings, and monitor tasks. Everyday coding work still happens with labels in GitHub or GitLab.',
  'howItWorks.panel.setup.heading': 'Recommended setup order',
  'howItWorks.panel.setup.item1': 'Providers — connect Cursor, Claude, Codex, and/or Gemini, enable at least one, and set a default.',
  'howItWorks.panel.setup.item2': 'Connections — connect GitHub and/or GitLab with a token that has the scopes above.',
  'howItWorks.panel.setup.item3': 'Repositories — wait for discovery or click Fetch, then enable the repos you want automated.',
  'howItWorks.panel.setup.item4': 'Optional — Setup labels and Setup webhooks for faster wake-ups when APP_BASE_URL is reachable.',

  'howItWorks.panel.pages.heading': 'What each page is for',
  'howItWorks.panel.pages.dashboard': 'Dashboard — AI usage, worker metrics, and recent runs.',
  'howItWorks.panel.pages.connections': 'Connections — forge tokens, discovery, webhooks, and the optional SSH public key.',
  'howItWorks.panel.pages.repositories':
    'Repositories — register, enable/disable, clone status, target branch, optional force-push, per-repo provider and prompts.',
  'howItWorks.panel.pages.tasks': 'Tasks — live forge queue and run history for implement, review, and related jobs.',
  'howItWorks.panel.pages.providers': 'Providers — Cursor / Claude / Codex / Gemini credentials, enablement, health checks, and default.',
  'howItWorks.panel.pages.prompts': 'Prompts — global templates and snippets used by the worker.',
  'howItWorks.panel.pages.settings': 'Settings — poll interval, concurrency, defaults, retention, and UI preferences.',
  'howItWorks.panel.pages.system': 'System — operational health and platform status.',
  'howItWorks.panel.pages.audit': 'Audit — security-relevant actions recorded by the app.',

  'about.title': 'About AI Worker',
  'about.subtitle': 'Product overview, services, contact, and license',
  'about.product.heading': 'About AI Worker',
  'about.product.p1':
    'AI Worker is a self-hosted AI coding assistant for GitHub and GitLab. Label an issue or pull/merge request, and it runs supported AI coding tools in your environment to implement work or review changes.',
  'about.product.p2':
    'It is built for teams that want automation on their own infrastructure—including organizations running GitLab Self-Managed—without sending repositories to a third-party hosted agent service.',
  'about.services.heading': 'Services',
  'about.services.intro':
    'Paid professional services are available on request for companies and development teams. Engagements are scoped per request; no public price list is published here.',
  'about.services.item1': 'AI Worker installation and deployment',
  'about.services.item2': 'Security hardening and configuration',
  'about.services.item3': 'GitHub and GitLab Self-Managed integration',
  'about.services.item4': 'Custom AI workflows, prompts, and integrations',
  'about.services.item5': 'Ongoing maintenance and technical support',
  'about.contact.heading': 'Contact and collaboration',
  'about.collaboration': 'Collaboration',
  'about.license.heading': 'License',
  'about.license.view': 'View LICENSE in the repository',
  'about.license.pending': 'License information pending',

  'dashboard.title': 'Dashboard',
  'dashboard.subtitle': 'AI service usage, plan status, and live worker metrics',
  'dashboard.timeWindow': 'Time window',
  'dashboard.refresh': 'Refresh',
  'dashboard.loadError': 'Could not load dashboard',
  'dashboard.repositories': 'Repositories',
  'dashboard.enabledCount': '{count} enabled',
  'dashboard.worker': 'Worker',
  'dashboard.activeCount': '{count} active',
  'dashboard.defaultProvider': 'default {provider}',
  'dashboard.forgeQueue': 'Forge queue',
  'dashboard.workingWaiting': 'working / waiting · {total} labeled',
  'dashboard.successWindow': 'Success · {hours}h',
  'dashboard.okFailAvg': '{ok} ok / {fail} fail · avg {avg}',
  'dashboard.aiServices': 'AI services',
  'dashboard.aiServicesHint': 'Plan / account and recorded usage for the selected window',
  'dashboard.manageProviders': 'Manage providers',
  'dashboard.defaultBadge': 'default',
  'dashboard.enabled': 'enabled',
  'dashboard.disabled': 'disabled',
  'dashboard.planAccount': 'Plan / account',
  'dashboard.planUnknown': 'Plan unknown',
  'dashboard.notConnected': 'Not connected',
  'dashboard.planUnavailable': 'Plan unavailable',
  'dashboard.credentialsConnected': 'Credentials connected',
  'dashboard.noCredentials': 'No credentials',
  'dashboard.model': 'Model {model}',
  'dashboard.cli': 'CLI {version}',
  'dashboard.usageWindow': 'Usage · {hours}h',
  'dashboard.runsCount': '{count} runs',
  'dashboard.usageSummary': '{ok} ok · {fail} fail · {rate} success',
  'dashboard.durationSummary': 'avg {avg} · total {total}',
  'dashboard.runningCount': '{count} running',
  'dashboard.byTaskType': 'By task type',
  'dashboard.noRuns': 'No runs recorded for this provider in the window.',
  'dashboard.noRunsUnassigned':
    'Older runs may lack a provider tag until the worker is updated.',
  'dashboard.finishedTasks': 'Finished tasks',
  'dashboard.finishedTasksHint': 'Completed runs in the selected window · status and token usage',
  'dashboard.allTasks': 'All tasks',
  'dashboard.noFinishedTasks': 'No finished tasks in the last {hours}h.',
  'dashboard.col.task': 'Task',
  'dashboard.col.repo': 'Repo',
  'dashboard.col.type': 'Type',
  'dashboard.col.status': 'Status',
  'dashboard.col.provider': 'Provider',
  'dashboard.col.duration': 'Duration',
  'dashboard.col.tokens': 'Tokens',
  'dashboard.col.finished': 'Finished',
  'dashboard.tokensDetail': 'cache read {read} · cache write {write}',
  'dashboard.tokensNotRecorded': 'Token usage not recorded for this run',
  'dashboard.usageDetail': '{total} (in {input} / out {output})',
  'dashboard.recentExecutions': 'Recent executions',
  'dashboard.noExecutions': 'No executions recorded yet.',
  'dashboard.providerNa': 'provider n/a',
  'dashboard.operationalEvents': 'Operational events',
  'dashboard.noEvents': 'No worker events yet.',
  'dashboard.latestFailures': 'Latest failures',
  'dashboard.noFailures': 'No recent failures in the loaded set.',
  'dashboard.noSummary': 'No summary',
} as const

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>

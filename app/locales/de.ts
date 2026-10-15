import type { Messages } from './en'

/** German */
export const de: Messages = {
  'nav.dashboard': 'Dashboard',
  'nav.connections': 'Verbindungen',
  'nav.repositories': 'Repositories',
  'nav.tasks': 'Aufgaben',
  'nav.providers': 'Anbieter',
  'nav.prompts': 'Prompts',
  'nav.settings': 'Einstellungen',
  'nav.system': 'System',
  'nav.audit': 'Audit',
  'nav.howItWorks': 'So funktioniert\'s',
  'nav.about': 'Über',
  'nav.logout': 'Abmelden',

  'layout.platform': 'Plattform',
  'layout.mainNav': 'Hauptnavigation',
  'layout.footerNav': 'Fußzeile',
  'layout.lightMode': 'Zum hellen Modus wechseln',
  'layout.darkMode': 'Zum dunklen Modus wechseln',
  'layout.language': 'Sprache',
  'setup.nav.needsAttention': 'Aufmerksamkeit erforderlich',
  'setup.warn.provider.title': 'KI-Anbieter verbinden',
  'setup.warn.provider.description': 'Aktivieren und verbinden Sie mindestens einen KI-Anbieter (Cursor, Claude oder Codex), bevor Aufgaben laufen können.',
  'setup.warn.provider.action': 'Anbieter öffnen',
  'setup.warn.connection.title': 'GitHub oder GitLab verbinden',
  'setup.warn.connection.description': 'Fügen Sie mindestens eine funktionierende Forge-Verbindung hinzu und registrieren Sie dann ein Repository.',
  'setup.warn.connection.unhealthyTitle': 'Forge-Verbindungen brauchen Aufmerksamkeit',
  'setup.warn.connection.unhealthyDescription': 'Alle Forge-Verbindungen haben Fehler oder sind getrennt. Reparieren oder erneut verbinden.',
  'setup.warn.connection.action': 'Verbindungen öffnen',
  'setup.warn.repository.title': 'Repository aktivieren',
  'setup.warn.repository.description': 'Registrieren und aktivieren Sie mindestens ein Repository, damit der Worker gelabelte Issues übernehmen kann.',
  'setup.warn.repository.noneEnabledDescription': 'Repositories sind registriert, aber keines ist aktiviert. Aktivieren Sie mindestens eines.',
  'setup.warn.repository.action': 'Repositories öffnen',

  'footer.howItWorks': 'So funktioniert\'s',
  'footer.about': 'Über',
  'footer.repository': 'Repository',
  'footer.license': 'Lizenz',
  'footer.contact': 'Kontakt',

  'howItWorks.title': 'So funktioniert\'s',
  'howItWorks.subtitle': 'Tutorial für GitHub, GitLab und dieses Panel',
  'howItWorks.intro.heading': 'Überblick',
  'howItWorks.intro.p1':
    'AI Worker ist ein selbst gehosteter Coding-Assistent für GitHub und GitLab. Die tägliche Arbeit wird über Labels an Issues und Pull-/Merge-Requests gesteuert. Dieses Panel dient der Einrichtung, Überwachung und Konfiguration.',
  'howItWorks.intro.p2':
    'Verbinden Sie hier zuerst Ihre Forge und KI-Anbieter, aktivieren Sie Repositories und nutzen Sie anschließend Labels in GitHub oder GitLab, um Implementierungs-, Frage-/Antwort- oder Review-Jobs einzureihen. Der KI-Agent bearbeitet nur den zugewiesenen Workspace; Commit, Push, PR/MR und Forge-Kommentare übernimmt die vertrauenswürdige AI-Worker-Orchestrierung — der Agent kann Ihre Forge-Tokens nicht selbstständig verwenden.',
  'howItWorks.forge.heading': 'Arbeiten in GitHub und GitLab',
  'howItWorks.forge.intro':
    'Die tägliche Arbeit findet in GitHub oder GitLab statt — nicht in einem Terminal auf dem AI-Worker-Host. Sobald ein Repository verbunden und aktiviert ist, öffnen Sie ein Issue oder eine PR/MR, beschreiben Sie ein klares Ziel, fügen Sie die passenden Labels hinzu und lassen Sie den Eintrag offen, während der Worker läuft. Status-Labels zeigen den Fortschritt; prüfen Sie danach die PR/MR, den Issue-Kommentar oder (bei Force-Push) die Commits auf dem Zielbranch.',
  'howItWorks.forge.practice.heading': 'So arbeiten Sie in der Forge',
  'howItWorks.forge.practice.item1':
    'Behandeln Sie jedes Issue oder PR/MR als eine Anfrage: ein klarer Titel und Text geben dem Agenten ein einziges Ziel.',
  'howItWorks.forge.practice.item2':
    'Sie fügen nur Trigger-Labels hinzu — ai (Implementierung), ai + no-change (Q&A) oder ai-review (Review). Status-Labels setzen Sie nicht selbst; der Worker verwaltet sie.',
  'howItWorks.forge.practice.item3':
    'Setzen Sie den Repository-Zielbranch in diesem Panel, bevor Implement-Jobs laufen. Bevorzugen Sie den Standard-PR/MR-Ablauf; Force-Push nur einschalten, wenn Sie absichtlich direkte Commits auf diesen Branch wollen.',
  'howItWorks.forge.practice.item4':
    'Lassen Sie das Issue oder die PR/MR offen, bis der Job fertig ist. Zum erneuten Versuch nach einem Fehler beheben Sie bei Bedarf die Anfrage und fügen ai oder ai-review erneut hinzu. Für eine weitere Q&A-Runde: no-change behalten, ai-answered entfernen und ai hinzufügen.',
  'howItWorks.forge.tokens.heading': 'Tokens und Zugriff',
  'howItWorks.forge.tokens.github':
    'GitHub: Verwenden Sie einen klassischen PAT mit dem Scope repo (workflow optional) oder ein Fine-Grained-Token mit Metadata lesen sowie Contents, Issues und Pull requests lesen/schreiben. Fügen Sie ihn unter Connections → Connect GitHub ein.',
  'howItWorks.forge.tokens.gitlab':
    'GitLab (gitlab.com oder selbst verwaltet): Erstellen Sie ein Personal Access Token mit dem Scope api und setzen Sie unter Connections → Connect GitLab die Server-URL und das Token. read_api allein reicht für den vollen Worker-Betrieb nicht aus.',
  'howItWorks.forge.tokens.git':
    'Git-Clone und -Push nutzen standardmäßig HTTPS mit Ihrem Token. Wenn GitLab HTTP(S)-Git blockiert, aktivieren Sie Both oder HTTP in den Git-Zugriffsprotokollen der GitLab-Administration, oder fügen Sie den auf Connections angezeigten SSH-Public-Key der Plattform hinzu. Forge-Tokens und SSH-Schlüssel bleiben beim vertrauenswürdigen Worker-Orchestrierungsprozess und werden dem KI-Agentenprozess nicht übergeben.',
  'howItWorks.workflows.heading': 'Übliche Forge-Workflows',
  'howItWorks.workflows.implement.heading': 'Eine Änderung implementieren',
  'howItWorks.workflows.implement.step1': 'Bestätigen Sie auf der Repository-Seite den Zielbranch (und optional Force-Push).',
  'howItWorks.workflows.implement.step2': 'Öffnen Sie ein Issue (oder ein offenes PR/MR) mit klarem Titel und Beschreibung.',
  'howItWorks.workflows.implement.step3': 'Fügen Sie das Label ai hinzu.',
  'howItWorks.workflows.implement.step4': 'Beobachten Sie die Labels: ai → ai-working → ai-pr (oder ai-failed).',
  'howItWorks.workflows.implement.step5':
    'Prüfen Sie das PR/MR des Workers — oder bei aktiviertem Force-Push die Commits auf dem Zielbranch und den Issue-Kommentar.',
  'howItWorks.workflows.qa.heading': 'Eine Frage stellen (ohne Codeänderungen)',
  'howItWorks.workflows.qa.step1': 'Öffnen Sie ein Issue mit Ihrer Frage.',
  'howItWorks.workflows.qa.step2': 'Fügen Sie sowohl ai als auch no-change hinzu.',
  'howItWorks.workflows.qa.step3': 'Warten Sie auf einen Issue-Kommentar. Endgültige Labels: ai-answered + no-change.',
  'howItWorks.workflows.qa.step4':
    'Für eine weitere Frage: no-change behalten, ai-answered entfernen und ai erneut hinzufügen.',
  'howItWorks.workflows.review.heading': 'Einen Pull- oder Merge-Request reviewen',
  'howItWorks.workflows.review.step1': 'Öffnen Sie eine PR auf GitHub oder eine MR auf GitLab.',
  'howItWorks.workflows.review.step2': 'Fügen Sie das Label ai-review hinzu.',
  'howItWorks.workflows.review.step3': 'Beobachten Sie die Labels: ai-review → ai-reviewing → ai-reviewed (oder ai-review-failed).',
  'howItWorks.workflows.review.step4': 'Lesen Sie den Review-Kommentar an der PR/MR.',
  'howItWorks.lifecycle.heading': 'Label-Lebenszyklus',
  'howItWorks.lifecycle.intro':
    'Labels folgen für jeden Workflow einem kurzen Lebenszyklus. Sie setzen die Start-Labels; der Worker ersetzt sie durch Status-Labels, während der Job läuft und endet. Entfernen Sie Status-Labels nicht mitten im Lauf.',
  'howItWorks.lifecycle.implement.heading': 'Implementierung (Codeänderung)',
  'howItWorks.lifecycle.implement.body':
    'Start: Sie fügen ai auf einem offenen Issue (oder offenem PR/MR) hinzu. Laufend: der Worker holt einen frischen Checkout des Zielbranchs und setzt ai-working. Erfolg: ai-pr sowie eine neue/aktualisierte PR/MR gegen den Zielbranch oder Force-Push auf diesen Branch plus Issue-Kommentar. Fehler: ai-failed. Erneut versuchen, indem Sie die Anfrage bei Bedarf korrigieren und ai wieder hinzufügen.',
  'howItWorks.lifecycle.qa.heading': 'Q&A (ohne Codeänderungen)',
  'howItWorks.lifecycle.qa.body':
    'Start: Sie fügen ai und no-change auf einem offenen Issue hinzu. Laufend: ai-working bleibt zusammen mit no-change. Erfolg: ai-answered + no-change mit der Antwort als Issue-Kommentar (kein Branch, keine PR/MR). Fehler: ai-failed + no-change. Erneut fragen: ai-answered entfernen, no-change behalten und ai hinzufügen.',
  'howItWorks.lifecycle.review.heading': 'Review (PR/MR)',
  'howItWorks.lifecycle.review.body':
    'Start: Sie fügen ai-review auf einer bereits offenen PR (GitHub) oder MR (GitLab) hinzu. Laufend: ai-reviewing. Erfolg: ai-reviewed plus Review-Kommentar an der PR/MR. Fehler: ai-review-failed. Erneut versuchen mit erneutem ai-review.',
  'howItWorks.repoOptions.heading': 'Repository-Optionen',
  'howItWorks.repoOptions.intro':
    'Auf jeder Repository-Seite steuern Sie, von welchem Branch Jobs starten und wie Implementierungsergebnisse veröffentlicht werden.',
  'howItWorks.repoOptions.targetBranch':
    'PR-/MR-Zielbranch — Basis für neue Pull-/Merge-Requests (z. B. main, master oder develop). Auch die saubere Checkout-Basis für jeden Lauf.',
  'howItWorks.repoOptions.freshCheckout':
    'Frischer Checkout — vor jedem Job holt der Worker origin/<Zielbranch>, setzt hard-reset auf diesen Stand und verwirft uncommittete Workspace-Änderungen.',
  'howItWorks.repoOptions.forcePush':
    'Force-Push auf Zielbranch (ohne PR/MR) — standardmäßig aus. Wenn aktiv, pusht Issue-Implement force auf den Zielbranch statt ein PR/MR zu öffnen und kommentiert das Issue. Überschreibt den Remote-Branch; mit Vorsicht nutzen.',
  'howItWorks.labels.heading': 'Label-Referenz',
  'howItWorks.labels.intro':
    'Normalerweise fügen Sie nur ai, ai + no-change oder ai-review hinzu. Der Worker verwaltet Status-Labels gemäß dem Lebenszyklus oben (ai-working, ai-pr, ai-answered, ai-failed, ai-reviewing, ai-reviewed, ai-review-failed).',
  'howItWorks.labels.youAdd': 'Sie fügen hinzu',
  'howItWorks.labels.workerAdds': 'Worker fügt hinzu',
  'howItWorks.labels.ai': 'Implementierung einreihen, oder Q&A in Kombination mit no-change',
  'howItWorks.labels.noChange': 'Mit ai: nur antworten — kein Branch und keine PR/MR',
  'howItWorks.labels.aiWorking': 'Implementierung oder Q&A läuft',
  'howItWorks.labels.aiPr':
    'Implementierung fertig; PR/MR erstellt oder aktualisiert (oder Force-Push auf den Zielbranch, wenn diese Option an ist)',
  'howItWorks.labels.aiAnswered': 'Q&A abgeschlossen; Antwort als Kommentar veröffentlicht',
  'howItWorks.labels.aiFailed': 'Implementierung oder Q&A fehlgeschlagen — Tasks oder Logs prüfen',
  'howItWorks.labels.aiReview': 'KI-Review für eine offene PR/MR einreihen',
  'howItWorks.labels.aiReviewing': 'Review läuft',
  'howItWorks.labels.aiReviewed': 'Review-Kommentar veröffentlicht',
  'howItWorks.labels.aiReviewFailed': 'Review fehlgeschlagen — Tasks oder Logs prüfen',
  'howItWorks.tips.heading': 'Forge-Tipps',
  'howItWorks.tips.item1': 'Lassen Sie das Issue oder die PR/MR offen, während der Worker läuft.',
  'howItWorks.tips.item2':
    'Schreiben Sie einen klaren Titel und Text; neuere Kommentare haben bei Konflikten Vorrang vor älteren.',
  'howItWorks.tips.item3':
    'Zum erneuten Versuch nach einem Fehler beheben Sie bei Bedarf das Issue und fügen Sie ai oder ai-review erneut hinzu.',
  'howItWorks.tips.item4':
    'Labels werden automatisch erstellt, wenn ein Repo registriert wird; Sie können auch Setup labels auf der Repository-Seite ausführen.',
  'howItWorks.tips.item5':
    'Setzen Sie den Zielbranch auf der Repository-Seite, bevor Implement-Jobs laufen. Force-Push nur einschalten, wenn Sie absichtlich direkt auf diesen Branch pushen wollen.',
  'howItWorks.panel.heading': 'Arbeiten in diesem Panel',
  'howItWorks.panel.intro':
    'Nutzen Sie das Panel, um Forges und KI-Anbieter zu verbinden, Repositories zu aktivieren, Prompts und Settings anzupassen und Tasks zu überwachen. Die tägliche Coding-Arbeit läuft weiterhin über Labels in GitHub oder GitLab.',
  'howItWorks.panel.setup.heading': 'Empfohlene Einrichtungsreihenfolge',
  'howItWorks.panel.setup.item1':
    'Providers — verbinden Sie Cursor, Claude und/oder Codex, aktivieren Sie mindestens einen und legen Sie einen Standard fest.',
  'howItWorks.panel.setup.item2':
    'Connections — verbinden Sie GitHub und/oder GitLab mit einem Token, das die oben genannten Scopes hat.',
  'howItWorks.panel.setup.item3':
    'Repositories — warten Sie auf die Erkennung oder klicken Sie auf Fetch, und aktivieren Sie dann die gewünschten Repos.',
  'howItWorks.panel.setup.item4':
    'Optional — Setup labels und Setup webhooks für schnellere Aufwachzeiten, wenn APP_BASE_URL erreichbar ist.',
  'howItWorks.panel.pages.heading': 'Wofür jede Seite gedacht ist',
  'howItWorks.panel.pages.dashboard': 'Dashboard — KI-Nutzung, Worker-Metriken und aktuelle Läufe.',
  'howItWorks.panel.pages.connections': 'Connections — Forge-Tokens, Erkennung, Webhooks und optionaler SSH-Public-Key.',
  'howItWorks.panel.pages.repositories':
    'Repositories — Registrieren, aktivieren/deaktivieren, Clone-Status, Zielbranch, optionaler Force-Push, Provider und Prompts pro Repo.',
  'howItWorks.panel.pages.tasks':
    'Tasks — Live-Forge-Warteschlange und Laufhistorie für Implementierung, Review und verwandte Jobs.',
  'howItWorks.panel.pages.providers': 'Providers — Cursor-/Claude-/Codex-Zugangsdaten, Aktivierung, Health-Checks und Standard.',
  'howItWorks.panel.pages.prompts': 'Prompts — globale Vorlagen und Snippets, die der Worker verwendet.',
  'howItWorks.panel.pages.settings': 'Settings — Abfrageintervall, Parallelität, Standards, Aufbewahrung und UI-Einstellungen.',
  'howItWorks.panel.pages.system': 'System — Betriebszustand und Plattformstatus.',
  'howItWorks.panel.pages.audit': 'Audit — sicherheitsrelevante Aktionen, die die App protokolliert.',


  'about.title': 'Über AI Worker',
  'about.subtitle': 'Produktübersicht, Services, Kontakt und Lizenz',
  'about.product.heading': 'Über AI Worker',
  'about.product.p1':
    'AI Worker ist ein selbst gehosteter KI-Coding-Assistent für GitHub und GitLab. Kennzeichnen Sie ein Issue oder einen Pull/Merge Request, und unterstützte KI-Tools werden in Ihrer Umgebung ausgeführt, um Arbeit umzusetzen oder Änderungen zu prüfen.',
  'about.product.p2':
    'Er ist für Teams gebaut, die Automatisierung auf eigener Infrastruktur wollen—einschließlich Organisationen mit GitLab Self-Managed—ohne Repositories an einen gehosteten Drittanbieter-Agenten zu senden.',
  'about.services.heading': 'Services',
  'about.services.intro':
    'Kostenpflichtige Professional Services sind auf Anfrage für Unternehmen und Entwicklungsteams verfügbar. Einsätze werden je Anfrage definiert; eine öffentliche Preisliste wird hier nicht veröffentlicht.',
  'about.services.item1': 'Installation und Bereitstellung von AI Worker',
  'about.services.item2': 'Sicherheits-Härtung und Konfiguration',
  'about.services.item3': 'GitHub- und GitLab-Self-Managed-Integration',
  'about.services.item4': 'Individuelle KI-Workflows, Prompts und Integrationen',
  'about.services.item5': 'Laufende Wartung und technischer Support',
  'about.contact.heading': 'Kontakt und Zusammenarbeit',
  'about.collaboration': 'Zusammenarbeit',
  'about.license.heading': 'Lizenz',
  'about.license.view': 'LICENSE im Repository ansehen',
  'about.license.pending': 'Lizenzinformationen ausstehend',

  'dashboard.title': 'Dashboard',
  'dashboard.subtitle': 'KI-Service-Nutzung, Planstatus und Live-Worker-Metriken',
  'dashboard.timeWindow': 'Zeitfenster',
  'dashboard.refresh': 'Aktualisieren',
  'dashboard.loadError': 'Dashboard konnte nicht geladen werden',
  'dashboard.repositories': 'Repositories',
  'dashboard.enabledCount': '{count} aktiviert',
  'dashboard.worker': 'Worker',
  'dashboard.activeCount': '{count} aktiv',
  'dashboard.defaultProvider': 'Standard {provider}',
  'dashboard.forgeQueue': 'Forge-Warteschlange',
  'dashboard.workingWaiting': 'arbeitend / wartend · {total} gelabelt',
  'dashboard.successWindow': 'Erfolg · {hours}h',
  'dashboard.okFailAvg': '{ok} ok / {fail} Fehler · Ø {avg}',
  'dashboard.aiServices': 'KI-Dienste',
  'dashboard.aiServicesHint': 'Plan / Konto und erfasste Nutzung für das gewählte Fenster',
  'dashboard.manageProviders': 'Anbieter verwalten',
  'dashboard.defaultBadge': 'Standard',
  'dashboard.enabled': 'aktiviert',
  'dashboard.disabled': 'deaktiviert',
  'dashboard.planAccount': 'Plan / Konto',
  'dashboard.planUnknown': 'Plan unbekannt',
  'dashboard.notConnected': 'Nicht verbunden',
  'dashboard.planUnavailable': 'Plan nicht verfügbar',
  'dashboard.credentialsConnected': 'Zugangsdaten verbunden',
  'dashboard.noCredentials': 'Keine Zugangsdaten',
  'dashboard.model': 'Modell {model}',
  'dashboard.cli': 'CLI {version}',
  'dashboard.usageWindow': 'Nutzung · {hours}h',
  'dashboard.runsCount': '{count} Läufe',
  'dashboard.usageSummary': '{ok} ok · {fail} Fehler · {rate} Erfolg',
  'dashboard.durationSummary': 'Ø {avg} · gesamt {total}',
  'dashboard.runningCount': '{count} laufend',
  'dashboard.byTaskType': 'Nach Aufgabentyp',
  'dashboard.noRuns': 'Keine Läufe für diesen Anbieter im Fenster erfasst.',
  'dashboard.noRunsUnassigned':
    'Ältere Läufe können bis zum Worker-Update ohne Anbieter-Tag sein.',
  'dashboard.finishedTasks': 'Abgeschlossene Aufgaben',
  'dashboard.finishedTasksHint': 'Abgeschlossene Läufe im gewählten Fenster · Status und Token-Nutzung',
  'dashboard.allTasks': 'Alle Aufgaben',
  'dashboard.noFinishedTasks': 'Keine abgeschlossenen Aufgaben in den letzten {hours}h.',
  'dashboard.col.task': 'Aufgabe',
  'dashboard.col.repo': 'Repo',
  'dashboard.col.type': 'Typ',
  'dashboard.col.status': 'Status',
  'dashboard.col.provider': 'Anbieter',
  'dashboard.col.duration': 'Dauer',
  'dashboard.col.tokens': 'Tokens',
  'dashboard.col.finished': 'Beendet',
  'dashboard.tokensDetail': 'Cache lesen {read} · Cache schreiben {write}',
  'dashboard.tokensNotRecorded': 'Token-Nutzung für diesen Lauf nicht erfasst',
  'dashboard.usageDetail': '{total} (ein {input} / aus {output})',
  'dashboard.recentExecutions': 'Letzte Ausführungen',
  'dashboard.noExecutions': 'Noch keine Ausführungen erfasst.',
  'dashboard.providerNa': 'Anbieter n/v',
  'dashboard.operationalEvents': 'Betriebliche Ereignisse',
  'dashboard.noEvents': 'Noch keine Worker-Ereignisse.',
  'dashboard.latestFailures': 'Letzte Fehler',
  'dashboard.noFailures': 'Keine aktuellen Fehler im geladenen Satz.',
  'dashboard.noSummary': 'Keine Zusammenfassung',
}

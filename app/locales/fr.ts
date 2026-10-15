import type { Messages } from './en'

/** French */
export const fr: Messages = {
  'nav.dashboard': 'Tableau de bord',
  'nav.connections': 'Connexions',
  'nav.repositories': 'Dépôts',
  'nav.tasks': 'Tâches',
  'nav.providers': 'Fournisseurs',
  'nav.prompts': 'Prompts',
  'nav.settings': 'Paramètres',
  'nav.system': 'Système',
  'nav.audit': 'Audit',
  'nav.howItWorks': 'Comment ça marche',
  'nav.about': 'À propos',
  'nav.logout': 'Déconnexion',

  'layout.platform': 'Plateforme',
  'layout.mainNav': 'Principal',
  'layout.footerNav': 'Pied de page',
  'layout.lightMode': 'Passer en mode clair',
  'layout.darkMode': 'Passer en mode sombre',
  'layout.language': 'Langue',
  'setup.nav.needsAttention': 'Attention requise',
  'setup.warn.provider.title': 'Connectez un fournisseur IA',
  'setup.warn.provider.description': 'Activez et connectez au moins un fournisseur IA (Cursor ou Claude) avant d’exécuter des tâches.',
  'setup.warn.provider.action': 'Ouvrir les fournisseurs',
  'setup.warn.connection.title': 'Connectez GitHub ou GitLab',
  'setup.warn.connection.description': 'Ajoutez au moins une connexion forge fonctionnelle, puis enregistrez un dépôt.',
  'setup.warn.connection.unhealthyTitle': 'Les connexions forge nécessitent une attention',
  'setup.warn.connection.unhealthyDescription': 'Toutes les connexions forge sont en erreur ou déconnectées. Réparez ou reconnectez-en une.',
  'setup.warn.connection.action': 'Ouvrir les connexions',
  'setup.warn.repository.title': 'Activez un dépôt',
  'setup.warn.repository.description': 'Enregistrez et activez au moins un dépôt pour que le worker puisse prendre les issues labellisées.',
  'setup.warn.repository.noneEnabledDescription': 'Des dépôts sont enregistrés mais aucun n’est activé. Activez-en au moins un.',
  'setup.warn.repository.action': 'Ouvrir les dépôts',

  'footer.howItWorks': 'Comment ça marche',
  'footer.about': 'À propos',
  'footer.repository': 'Dépôt',
  'footer.license': 'Licence',
  'footer.contact': 'Contact',

  'howItWorks.title': 'Comment ça marche',
  'howItWorks.subtitle': 'Tutoriel pour GitHub, GitLab et ce panneau',
  'howItWorks.intro.heading': 'Présentation',
  'howItWorks.intro.p1':
    'AI Worker est un assistant de développement auto-hébergé pour GitHub et GitLab. Le travail au quotidien est piloté par des labels sur les issues et les pull/merge requests. Ce panneau sert à la configuration, au suivi et aux réglages.',
  'howItWorks.intro.p2':
    'Commencez par connecter ici votre forge et vos fournisseurs d\'IA, activez des dépôts, puis utilisez des labels dans GitHub ou GitLab pour mettre en file des tâches d\'implémentation, de Q&R ou de revue.',
  'howItWorks.forge.heading': 'Travailler dans GitHub et GitLab',
  'howItWorks.forge.intro':
    'Le travail quotidien se fait dans GitHub ou GitLab — pas dans un terminal sur l’hôte AI Worker. Une fois un dépôt connecté et activé, ouvrez une issue ou une PR/MR, décrivez un objectif clair, ajoutez le(s) bon(s) label(s) et laissez l’élément ouvert pendant que le worker tourne. Suivez les labels de statut pour la progression, puis examinez la PR/MR, le commentaire d’issue, ou (si le force-push est activé) les commits sur la branche cible.',
  'howItWorks.forge.practice.heading': 'Comment travailler dans le forge',
  'howItWorks.forge.practice.item1':
    'Traitez chaque issue ou PR/MR comme une seule demande : un titre et un corps précis donnent à l’agent un objectif unique.',
  'howItWorks.forge.practice.item2':
    'Vous n’ajoutez que les labels déclencheurs — ai (implémentation), ai + no-change (Q&R), ou ai-review (revue). N’ajoutez pas vous-même les labels de statut ; le worker les gère.',
  'howItWorks.forge.practice.item3':
    'Définissez la branche cible du dépôt dans ce panneau avant les jobs d’implémentation. Préférez le flux PR/MR par défaut ; n’activez le force-push que si vous voulez volontairement des commits directs sur cette branche.',
  'howItWorks.forge.practice.item4':
    'Gardez l’issue ou la PR/MR ouverte jusqu’à la fin du job. Pour réessayer après un échec, corrigez la demande si besoin, puis rajoutez ai ou ai-review. Pour un autre tour de Q&R : gardez no-change, retirez ai-answered et ajoutez ai.',
  'howItWorks.forge.tokens.heading': 'Jetons et accès',
  'howItWorks.forge.tokens.github':
    'GitHub : utilisez un PAT classique avec le scope repo (workflow facultatif), ou un jeton à granularité fine avec Metadata en lecture plus Contents, Issues et Pull requests en lecture/écriture. Collez-le sous Connections → Connect GitHub.',
  'howItWorks.forge.tokens.gitlab':
    'GitLab (gitlab.com ou auto-hébergé) : créez un personal access token avec le scope api, puis sous Connections → Connect GitLab indiquez l\'URL du serveur et collez le jeton. read_api seul ne suffit pas pour toutes les opérations du worker.',
  'howItWorks.forge.tokens.git':
    'Le clone et le push Git utilisent HTTPS avec votre jeton par défaut. Si GitLab bloque git en HTTP(S), activez Both ou HTTP dans les protocoles d\'accès Git de l\'admin GitLab, ou ajoutez la clé publique SSH de la plateforme affichée sur Connections.',
  'howItWorks.workflows.heading': 'Flux de travail courants sur la forge',
  'howItWorks.workflows.implement.heading': 'Implémenter un changement',
  'howItWorks.workflows.implement.step1': 'Confirmez la branche cible du dépôt (et l’option force-push éventuelle) sur la page du dépôt.',
  'howItWorks.workflows.implement.step2': 'Ouvrez une issue (ou un PR/MR ouvert) avec un titre et une description clairs.',
  'howItWorks.workflows.implement.step3': 'Ajoutez le label ai.',
  'howItWorks.workflows.implement.step4': 'Suivez les labels : ai → ai-working → ai-pr (ou ai-failed).',
  'howItWorks.workflows.implement.step5':
    'Relisez le PR/MR ouvert par le worker, ou — si le force-push est activé — les commits sur la branche cible et le commentaire d’issue.',
  'howItWorks.workflows.qa.heading': 'Poser une question (sans modifier le code)',
  'howItWorks.workflows.qa.step1': 'Ouvrez une issue avec votre question.',
  'howItWorks.workflows.qa.step2': 'Ajoutez à la fois ai et no-change.',
  'howItWorks.workflows.qa.step3': 'Attendez un commentaire sur l\'issue. Labels finaux : ai-answered + no-change.',
  'howItWorks.workflows.qa.step4':
    'Pour poser une nouvelle question : conservez no-change, retirez ai-answered, puis ajoutez à nouveau ai.',
  'howItWorks.workflows.review.heading': 'Réviser une pull ou merge request',
  'howItWorks.workflows.review.step1': 'Ouvrez une PR sur GitHub ou une MR sur GitLab.',
  'howItWorks.workflows.review.step2': 'Ajoutez le label ai-review.',
  'howItWorks.workflows.review.step3': 'Observez les labels : ai-review → ai-reviewing → ai-reviewed (ou ai-review-failed).',
  'howItWorks.workflows.review.step4': 'Lisez le commentaire de revue sur la PR/MR.',
  'howItWorks.lifecycle.heading': 'Cycle de vie des labels',
  'howItWorks.lifecycle.intro':
    'Les labels suivent un cycle court pour chaque workflow. Vous ajoutez le(s) label(s) de départ ; le worker les remplace par des labels de statut pendant l’exécution et à la fin. Ne retirez pas les labels de statut en cours de run.',
  'howItWorks.lifecycle.implement.heading': 'Implémentation (changement de code)',
  'howItWorks.lifecycle.implement.body':
    'Départ : vous ajoutez ai sur une issue ouverte (ou une PR/MR ouverte). En cours : le worker fait un checkout frais de la branche cible et pose ai-working. Succès : ai-pr, puis une PR/MR nouvelle/mise à jour contre la branche cible, ou un force-push sur cette branche plus un commentaire d’issue. Échec : ai-failed. Réessayez en corrigeant la demande si besoin et en rajoutant ai.',
  'howItWorks.lifecycle.qa.heading': 'Q&R (sans changement de code)',
  'howItWorks.lifecycle.qa.body':
    'Départ : vous ajoutez ai et no-change sur une issue ouverte. En cours : ai-working reste avec no-change. Succès : ai-answered + no-change, avec la réponse en commentaire d’issue (pas de branche, pas de PR/MR). Échec : ai-failed + no-change. Pour reposer une question : retirez ai-answered, gardez no-change et ajoutez ai.',
  'howItWorks.lifecycle.review.heading': 'Revue (PR/MR)',
  'howItWorks.lifecycle.review.body':
    'Départ : vous ajoutez ai-review sur une PR déjà ouverte (GitHub) ou une MR (GitLab). En cours : ai-reviewing. Succès : ai-reviewed plus un commentaire de revue sur la PR/MR. Échec : ai-review-failed. Réessayez en rajoutant ai-review.',
  'howItWorks.repoOptions.heading': 'Options du dépôt',
  'howItWorks.repoOptions.intro':
    'Sur chaque page de dépôt, vous choisissez la branche de démarrage des jobs et la façon de publier les résultats d’implémentation.',
  'howItWorks.repoOptions.targetBranch':
    'Branche cible PR/MR — base des nouveaux pull/merge requests (par ex. main, master ou develop). Aussi utilisée comme checkout propre à chaque exécution.',
  'howItWorks.repoOptions.freshCheckout':
    'Checkout propre — avant chaque job, le worker récupère origin/<branche cible>, fait un hard-reset sur cette pointe et ignore les changements non commités du workspace.',
  'howItWorks.repoOptions.forcePush':
    'Force-push vers la branche cible (sans PR/MR) — désactivé par défaut. Activé, l’implémentation force-push sur la branche cible au lieu d’ouvrir un PR/MR, et commente l’issue. Écrase la branche distante ; à utiliser avec prudence.',
  'howItWorks.labels.heading': 'Référence des labels',
  'howItWorks.labels.intro':
    'Vous n’ajoutez en général que ai, ai + no-change, ou ai-review. Le worker gère les labels de statut selon le cycle ci-dessus (ai-working, ai-pr, ai-answered, ai-failed, ai-reviewing, ai-reviewed, ai-review-failed).',
  'howItWorks.labels.youAdd': 'Vous ajoutez',
  'howItWorks.labels.workerAdds': 'Le worker ajoute',
  'howItWorks.labels.ai': 'Met en file une implémentation, ou une Q&R si combiné avec no-change',
  'howItWorks.labels.noChange': 'Avec ai : réponse seule — pas de branche ni de PR/MR',
  'howItWorks.labels.aiWorking': 'Implémentation ou Q&R en cours',
  'howItWorks.labels.aiPr':
    'Implémentation terminée ; PR/MR créé ou mis à jour (ou force-push sur la branche cible si l’option est activée)',
  'howItWorks.labels.aiAnswered': 'Q&R terminée ; réponse publiée en commentaire',
  'howItWorks.labels.aiFailed': 'Échec de l\'implémentation ou de la Q&R — consultez tasks ou les logs',
  'howItWorks.labels.aiReview': 'Met en file une revue IA sur une PR/MR ouverte',
  'howItWorks.labels.aiReviewing': 'Revue en cours',
  'howItWorks.labels.aiReviewed': 'Commentaire de revue publié',
  'howItWorks.labels.aiReviewFailed': 'Échec de la revue — consultez tasks ou les logs',
  'howItWorks.tips.heading': 'Conseils pour la forge',
  'howItWorks.tips.item1': 'Laissez l\'issue ou la PR/MR ouverte pendant que le worker s\'exécute.',
  'howItWorks.tips.item2':
    'Rédigez un titre et un corps clairs ; les commentaires plus récents prévalent en cas de conflit.',
  'howItWorks.tips.item3':
    'Pour réessayer après un échec, corrigez l\'issue si besoin, puis ajoutez à nouveau ai ou ai-review.',
  'howItWorks.tips.item4':
    'Les labels sont créés automatiquement à l\'enregistrement d\'un dépôt ; vous pouvez aussi lancer Setup labels sur la page du dépôt.',
  'howItWorks.tips.item5':
    'Définissez la branche cible sur la page du dépôt avant les jobs d’implémentation. Laissez le force-push désactivé sauf si vous voulez pousser directement sur cette branche.',
  'howItWorks.panel.heading': 'Travailler dans ce panneau',
  'howItWorks.panel.intro':
    'Utilisez le panneau pour connecter les forges et les fournisseurs d\'IA, activer des dépôts, ajuster les prompts et les settings, et suivre les tasks. Le travail de développement au quotidien se fait toujours avec des labels dans GitHub ou GitLab.',
  'howItWorks.panel.setup.heading': 'Ordre de configuration recommandé',
  'howItWorks.panel.setup.item1':
    'Providers — connectez Cursor et/ou Claude, activez-en au moins un, et définissez une valeur par défaut.',
  'howItWorks.panel.setup.item2': 'Connections — connectez GitHub et/ou GitLab avec un jeton ayant les scopes ci-dessus.',
  'howItWorks.panel.setup.item3':
    'Repositories — attendez la découverte ou cliquez sur Fetch, puis activez les dépôts à automatiser.',
  'howItWorks.panel.setup.item4':
    'Facultatif — Setup labels et Setup webhooks pour des réveils plus rapides lorsque APP_BASE_URL est accessible.',
  'howItWorks.panel.pages.heading': 'Rôle de chaque page',
  'howItWorks.panel.pages.dashboard': 'Dashboard — usage de l\'IA, métriques du worker et exécutions récentes.',
  'howItWorks.panel.pages.connections': 'Connections — jetons de forge, découverte, webhooks et clé publique SSH facultative.',
  'howItWorks.panel.pages.repositories':
    'Repositories — enregistrer, activer/désactiver, état du clone, branche cible, force-push optionnel, fournisseur et prompts par dépôt.',
  'howItWorks.panel.pages.tasks':
    'Tasks — file forge en direct et historique des exécutions pour l\'implémentation, la revue et les tâches associées.',
  'howItWorks.panel.pages.providers':
    'Providers — identifiants Cursor / Claude, activation, contrôles de santé et valeur par défaut.',
  'howItWorks.panel.pages.prompts': 'Prompts — modèles globaux et extraits utilisés par le worker.',
  'howItWorks.panel.pages.settings':
    'Settings — intervalle de sondage, concurrence, valeurs par défaut, rétention et préférences d\'interface.',
  'howItWorks.panel.pages.system': 'System — santé opérationnelle et état de la plateforme.',
  'howItWorks.panel.pages.audit': 'Audit — actions liées à la sécurité enregistrées par l\'application.',


  'about.title': 'À propos d’AI Worker',
  'about.subtitle': 'Présentation du produit, services, contact et licence',
  'about.product.heading': 'À propos d’AI Worker',
  'about.product.p1':
    'AI Worker est un assistant de codage IA auto-hébergé pour GitHub et GitLab. Étiquetez une issue ou une pull/merge request, et il exécute des outils d’IA compatibles dans votre environnement pour implémenter le travail ou revoir les changements.',
  'about.product.p2':
    'Il est conçu pour les équipes qui veulent de l’automatisation sur leur propre infrastructure—y compris les organisations avec GitLab Self-Managed—sans envoyer les dépôts à un service d’agent hébergé tiers.',
  'about.services.heading': 'Services',
  'about.services.intro':
    'Des services professionnels payants sont disponibles sur demande pour les entreprises et les équipes de développement. Chaque mission est cadrée à la demande ; aucune grille tarifaire publique n’est publiée ici.',
  'about.services.item1': 'Installation et déploiement d’AI Worker',
  'about.services.item2': 'Durcissement de la sécurité et configuration',
  'about.services.item3': 'Intégration GitHub et GitLab Self-Managed',
  'about.services.item4': 'Workflows IA, prompts et intégrations personnalisés',
  'about.services.item5': 'Maintenance continue et support technique',
  'about.contact.heading': 'Contact et collaboration',
  'about.collaboration': 'Collaboration',
  'about.license.heading': 'Licence',
  'about.license.view': 'Voir LICENSE dans le dépôt',
  'about.license.pending': 'Informations de licence en attente',

  'dashboard.title': 'Tableau de bord',
  'dashboard.subtitle': 'Usage des services IA, état du forfait et métriques worker en direct',
  'dashboard.timeWindow': 'Fenêtre temporelle',
  'dashboard.refresh': 'Actualiser',
  'dashboard.loadError': 'Impossible de charger le tableau de bord',
  'dashboard.repositories': 'Dépôts',
  'dashboard.enabledCount': '{count} activés',
  'dashboard.worker': 'Worker',
  'dashboard.activeCount': '{count} actifs',
  'dashboard.defaultProvider': 'par défaut {provider}',
  'dashboard.forgeQueue': 'File forge',
  'dashboard.workingWaiting': 'en cours / en attente · {total} étiquetés',
  'dashboard.successWindow': 'Succès · {hours}h',
  'dashboard.okFailAvg': '{ok} ok / {fail} échecs · moy. {avg}',
  'dashboard.aiServices': 'Services IA',
  'dashboard.aiServicesHint': 'Forfait / compte et usage enregistré pour la fenêtre sélectionnée',
  'dashboard.manageProviders': 'Gérer les fournisseurs',
  'dashboard.defaultBadge': 'par défaut',
  'dashboard.enabled': 'activé',
  'dashboard.disabled': 'désactivé',
  'dashboard.planAccount': 'Forfait / compte',
  'dashboard.planUnknown': 'Forfait inconnu',
  'dashboard.notConnected': 'Non connecté',
  'dashboard.planUnavailable': 'Forfait indisponible',
  'dashboard.credentialsConnected': 'Identifiants connectés',
  'dashboard.noCredentials': 'Aucun identifiant',
  'dashboard.model': 'Modèle {model}',
  'dashboard.cli': 'CLI {version}',
  'dashboard.usageWindow': 'Usage · {hours}h',
  'dashboard.runsCount': '{count} exécutions',
  'dashboard.usageSummary': '{ok} ok · {fail} échecs · {rate} de succès',
  'dashboard.durationSummary': 'moy. {avg} · total {total}',
  'dashboard.runningCount': '{count} en cours',
  'dashboard.byTaskType': 'Par type de tâche',
  'dashboard.noRuns': 'Aucune exécution enregistrée pour ce fournisseur dans la fenêtre.',
  'dashboard.noRunsUnassigned':
    'Les anciennes exécutions peuvent manquer d’étiquette fournisseur jusqu’à la mise à jour du worker.',
  'dashboard.finishedTasks': 'Tâches terminées',
  'dashboard.finishedTasksHint': 'Exécutions terminées dans la fenêtre sélectionnée · statut et usage de tokens',
  'dashboard.allTasks': 'Toutes les tâches',
  'dashboard.noFinishedTasks': 'Aucune tâche terminée au cours des {hours} dernières heures.',
  'dashboard.col.task': 'Tâche',
  'dashboard.col.repo': 'Dépôt',
  'dashboard.col.type': 'Type',
  'dashboard.col.status': 'Statut',
  'dashboard.col.provider': 'Fournisseur',
  'dashboard.col.duration': 'Durée',
  'dashboard.col.tokens': 'Tokens',
  'dashboard.col.finished': 'Terminé',
  'dashboard.tokensDetail': 'cache lecture {read} · cache écriture {write}',
  'dashboard.tokensNotRecorded': 'Usage de tokens non enregistré pour cette exécution',
  'dashboard.usageDetail': '{total} (ent {input} / sort {output})',
  'dashboard.recentExecutions': 'Exécutions récentes',
  'dashboard.noExecutions': 'Aucune exécution enregistrée pour le moment.',
  'dashboard.providerNa': 'fournisseur n/d',
  'dashboard.operationalEvents': 'Événements opérationnels',
  'dashboard.noEvents': 'Aucun événement worker pour le moment.',
  'dashboard.latestFailures': 'Derniers échecs',
  'dashboard.noFailures': 'Aucun échec récent dans l’ensemble chargé.',
  'dashboard.noSummary': 'Aucun résumé',
}

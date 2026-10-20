import type { Messages } from './en'

/** Spanish */
export const es: Messages = {
  'nav.dashboard': 'Panel',
  'nav.connections': 'Conexiones',
  'nav.repositories': 'Repositorios',
  'nav.createTasks': 'Create tasks',
  'nav.tasks': 'Tareas',
  'nav.providers': 'Proveedores',
  'nav.prompts': 'Prompts',
  'nav.settings': 'Ajustes',
  'nav.system': 'Sistema',
  'nav.audit': 'Auditoría',
  'nav.howItWorks': 'Cómo funciona',
  'nav.about': 'Acerca de',
  'nav.logout': 'Cerrar sesión',

  'createTasks.title': 'Create tasks',
  'createTasks.subtitle': 'Chat with AI to turn an epic into GitHub or GitLab issues labeled ai — no engineering ticket writing required.',
  'createTasks.selectRepo': 'Choose a repository',
  'createTasks.selectRepoHint': 'Open a repo to start a planning chat. The assistant reads live code context when the workspace is cloned.',
  'createTasks.emptyRepos': 'No repositories yet. Connect a forge and register a repository first.',
  'createTasks.openChat': 'Open planning chat',
  'createTasks.newSession': 'New session',
  'createTasks.back': 'All repositories',
  'createTasks.composerPlaceholder': 'Describe the epic or answer the assistant’s questions…',
  'createTasks.send': 'Send',
  'createTasks.generate': 'Generate tasks',
  'createTasks.regenerate': 'Regenerate tasks',
  'createTasks.approve': 'Approve & create issues',
  'createTasks.draftCount': '{count} draft tasks',
  'createTasks.createdCount': '{count} issues created',
  'createTasks.status.clarifying': 'Clarifying',
  'createTasks.status.ready_to_generate': 'Ready to generate',
  'createTasks.status.draft': 'Draft ready',
  'createTasks.status.approved': 'Approved',
  'createTasks.status.created': 'Created on forge',
  'createTasks.providerHint': 'Uses Claude, Codex, or Gemini API (not Cursor/Copilot CLI).',
  'createTasks.codeContextOn': 'Live code context loaded',
  'createTasks.codeContextOff': 'Code context limited (workspace not ready)',
  'createTasks.you': 'You',
  'createTasks.assistant': 'Assistant',
  'createTasks.approveConfirm': 'Create {count} issue(s) on the forge with label “ai”, assigned to the connected git user?',
  'createTasks.error': 'Something went wrong',
  'createTasks.working': 'Thinking…',

  'layout.platform': 'Plataforma',
  'layout.mainNav': 'Principal',
  'layout.footerNav': 'Pie de página',
  'layout.lightMode': 'Cambiar a modo claro',
  'layout.darkMode': 'Cambiar a modo oscuro',
  'layout.language': 'Idioma',
  'setup.nav.needsAttention': 'Requiere atención',
  'setup.warn.provider.title': 'Conecta un proveedor de IA',
  'setup.warn.provider.description': 'Habilita y conecta al menos un proveedor de IA (Cursor, Claude, Codex, Gemini o Copilot) antes de ejecutar tareas.',
  'setup.warn.provider.action': 'Abrir proveedores',
  'setup.warn.connection.title': 'Conecta GitHub o GitLab',
  'setup.warn.connection.description': 'Añade al menos una conexión de forge válida y luego registra un repositorio.',
  'setup.warn.connection.unhealthyTitle': 'Las conexiones de forge necesitan atención',
  'setup.warn.connection.unhealthyDescription': 'Todas las conexiones tienen errores o están desconectadas. Repara o vuelve a conectar una.',
  'setup.warn.connection.action': 'Abrir conexiones',
  'setup.warn.repository.title': 'Habilita un repositorio',
  'setup.warn.repository.description': 'Registra y habilita al menos un repositorio para que el worker pueda tomar issues etiquetados.',
  'setup.warn.repository.noneEnabledDescription': 'Hay repositorios registrados, pero ninguno está habilitado. Habilita al menos uno.',
  'setup.warn.repository.action': 'Abrir repositorios',

  'footer.howItWorks': 'Cómo funciona',
  'footer.about': 'Acerca de',
  'footer.docs': 'Documentación',
  'footer.repository': 'Repositorio',
  'footer.license': 'Licencia',
  'footer.contact': 'Contacto',

  'howItWorks.title': 'Cómo funciona',
  'howItWorks.subtitle': 'Tutorial para GitHub, GitLab y este panel',
  'howItWorks.intro.heading': 'Resumen',
  'howItWorks.intro.p1':
    'AI Worker es un asistente de código autoalojado para GitHub y GitLab. Ejecuta Cursor CLI, Claude Code, Codex CLI, Gemini CLI o GitHub Copilot CLI en tu entorno, con indexación semántica opcional de CodeGraph. El trabajo diario se impulsa con labels en issues y pull/merge requests. Este panel es para configuración, monitorización y ajustes.',
  'howItWorks.intro.p2':
    'Empieza conectando aquí tu forge y los proveedores de IA, habilita repositorios y luego usa labels en GitHub o GitLab para encolar trabajos de implementación, preguntas y respuestas, o revisión. El agente de IA solo edita el workspace asignado; commit, push, PR/MR y comentarios en el forge los realiza la capa de orquestación de confianza de AI Worker: el agente no puede usar tus tokens del forge por su cuenta.',
  
  'howItWorks.providers.heading': 'Proveedores de IA',
  'howItWorks.providers.intro':
    'Abre Providers para habilitar y conectar al menos un agente. Define un valor por defecto; puedes sobrescribir el proveedor por repositorio. Los cinco CLI vienen en la imagen Docker. Pega secretos aquí (cifrados en reposo) o define las variables equivalentes en el .env de compose.',
  'howItWorks.providers.cursor':
    'Cursor CLI — clave API de Cursor (CURSOR_API_KEY) desde la configuración del panel de Cursor.',
  'howItWorks.providers.claude':
    'Claude Code — clave API de Anthropic (ANTHROPIC_API_KEY) desde console.anthropic.com, o un token OAuth de Claude Code (CLAUDE_CODE_OAUTH_TOKEN).',
  'howItWorks.providers.codex':
    'Codex CLI — clave API de OpenAI (OPENAI_API_KEY o CODEX_API_KEY) desde platform.openai.com/api-keys.',
  'howItWorks.providers.gemini':
    'Gemini CLI — clave API de Gemini (GEMINI_API_KEY) desde aistudio.google.com/apikey.',
  'howItWorks.providers.copilot':
    'GitHub Copilot CLI — PAT de GitHub de grano fino con Copilot Requests (COPILOT_GITHUB_TOKEN). Los tokens clásicos ghp_ no son compatibles; no reutilices GITHUB_TOKEN del forge para el agente.',
  'howItWorks.providers.codegraph':
    'CodeGraph — instalado con los agentes. Activado por defecto por repositorio: mantiene un índice local .codegraph/ y ejecuta codegraph init antes de los agentes si falta. Desactívalo en la página del repositorio para eliminar el índice. El setup del primer admin recoge un email para la lista de espera opcional de CodeGraph Pro. El índice nunca se hace commit.',

  'howItWorks.forge.heading': 'Trabajar en GitHub y GitLab',
  'howItWorks.forge.intro':
    'El trabajo diario ocurre en GitHub o GitLab — no en un terminal del host de AI Worker. Cuando un repositorio está conectado y habilitado, abre un issue o PR/MR, describe un objetivo claro, añade la(s) label(s) correcta(s) y deja el ítem abierto mientras corre el worker. Observa las labels de estado para el progreso y luego revisa el PR/MR, el comentario del issue o (si force-push está activo) los commits en la rama destino.',
  'howItWorks.forge.practice.heading': 'Cómo trabajar en el forge',
  'howItWorks.forge.practice.item1':
    'Trata cada issue o PR/MR como una sola petición: un título y un cuerpo específicos dan al agente un objetivo claro.',
  'howItWorks.forge.practice.item2':
    'Solo añades labels de disparo — ai (implementar), ai + no-change (preguntas y respuestas), o ai-review (revisión). No añadas labels de estado tú mismo; las gestiona el worker.',
  'howItWorks.forge.practice.item3':
    'Configura la rama destino del repositorio en este panel antes de los trabajos de implementación. Prefiere el flujo PR/MR por defecto; activa force-push solo si quieres commits directos en esa rama.',
  'howItWorks.forge.practice.item4':
    'Mantén el issue o PR/MR abierto hasta que termine el trabajo. Para reintentar tras un fallo, corrige la petición si hace falta y vuelve a añadir ai o ai-review. Para otra ronda de Q&A: mantén no-change, quita ai-answered y añade ai.',
  'howItWorks.forge.tokens.heading': 'Tokens y acceso',
  'howItWorks.forge.tokens.github':
    'GitHub: usa un PAT clásico con el scope repo (workflow opcional), o un token de granularidad fina con Metadata en lectura más Contents, Issues y Pull requests en lectura/escritura. Pégalo en Connections → Connect GitHub.',
  'howItWorks.forge.tokens.gitlab':
    'GitLab (gitlab.com o autogestionado): crea un personal access token con el scope api; luego en Connections → Connect GitLab indica la URL del servidor y pega el token. Solo read_api no basta para el funcionamiento completo del worker.',
  'howItWorks.forge.tokens.git':
    'El clone y el push de Git usan HTTPS con tu token por defecto. Si GitLab bloquea git por HTTP(S), habilita Both o HTTP en los protocolos de acceso Git de la administración de GitLab, o añade la clave pública SSH de la plataforma que se muestra en Connections. Los tokens del forge y las claves SSH permanecen en el proceso de orquestación de confianza del worker; no se entregan al proceso del agente de IA.',
  'howItWorks.workflows.heading': 'Flujos habituales en el forge',
  'howItWorks.workflows.implement.heading': 'Implementar un cambio',
  'howItWorks.workflows.implement.step1':
    'Confirma la rama destino del repositorio (y la opción opcional de force-push) en la página del repositorio.',
  'howItWorks.workflows.implement.step2': 'Abre un issue (o un PR/MR abierto) con título y descripción claros.',
  'howItWorks.workflows.implement.step3': 'Añade la etiqueta ai.',
  'howItWorks.workflows.implement.step4': 'Observa las etiquetas: ai → ai-working → ai-pr (o ai-failed).',
  'howItWorks.workflows.implement.step5':
    'Revisa el PR/MR que abrió el worker o — si force-push está activo — los commits en la rama destino y el comentario del issue.',
  'howItWorks.workflows.qa.heading': 'Hacer una pregunta (sin cambios de código)',
  'howItWorks.workflows.qa.step1': 'Abre un issue con tu pregunta.',
  'howItWorks.workflows.qa.step2': 'Añade ai y no-change.',
  'howItWorks.workflows.qa.step3': 'Espera un comentario en el issue. Labels finales: ai-answered + no-change.',
  'howItWorks.workflows.qa.step4': 'Para preguntar de nuevo: mantén no-change, quita ai-answered y vuelve a añadir ai.',
  'howItWorks.workflows.review.heading': 'Revisar un pull o merge request',
  'howItWorks.workflows.review.step1': 'Abre un PR en GitHub o un MR en GitLab.',
  'howItWorks.workflows.review.step2': 'Añade la label ai-review.',
  'howItWorks.workflows.review.step3': 'Observa las labels: ai-review → ai-reviewing → ai-reviewed (o ai-review-failed).',
  'howItWorks.workflows.review.step4': 'Lee el comentario de revisión en el PR/MR.',
  'howItWorks.lifecycle.heading': 'Ciclo de vida de las labels',
  'howItWorks.lifecycle.intro':
    'Las labels siguen un ciclo corto en cada flujo. Tú añades la(s) label(s) de inicio; el worker las sustituye por labels de estado mientras el trabajo corre y termina. No quites labels de estado a mitad de ejecución.',
  'howItWorks.lifecycle.implement.heading': 'Implementar (cambio de código)',
  'howItWorks.lifecycle.implement.body':
    'Inicio: añades ai en un issue abierto (o PR/MR abierto). En curso: el worker hace un checkout limpio de la rama destino y pone ai-working. Éxito: ai-pr, y un PR/MR nuevo/actualizado contra la rama destino o un force-push a esa rama más un comentario en el issue. Fallo: ai-failed. Reintenta corrigiendo la petición si hace falta y añadiendo ai de nuevo.',
  'howItWorks.lifecycle.qa.heading': 'Preguntas y respuestas (sin cambios de código)',
  'howItWorks.lifecycle.qa.body':
    'Inicio: añades ai y no-change en un issue abierto. En curso: ai-working permanece con no-change. Éxito: ai-answered + no-change, con la respuesta en un comentario del issue (sin rama ni PR/MR). Fallo: ai-failed + no-change. Para preguntar otra vez: quita ai-answered, mantén no-change y añade ai.',
  'howItWorks.lifecycle.review.heading': 'Revisión (PR/MR)',
  'howItWorks.lifecycle.review.body':
    'Inicio: añades ai-review en un PR ya abierto (GitHub) o MR (GitLab). En curso: ai-reviewing. Éxito: ai-reviewed más un comentario de revisión en el PR/MR. Fallo: ai-review-failed. Reintenta añadiendo ai-review de nuevo.',
  'howItWorks.repoOptions.heading': 'Opciones del repositorio',
  'howItWorks.repoOptions.intro':
    'En cada página de repositorio controlas desde qué rama arrancan los trabajos y cómo se publican los resultados de implementación.',
  'howItWorks.repoOptions.targetBranch':
    'Rama destino de PR/MR — base de nuevos pull/merge requests (por ejemplo main, master o develop). También es el checkout limpio de cada ejecución.',
  'howItWorks.repoOptions.freshCheckout':
    'Checkout limpio — antes de cada trabajo el worker hace fetch de origin/<rama destino>, hard-reset a esa punta y descarta cambios sin commit en el workspace.',
  'howItWorks.repoOptions.forcePush':
    'Force-push a la rama destino (omitir PR/MR) — desactivado por defecto. Si se activa, la implementación hace force-push a la rama destino en lugar de abrir un PR/MR y deja un comentario en el issue. Sobrescribe la rama remota; úsalo con cuidado.',
  'howItWorks.repoOptions.codegraph':
    'CodeGraph — activado por defecto. Si está activo, el worker mantiene un índice local .codegraph/ y ejecuta codegraph init antes de los agents si falta. Si se desactiva, se elimina .codegraph/ y no se recrea hasta reactivarlo. El índice nunca se hace commit.',
  'howItWorks.labels.heading': 'Referencia de labels',
  'howItWorks.labels.intro':
    'Normalmente solo añades ai, ai + no-change, o ai-review. El worker gestiona las labels de estado según el ciclo anterior (ai-working, ai-pr, ai-answered, ai-failed, ai-reviewing, ai-reviewed, ai-review-failed).',
  'howItWorks.labels.youAdd': 'Tú añades',
  'howItWorks.labels.workerAdds': 'El worker añade',
  'howItWorks.labels.ai': 'Encola implementación, o preguntas y respuestas si se combina con no-change',
  'howItWorks.labels.noChange': 'Con ai: solo responde — sin rama ni PR/MR',
  'howItWorks.labels.aiWorking': 'Implementación o preguntas y respuestas en curso',
  'howItWorks.labels.aiPr':
    'Implementación terminada; PR/MR creado o actualizado (o force-push a la rama destino si esa opción está activa)',
  'howItWorks.labels.aiAnswered': 'Preguntas y respuestas terminadas; respuesta publicada como comentario',
  'howItWorks.labels.aiFailed': 'Falló la implementación o las preguntas y respuestas — revisa tasks o los logs',
  'howItWorks.labels.aiReview': 'Encola una revisión con IA en un PR/MR abierto',
  'howItWorks.labels.aiReviewing': 'Revisión en curso',
  'howItWorks.labels.aiReviewed': 'Comentario de revisión publicado',
  'howItWorks.labels.aiReviewFailed': 'Falló la revisión — revisa tasks o los logs',
  'howItWorks.tips.heading': 'Consejos para el forge',
  'howItWorks.tips.item1': 'Mantén el issue o PR/MR abierto mientras corre el worker.',
  'howItWorks.tips.item2':
    'Escribe un título y un cuerpo claros; los comentarios más recientes prevalecen sobre los antiguos si hay conflicto.',
  'howItWorks.tips.item3':
    'Para reintentar tras un fallo, corrige el issue si hace falta y vuelve a añadir ai o ai-review.',
  'howItWorks.tips.item4':
    'Las labels se crean automáticamente al registrar un repo; también puedes ejecutar Setup labels en la página del repositorio.',
  'howItWorks.tips.item5':
    'Configura la rama destino en la página del repositorio antes de los trabajos de implementación. Deja force-push desactivado salvo que quieras empujar directamente a esa rama.',
  'howItWorks.panel.heading': 'Trabajar en este panel',
  'howItWorks.panel.intro':
    'Usa el panel para conectar forges y proveedores de IA, habilitar repositorios, ajustar prompts y settings, y supervisar tasks. El trabajo diario de programación sigue haciéndose con labels en GitHub o GitLab.',
  'howItWorks.panel.setup.heading': 'Orden de configuración recomendado',
  'howItWorks.panel.setup.item1': 'Providers — conecta Cursor, Claude, Codex, Gemini y/o Copilot, habilita al menos uno y define uno por defecto.',
  'howItWorks.panel.setup.item2': 'Connections — conecta GitHub y/o GitLab con un token que tenga los scopes anteriores.',
  'howItWorks.panel.setup.item3':
    'Repositories — espera al descubrimiento o haz clic en Fetch, y luego habilita los repos que quieras automatizar.',
  'howItWorks.panel.setup.item4':
    'Opcional — Setup labels y Setup webhooks para despertar antes cuando APP_BASE_URL sea accesible.',
  'howItWorks.panel.pages.heading': 'Para qué sirve cada página',
  'howItWorks.panel.pages.dashboard': 'Dashboard — uso de IA, métricas del worker y ejecuciones recientes.',
  'howItWorks.panel.pages.connections': 'Connections — tokens del forge, descubrimiento, webhooks y la clave pública SSH opcional.',
  'howItWorks.panel.pages.repositories':
    'Repositories — registrar, habilitar/deshabilitar, estado de clone, rama destino, force-push opcional, interruptor CodeGraph, proveedor y prompts por repo.',
  'howItWorks.panel.pages.tasks':
    'Tasks — cola en vivo del forge e historial de ejecuciones de implementación, revisión y trabajos relacionados.',
  'howItWorks.panel.pages.providers':
    'Providers — credenciales de Cursor / Claude / Codex / Gemini / Copilot, habilitación, comprobaciones de estado y valor por defecto.',
  'howItWorks.panel.pages.prompts': 'Prompts — plantillas globales y fragmentos que usa el worker.',
  'howItWorks.panel.pages.settings':
    'Settings — intervalo de sondeo, concurrencia, valores por defecto, retención y preferencias de la UI.',
  'howItWorks.panel.pages.system': 'System — salud operativa y estado de la plataforma.',
  'howItWorks.panel.pages.audit': 'Audit — acciones relevantes para la seguridad registradas por la aplicación.',


  'about.title': 'Acerca de AI Worker',
  'about.subtitle': 'Descripción del producto, servicios, contacto y licencia',
  'about.product.heading': 'Acerca de AI Worker',
  'about.product.p1':
    'AI Worker es un asistente de código con IA autoalojado para GitHub y GitLab. Etiqueta un issue o pull/merge request y ejecuta Cursor CLI, Claude Code, Codex CLI, Gemini CLI o GitHub Copilot CLI en tu entorno (con indexación CodeGraph opcional) para implementar trabajo o revisar cambios.',
  'about.product.p2':
    'Está pensado para equipos que quieren automatización en su propia infraestructura—incluidas organizaciones con GitLab Self-Managed—sin enviar repositorios a un servicio de agente alojado de terceros.',
  'about.services.heading': 'Servicios',
  'about.services.intro':
    'Hay servicios profesionales de pago bajo petición para empresas y equipos de desarrollo. Cada encargo se delimita por solicitud; aquí no se publica una lista de precios pública.',
  'about.services.item1': 'Instalación y despliegue de AI Worker',
  'about.services.item2': 'Hardening de seguridad y configuración',
  'about.services.item3': 'Integración con GitHub y GitLab Self-Managed',
  'about.services.item4': 'Flujos de IA, prompts e integraciones personalizados',
  'about.services.item5': 'Mantenimiento continuo y soporte técnico',
  'about.contact.heading': 'Contacto y colaboración',
  'about.collaboration': 'Colaboración',
  'about.license.heading': 'Licencia',
  'about.license.view': 'Ver LICENSE en el repositorio',
  'about.license.pending': 'Información de licencia pendiente',

  'dashboard.title': 'Panel',
  'dashboard.subtitle': 'Uso de servicios de IA, estado del plan y métricas del worker en vivo',
  'dashboard.timeWindow': 'Ventana de tiempo',
  'dashboard.refresh': 'Actualizar',
  'dashboard.loadError': 'No se pudo cargar el panel',
  'dashboard.repositories': 'Repositorios',
  'dashboard.enabledCount': '{count} habilitados',
  'dashboard.worker': 'Worker',
  'dashboard.activeCount': '{count} activos',
  'dashboard.defaultProvider': 'predeterminado {provider}',
  'dashboard.forgeQueue': 'Cola de forge',
  'dashboard.workingWaiting': 'trabajando / en espera · {total} etiquetados',
  'dashboard.successWindow': 'Éxito · {hours}h',
  'dashboard.okFailAvg': '{ok} ok / {fail} fallos · prom. {avg}',
  'dashboard.aiServices': 'Servicios de IA',
  'dashboard.aiServicesHint': 'Plan / cuenta y uso registrado para la ventana seleccionada',
  'dashboard.manageProviders': 'Gestionar proveedores',
  'dashboard.defaultBadge': 'predeterminado',
  'dashboard.enabled': 'habilitado',
  'dashboard.disabled': 'deshabilitado',
  'dashboard.planAccount': 'Plan / cuenta',
  'dashboard.planUnknown': 'Plan desconocido',
  'dashboard.notConnected': 'No conectado',
  'dashboard.planUnavailable': 'Plan no disponible',
  'dashboard.credentialsConnected': 'Credenciales conectadas',
  'dashboard.noCredentials': 'Sin credenciales',
  'dashboard.model': 'Modelo {model}',
  'dashboard.cli': 'CLI {version}',
  'dashboard.usageWindow': 'Uso · {hours}h',
  'dashboard.runsCount': '{count} ejecuciones',
  'dashboard.usageSummary': '{ok} ok · {fail} fallos · {rate} de éxito',
  'dashboard.durationSummary': 'prom. {avg} · total {total}',
  'dashboard.runningCount': '{count} en curso',
  'dashboard.byTaskType': 'Por tipo de tarea',
  'dashboard.noRuns': 'No hay ejecuciones registradas para este proveedor en la ventana.',
  'dashboard.noRunsUnassigned':
    'Las ejecuciones antiguas pueden carecer de etiqueta de proveedor hasta actualizar el worker.',
  'dashboard.finishedTasks': 'Tareas finalizadas',
  'dashboard.finishedTasksHint': 'Ejecuciones completadas en la ventana seleccionada · estado y uso de tokens',
  'dashboard.allTasks': 'Todas las tareas',
  'dashboard.noFinishedTasks': 'No hay tareas finalizadas en las últimas {hours}h.',
  'dashboard.col.task': 'Tarea',
  'dashboard.col.repo': 'Repo',
  'dashboard.col.type': 'Tipo',
  'dashboard.col.status': 'Estado',
  'dashboard.col.provider': 'Proveedor',
  'dashboard.col.duration': 'Duración',
  'dashboard.col.tokens': 'Tokens',
  'dashboard.col.finished': 'Finalizado',
  'dashboard.tokensDetail': 'caché lectura {read} · caché escritura {write}',
  'dashboard.tokensNotRecorded': 'Uso de tokens no registrado para esta ejecución',
  'dashboard.usageDetail': '{total} (ent {input} / sal {output})',
  'dashboard.recentExecutions': 'Ejecuciones recientes',
  'dashboard.noExecutions': 'Aún no hay ejecuciones registradas.',
  'dashboard.providerNa': 'proveedor n/d',
  'dashboard.operationalEvents': 'Eventos operativos',
  'dashboard.noEvents': 'Aún no hay eventos del worker.',
  'dashboard.latestFailures': 'Últimos fallos',
  'dashboard.noFailures': 'No hay fallos recientes en el conjunto cargado.',
  'dashboard.noSummary': 'Sin resumen',
}

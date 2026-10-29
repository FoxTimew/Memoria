# Session 7 — 7a : transferts RustFS, GC et arrêt de performance

29 octobre 2026. **Livraison intermédiaire, 7a non clôturée, 7b non commencée.** Le développeur a choisi RustFS officiel épinglé, parité locale/production et maintien des témoins de conformité. Le premier dépassement bloquant ci-dessous arrête la campagne ; aucune optimisation de verrou n'est incluse dans cette livraison.

**Suite autorisée le même jour :** [profilage, correction des deux verrous et courses GC réelles](session-7-7a-contention.md). Le contenu passe trois séries après correction ; un nouvel arrêt historique à deux auteurs sans changement de fichier maintient 7a ouverte. Les chiffres ci-dessous restent ceux de la livraison `c3a8dee`.

## À lire en priorité

1. [Diagnostic et mesures](#arrêt-et-diagnostic) : ce qui empêche la clôture.
2. [Service de transfert](../../packages/storage/src/uploads.ts) et [migration 0032](../../packages/db/drizzle/0032_file_transport.sql) : états, copies immuables, vérification en flux, nettoyage et quota conservateur.
3. [Contrôleurs et quotas](../../apps/api/src/modules/files/files.controller.ts), [attaques HTTP](../../apps/api/src/files.e2e.ts), [frontières déjà livrées](session-7-7a-frontieres.md).
4. [ADR 021](../adr/021-transferts-et-service-des-fichiers.md), [ADR 022](../adr/022-droits-et-cycle-de-vie-des-fichiers.md), [exploitation RustFS](../self-hosting.md#stockage-local-rustfs--décision-du-29-octobre-2026).

## Ce qui change

RustFS 1.0.4 officiel par digest devient le Compose par défaut. MinIO est conservé sous profil `conformance`, avec son ancien volume intact ; SeaweedFS corrigé reste une fixture et n'ira jamais en production. Un test bloque l'adoption d'un digest RustFS sans preuve des 23 scénarios inchangés. Le passage aux reçus PostgreSQL est inscrit avant SaaS ou changement de fournisseur ; le plan actuel de parties n'est pas un reçu. Aucun dépôt amont publié.

Six routes de session contrôlent intention, état, reprise, signature, finalisation et annulation. Les octets passent directement à RustFS par POST ou multipart. Un job finalise, copie sous une clé nouvelle, relit en flux et contrôle taille, SHA-256 entier et empreintes de parties. Il laisse **`validating`** : type réel, décodeur, passage `ready` et service de lecture sont en 7b. Pas d'interface d'upload avant 7c.

Le GC garde les références retenues, la rétention du dernier usage, les capacités déjà émises et le délai du proxy. Il vérifie l'absence S3 avant de libérer le quota, sans double débit ; il nettoie aussi le staging en conservant la copie finale. Les états/retries survivent au processus via PostgreSQL ; cela ne constitue pas encore une qualification de crash du fournisseur.

## Arrêt et diagnostic

Une seule série sur le profil contenu proche de 1 Mio, 10 vagues de chauffe puis 100 vagues mesurées, une pause de 100 ms entre vagues. Deux vrais comptes, Hocuspocus et Caddy/WSS ; projection automatique active. Les deux premiers paragraphes sont remplacés par des emplacements image pour rester à 500 blocs ; tailles exactes et échantillons dans le [rapport brut](evidence/session-7-7a-transferts/measurement.json). Aucune médiane de trois séries n'est revendiquée.

| Scénario                                   | Validation jusqu'au commit SQL, p95 | Transaction seule, p95 | Reçu WSS, p95 |
| ------------------------------------------ | ----------------------------------: | ---------------------: | ------------: |
| Sans changement de référence, un auteur    |                            13,44 ms |               10,79 ms |      20,11 ms |
| Sans changement de référence, deux auteurs |                            13,50 ms |               10,68 ms |      32,68 ms |
| Ajout/retrait de référence, un auteur      |                       **561,71 ms** |          **548,44 ms** | **567,88 ms** |

Plafond serveur contenu : **<50 ms**. Le chronométrage des verrous atteint 533,81 ms au p95, celui de remplacement du registre 7,66 ms. Ces percentiles ne s'additionnent pas ; le temps des verrous inclut les requêtes, pas seulement l'attente PostgreSQL. Arrêt avant le cas références/deux auteurs, les deux séries suivantes, le profil historique, le froid et la comparaison alternée main. Aucune dérogation, aucun seuil relevé.

Hygiène conforme : secteur `BatteryStatus=2`, Windows **5,02 Gio avant préparation**, **4,58 Gio** au début de série ; WSL **5,29 Gio** disponibles. 63 intervalles `vmstat` avec si/so nuls, compteurs swap inchangés. [Trace complète](evidence/session-7-7a-transferts/hygiene.json), [préparation](evidence/session-7-7a-transferts/preparation.json), [journal](evidence/session-7-7a-transferts/measurement.txt).

Le [test PostgreSQL de diagnostic](../../apps/collab/src/testing/file-locks.e2e.ts) reproduit la cause : l'insertion dans `file_references` par la projection prend un verrou FK `KEY SHARE` sur `files`. Le `FOR UPDATE` du registre synchrone attend cette transaction ; `pg_blocking_pids` désigne exactement le backend de projection, `wait_event=transactionid`. Après rollback de la projection, le rédacteur réussit sans contourner son verrou. Sur la grosse projection, ce conflit explique le lieu de l'attente ; aucun profil complet des requêtes de projection n'est encore réalisé.

**Suite recommandée, à arbitrer :** profiler la durée de rétention de ce verrou par la projection, puis dissocier le verrou d'exclusion métier attach/GC d'un verrou qui bloque les simples références FK, en conservant la sérialisation des états et le recontrôle au commit. Prouver les courses attache/GC/révocation et le rollback avant de relancer toutes les séries et la comparaison main. Autre voie : raccourcir la transaction de projection, plus large et plus risquée pour l'atomicité recherche/audit/outbox. Aucun gain chiffré inventé et aucun changement applicatif de ces chemins dans ce commit.

### Tentatives non retenues

Le banc initial sans cadence atteint `MESSAGE_RATE_LIMIT` : quota inchangé, banc cadencé. Les sondes système synchrones exécutées dans le processus du serveur provoquaient ensuite une perte de leadership entre scénarios : elles sont déplacées dans le parent, tandis que le serveur reste dans un enfant. Les journaux de ces essais restent locaux ; ils ne constituent pas des mesures applicatives qualifiées. Un refus mémoire à 2,96 Gio Windows précède la libération confirmée par le développeur. La seule série qualifiée est celle publiée ci-dessus.

## Matrice routes, quotas et preuves

Préfixe `/api/internal/workspaces/:workspaceId/file-uploads`. Guard global sur toutes les routes ; origine/CSRF sur mutations. Quotas partagés entre sessions/workspaces, IP normalisée issue du proxy de confiance, réponse 429 avec Retry-After. Corps ≤64 Kio. Refus constants, aucune cause brute S3/SQL exposée.

| Route                    | Classe / compte / IP par minute | Preuve HTTP réelle                                                                                     |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| POST racine              | U / 30 / 1 500                  | 401, CSRF, corps trop grand, guest read, tenant, idempotence/checksum, récupération et MFA             |
| GET `/:id` (HEAD inclus) | L / 120 / 6 000                 | 401, intention d'autrui, tenant, récupération et MFA ; faux headers et saturation réelle des compteurs |
| POST `/:id/resume`       | U / 30 / 1 500                  | 401, intention d'autrui, parties listées côté RustFS, récupération et MFA                              |
| POST `/:id/parts`        | P / 120 / 6 000                 | 401, intention d'autrui, révocation, signatures inutilisables après finalisation, récupération et MFA  |
| POST `/:id/complete`     | U / 30 / 1 500                  | 401, intention d'autrui, faux ETag, double appel, SHA faux, récupération et MFA                        |
| DELETE `/:id`            | U / 30 / 1 500                  | 401, intention d'autrui, état, répétition sans double libération, récupération et MFA                  |

Les quotas de débit et de concurrence atomiques sont aussi vérifiés par `files.e2e.ts` du service collaboratif. R12 reste une obligation : les six nouvelles routes ont des tentatives exécutables ; cette matrice ne déclare pas les futures routes de lecture, cellule fichiers et catalogue sécurisées par héritage.

## Risques et preuves restantes

Contrôles exécutés : [RustFS 23/23](evidence/session-7-7a-transferts/rustfs.txt), [HTTP/GC 10 tests](evidence/session-7-7a-transferts/routes.txt), [frontières SQL/cellules/WSS 15 + 7 + 3 tests](evidence/session-7-7a-transferts/boundaries.txt), [diagnostic de verrou 1 test](evidence/session-7-7a-transferts/lock-diagnostic.txt). `pnpm check` passe : **169 tests, 6 ignorés**, 32 fichiers de tests réussis ; les intégrations PostgreSQL citées sont lancées séparément. [Journal complet](evidence/session-7-7a-transferts/check.txt). Les comptes de tests incluent les tests parents du runner Node ; ils ne sont pas autant de scénarios indépendants.

- **Bloquant 7a :** contention de projection ; trois séries complètes, froid, historique et comparaison main restent à faire.
- **À compléter pour clôturer 7a :** courses du collecteur réel avec attache, perte de réponse S3/SQL et ancien job tardif, reprise après crash, contrôle de capacité globale de staging et rapprochement des compteurs. Le budget actuel de copies temporaires ne mesure pas l'espace libre physique du disque.
- **Pas encore prouvé par navigateur :** POST/multipart sur l'origine locale avec cookies et CORS réels ; la conformité HTTP et l'adaptateur utilisent des clients réseau. Le proxy local est configuré, mais cela ne remplace pas la preuve navigateur finale.
- **7b :** type réel, images 8K, lecture révocable et quotas dédiés ; aucun original n'est servi par ces nouvelles routes.
- **7d/pré-pilote :** 1/5/10 transferts de 1/5 Gio, mémoire/débit, protection globale contre les replays, crash/restauration, antivirus facultatif à arbitrer. Le choix du volume de sauvegarde A/B reste au développeur.
- **Données anciennes :** pas de migration automatique de MinIO vers RustFS ni de reconstruction de droits depuis la projection. Un ancien document avec des fichiers sans registre refuse `FILE_LEDGER_REBUILD_REQUIRED` ; procédure contrôlée nécessaire avant données réelles. Aucun contenu existant supprimé par cette livraison.

## Guide manuel de cette livraison intermédiaire

1. Lire d'abord le diagnostic : ne pas démarrer 7b ni qualifier cette version pour un studio.
2. Suivre l'[initialisation locale RustFS](../self-hosting.md#stockage-local-rustfs--décision-du-29-octobre-2026). Vérifier `docker compose ps` : RustFS et Caddy actifs, MinIO hors démarrage par défaut. L'ancien volume reste présent.
3. Lancer `pnpm test:storage:rustfs` : attendre le résumé **23/23**, pas seulement les premières lignes. Le conteneur de conformité est jetable et distinct du volume local.
4. Lancer `pnpm test:files:e2e` : deux comptes plus un guest, vrai Nest/PostgreSQL/RustFS ; reprise d'un multipart 33 Mio, faux checksum, accès retiré, copie finale préservée malgré rejeu, nettoyage et quotas. Lire le résumé final ; aucune interface de transfert n'est revendiquée.
5. Lancer `pnpm test:files:boundaries` pour les contributions Yjs et les cellules, puis `node scripts/test-collab.mjs --suite file-locks` pour constater le blocage de projection reproductible.
6. **Ne pas relancer la campagne de performance avant arbitrage.** Après correction autorisée, `pnpm measure:files` appliquera les garde-fous ; les autres campagnes complètent ensuite froid et comparaison alternée.

Finition fonctionnelle et mesures sont volontairement distinguées : le guide à deux navigateurs avec sélection de vrais assets sera livré en 7c, après le service de lecture 7b.

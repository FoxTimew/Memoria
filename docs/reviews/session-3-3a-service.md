# Session 3a — service collaboratif, relecture du 23 octobre 2026

Le backend collaboratif réel remplace le prototype. Une écriture est validée puis journalisée avant diffusion ; les blocs, la recherche, les fichiers, l'audit et l'outbox sont des projections asynchrones. Les douze scénarios de la preuve utilisent désormais ce service. `proof/` et ses lanceurs ont été supprimés.

Cette livraison concerne **3a seulement**. Le front de session 2 reste présent mais son ancienne sauvegarde de contenu reçoit `409 COLLABORATION_REQUIRED`. L'éditeur collaboratif, WSS Caddy et le reset documenté viennent en 3b ; présence, cache et effacement viennent en 3c. Aucun reset de données applicatives n'a été fait. Aucun utilisateur réel avant la fin de la session 4.

## Fichiers à lire en priorité

1. [ADR 017](../adr/017-collaboration-temps-reel.md), sections « Livraison 3a » et « Protocole livré », puis [dimensionnement](../self-hosting.md).
2. [server.ts](../../apps/collab/src/service/server.ts), [room.ts](../../apps/collab/src/service/room.ts) et [store.ts](../../apps/collab/src/service/store.ts) : ordre validation, transaction, application, diffusion et reçu.
3. [projection.ts](../../apps/collab/src/service/projection.ts) et [memory.ts](../../apps/collab/src/service/memory.ts) : reprise durable, compaction et éviction.
4. [transport.e2e.ts](../../apps/collab/src/testing/transport.e2e.ts) et [pages.e2e.ts](../../apps/api/src/pages.e2e.ts) : parcours exécutés sur PostgreSQL, Better Auth et WebSocket/HTTP réels.
5. [migrations](../../packages/db/drizzle/), surtout `0003` à `0006` : documents/journal/reçus, triggers de révocation, réservation des UUID, cascade de suppression.

## Sujets, commits et portée des preuves

Les hashes ci-dessous identifient les commits de code. Le compte rendu de livraison donne le hash final poussé et vérifié sur `origin` ; les journaux complets sont versionnés avec cette fiche.

| Sujet / commits                                  | Prouvé par un test réel                                                                                                                                                                                                                                                                                                                                                        | Ce qui n'est pas prouvé                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations — `848a3f2`, `9529e87`, `86d1223`     | Application de toutes les migrations dans des schémas temporaires ; limites binaires, FK de workspace/génération, révisions, UUID interpages ; reçus conservés après anonymisation du compte et supprimés avec le workspace.                                                                                                                                                   | Migration/reset de la base applicative existante ; sauvegarde/restauration d'exploitation.                                                                                                         |
| Leadership — `cada7d8`                           | Deux leaders concurrents : un seul admis ; destruction du backend PostgreSQL, fermeture des sockets, refus de l'ancien fence et reprise par un nouvel owner.                                                                                                                                                                                                                   | Toutes les partitions réseau, crash matériel, déploiement HA. Une instance applicative reste la topologie supportée.                                                                               |
| Admission/quotas — `dd21536`                     | Véritable ingress WebSocket : frames comptées avant livraison à Hocuspocus ; dépassement de file refusé avant le consommateur, origine étrangère refusée, compteurs libérés. Bornes utilisateur/instance couvertes aussi par tests unitaires.                                                                                                                                  | Ouverture réelle de 500 sockets, charge de 50 personnes, attaque distribuée ou comportement du futur proxy WSS.                                                                                    |
| Révocation — `3d2ec5a`                           | Suppression de membre attend le verrou du rédacteur ; triggers/NOTIFY relisent les droits ; membre, session et ancêtre archivé ferment les sockets concernées. NOTIFY volontairement supprimé : contrôle de secours ≤ 5,5 s dans le test (tolérance de planification de 0,5 s).                                                                                                | Tous les entrelacements de révocations et pannes système. La cible opérationnelle reste 5 s. Invités réels non livrés ; le niveau lecture utilise une fixture.                                     |
| HMAC et BlockWriteService — `ca8fe66`, `59cf5af` | HTTP interne signé : corps/chemin/date/rejeu vérifiés. Nest injecte la session ; le writer applique des commandes dans la salle et attend sa projection. Retry avec même reçu après compaction ; conflit de révision ; fichiers étrangers et candidats invalides refusés.                                                                                                      | API publique/importeurs futurs ; rotation multi-secret ; service déployé sur plusieurs hôtes.                                                                                                      |
| Projection et compaction — `f041f05`, `59cf5af`  | Erreur SQL injectée dans l'outbox : rollback des effets, contenu toujours durable, frappe maintenue, retry automatique ; blocs/recherche/références exacts, audit par auteur et un événement de révision. Snapshot et purge atomiques du journal ; reçus conservés ; rollback d'update et replay sans révision/événement supplémentaire.                                       | Endurance de plusieurs jours, longue panne avec gros journal résiduel, rétention des reçus/outbox, livraison des webhooks. Le délai de regroupement n'est pas une garantie de fin sous saturation. |
| Mémoire — `7948612`                              | Répliques et workers réels : budget plein avec salles actives refusé, inactive évincée en premier, délai d'inactivité, libération d'ouverture annulée, projection planifiée autorisant l'éviction. 30 chargements froids par profil 1 Mio ; avertissement historique et métriques persistés. Échec de bind : ressources libérées ; sonde 200 puis 503 sur perte de leadership. | Plafond RSS global, mémoire réelle de 50 workers en charge, longue queue de journal au chargement, deux navigateurs, rebasage.                                                                     |

Le test de transport conserve douze scénarios : authentification/document imbriqué, barrière SQL avant diffusion et reçu de chaque contribution regroupée, convergence texte/champs de fiche, reconnexion, panne de projection, commande signée et compaction, refus cookie/origine/génération, lecture seule (update et SyncStep2), client invalide avec deux rédacteurs sains, déconnexion de tous les onglets, révocation ciblée de membre, archivage d'ancêtre et perte du leader. Les tests de codec comparent validation complète et incrémentale et interdisent les dépendances UI côté serveur.

## Mesures finales et limites

Ryzen 7 5800H, Windows, Node 24.21.0, PostgreSQL 17.11 local en conteneur ; `fsync` et `synchronous_commit` activés. Tous les échantillons après chauffe sont conservés. Les résultats sont locaux, pas une garantie sur un autre matériel.

| Profil                                                    | Taille Yjs / JSON métier     | p95 froid / maximum      | p95 update / maximum   |
| --------------------------------------------------------- | ---------------------------- | ------------------------ | ---------------------- |
| Contenu : 500 blocs, profondeur 3, 55 fiches              | 1 045 110 / 1 040 382 octets | **162,045 / 162,300 ms** | **22,099 / 32,664 ms** |
| Historique : contenu modeste, 41 129 identifiants clients | 1 042 470 / 100 802 octets   | **492,360 / 575,816 ms** | **44,723 / 63,580 ms** |

Froid : deux chauffes puis 30 ouvertures avec admission mémoire, lecture cohérente SQL, nouveau document Hocuspocus et nouveau worker. Authentification/réseau et longue queue de journal exclus. La cible p95 < 500 ms passe, mais l'historique ne garde que **7,64 ms de marge** et son maximum dépasse 500 ms. Updates : vingt chauffes puis 200 mesures, validation incrémentale + transaction réelle (fence et réservation des UUID) + acquittement du worker ; réseau, file et projection exclus. Les deux p95 restent sous 50 ms.

Les premiers essais de production ont échoué à **68,778 puis 69,870 ms** sur l'historique. La lecture du snapshot complet à chaque transaction a été supprimée ; seules les révisions sont lues sur ce chemin. Les réservations d'UUID déjà détenues ne sont plus réécrites. Les journaux de ces échecs sont conservés, séparément de la série finale.

Le budget par défaut de **1 Gio** réserve 192 Mio par salle, donc **5 salles résidentes**, chacune pouvant accueillir plusieurs personnes. Cette réservation prudente comprend le validateur V8, une estimation du document vivant et des buffers ; ce n'est pas un plafond RSS. Inactivité par défaut : cinq minutes, configurable. La mémoire du projecteur et des files reste hors de ce budget. Le guide d'hébergement propose 4 vCPU/8 Gio/SSD 100 Gio au minimum pour quelques pages partagées ; 8 vCPU/32 Gio/SSD 250 Gio avec budget de 10 Gio pour permettre 50 pages distinctes. Ces configurations globales sont **extrapolées**, sans validation à 50 rédacteurs.

Taille encodée, taille JSON, révision mesurée et ratio sont persistés à la projection ; ils peuvent donc être en retard sur la frappe. Le seuil ≥ 768 Kio **et** ratio ≥ 4 produit un avertissement. Aucun rebasage n'est activé. L'architecture exige son automatisation sur page inoccupée avant l'utilisation prolongée en production.

## Contrôles et journaux complets

Tous les journaux de réussite ci-dessous se terminent avec `EXIT_CODE=0`. Les erreurs injectées et refus de contenu dans le transport sont attendus et suivis du bilan final réussi.

| Commande               | Résultat et journal                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`           | 12 packages typés, preuve Nest réussie, **89 tests Vitest passés / 6 SQL ignorés** dans cette commande : [journal](session-3-3a-check.log).                                                                                                                                                                                               |
| `pnpm test:db`         | Les **6 tests SQL** ignorés ci-dessus passent contre PostgreSQL : [journal](session-3-3a-db.log).                                                                                                                                                                                                                                         |
| `pnpm test:collab:e2e` | Dix fichiers exécutés, dont les douze scénarios de transport ; tous réussis : [journal](session-3-3a-collab-e2e.log). Le onzième fichier, ajouté après cette série pour l'échec de démarrage, est passé séparément avec `--suite lifecycle` : [journal](session-3-3a-lifecycle-e2e.log). Le lanceur découvre désormais les onze fichiers. |
| `pnpm test:pages:e2e`  | 7 scénarios HTTP + parent, **8 tests Node réussis** : [journal](session-3-3a-pages-e2e.log).                                                                                                                                                                                                                                              |
| `pnpm test:auth:e2e`   | 5 scénarios + parent, **6 tests Node réussis** : [journal](session-3-3a-auth-e2e.log).                                                                                                                                                                                                                                                    |
| `pnpm build`           | Build complet API/web/worker/collab et contrôle des imports UI : [journal](session-3-3a-build.log).                                                                                                                                                                                                                                       |

Mesures brutes : [froid](session-3-3a-cold.json), [updates](session-3-3a-warm.json). Essais échoués : [initial](session-3-3a-warm-initial-failed.log), [intermédiaire](session-3-3a-warm-intermediate-failed.log). La suite navigateur HTTPS de session 1 n'a pas été rejouée en 3a ; le processus collab est construit et testé via sa fabrique réelle, sans déploiement complet derrière Caddy.

## Ce qui pourrait casser

- Toute mise à jour Yjs/Hocuspocus/BlockNote doit repasser les tests : le codec dépend de leur structure et de certains détails internes Yjs.
- Le profil historique a peu de marge à froid. Sous pression CPU/mémoire, la cible peut être dépassée ; mesurer sur l'hôte prévu avant mise en service.
- Une panne prolongée du projecteur grossit le journal ; le chargement actuel lit son tail en mémoire. Ce cas n'est pas couvert par le p95 froid et nécessite surveillance du disque, du retard et de la RSS.
- Le budget mémoire est volontairement conservateur : le sixième document actif est refusé avec la valeur par défaut. Augmenter la configuration selon le matériel, sans promettre davantage de débit CPU.
- L'ancien front ne sauvegarde plus le corps avant 3b. Les anciennes pages avec blocs, sans état Yjs, exigent le reset prévu en 3b.
- Les garanties de durabilité reposent sur PostgreSQL ; les tests injectent des erreurs/interruptions contrôlées, pas une coupure électrique ni une restauration de sauvegarde.

## Comment tester manuellement

Avec Node 24, pnpm 11, `.env` local initialisé et PostgreSQL/Mailpit de Compose démarrés : `pnpm env:init` crée une nouvelle configuration et refuse d'écraser un fichier existant. Pour une configuration existante, ajouter `COLLAB_INTERNAL_SECRET` avec un secret aléatoire d'au moins 32 caractères, identique pour Nest et collab, sans régénérer les autres secrets.

```powershell
pnpm check
pnpm test:db
pnpm test:collab:e2e
pnpm test:pages:e2e
pnpm test:auth:e2e
pnpm build
```

Les suites collaboratives/pages appliquent les migrations dans des schémas temporaires puis les suppriment. Elles n'exigent pas de migrer ou réinitialiser les pages applicatives. Le test auth utilise seulement ses compteurs isolés dans la base locale. Ne pas exécuter les mesures en parallèle d'un build ou d'une autre charge.

Pour une relecture ciblée : `pnpm test:collab:e2e --suite transport` montre les douze parcours ; `--suite memory` montre les refus et évictions ; `--suite cold` et `--suite warm` reproduisent les seuils. Leurs sorties sont complètes, et les mesures JSON sont réécrites dans `.local/`. Pour vérifier l'expérience collaborative dans deux navigateurs, attendre la livraison 3b.

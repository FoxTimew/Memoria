# Session 6a — diagnostic des barrières, arrêt avant interface

26 octobre 2026. **6a commencée, non livrée et non qualifiée.** La première preuve aux bornes échoue sur l'attente SQL des rédacteurs. Arrêt conformément à la demande : aucun service de cellules, aucune nouvelle route HTTP/WSS de bases, aucune interface. Les tables de versions ne constituent pas une livraison du CAS. Ne pas merger/déployer cette candidate de preuve sur les données de travail.

## Lire en priorité

1. [Résultats bruts](evidence/session-6a-barriers-measurement.json) et [journal complet](evidence/session-6a-barriers-measurement.txt) : trois séries, mémoire/secteur, échantillons et assertion finale d'arrêt.
2. [Migration 0021](../../packages/db/drizzle/0021_database_barriers.sql) : distinction page/ligne, barrières base et cycle de vie, résolveur à portée explicite, exclusion du produit membres × lignes ; [0022](../../packages/db/drizzle/0022_database_people_workspace.sql) complète la FK de nettoyage des références de personnes.
3. [Preuve fonctionnelle](../../apps/collab/src/testing/databases-barriers.e2e.ts), [fixture et mesures](../../apps/collab/src/testing/databases-load.ts), [rédacteurs](../../apps/collab/src/testing/database-writers.ts). Ils utilisent les migrations, le résolveur, `Room`, le validateur incrémental, le leadership et `Store` réels. Pas de second moteur d'autorisations.
4. [Réglages de déploiement](../database-deployment.md), [contrôle des hooks](../../scripts/check-git-hooks.mjs), ADR [008](../adr/008-proprietes-typees.md) et [020](../adr/020-droits-et-concurrence-des-bases.md), désormais acceptés.

## Première barrière de performance

Fixture isolée : **1 000 pages ordinaires, profondeur 50, 50 bases × 1 000 lignes, 100 memberships dont 50 guests, 5 000 partages**. Aucune ligne n'est matérialisée dans `page_access_state`. Variante de stress explicitement prévue au cadrage ; ce n'est pas une mesure de cinquante personnes actives.

Trois séries avec BatteryStatus=2 ; RAM libre avant série : **3,56 / 3,48 / 3,45 Gio**. Pour chaque série, 32 changements de rôle consécutifs (deux premiers exclus des statistiques de mutation), sur un compte distinct des rédacteurs. Quatre rédacteurs utilisent trois lignes de bases distinctes et une page ordinaire ; chacun produit jusqu'à cinq updates Yjs par seconde, sans chevauchement de ses propres requêtes. Documents minimaux, un ajout de caractère par update. Les changements de rôle sont en rafale : ce banc exerce la contention, pas une fréquence humaine moyenne d'administration.

| p95 en ms                                                     | Série 1 | Série 2 | Série 3 |   Médiane des p95 | Plafond |
| ------------------------------------------------------------- | ------: | ------: | ------: | ----------------: | ------: |
| Mutation SQL jusqu'au commit, réconciliation différée incluse |   191,5 |   188,2 |   186,3 |         **188,2** |    <500 |
| Attente de verrou SQL observée chez les rédacteurs            |   145,7 |   133,1 |   139,3 | **139,3 — échec** |    <100 |
| Confirmation de journal durable côté service                  |   173,8 |   165,1 |   168,7 |         **168,7** |    <200 |

Échantillons : 30 mutations/série ; 117, 113 et 112 confirmations. L'attente est observée dans `pg_stat_activity`, `wait_event_type='Lock'`, sur les connexions dédiées aux écrivains. Les observations sont regroupées par PID et début de requête ; zéro pour les écritures sans attente observée. La durée entre première et dernière observation d'attente est une **borne inférieure échantillonnée**, pas le simple chevauchement avec une mutation. La cadence visée est 5 ms plus le temps de la requête d'observation et de l'ordonnanceur ; aucune précision de 5 ms garantie. Une attente déjà sous-estimée dépasse le plafond.

Les mutations passent directement par PostgreSQL et leurs vrais triggers, les updates par `Room`/`Store`. **HTTP, WSS et réseau ne sont pas inclus** : ces résultats ne prouvent pas leurs latences, qui ajouteraient du coût. Le passage du plafond de commit ne signifie donc pas que le plafond HTTP est qualifié. Aucun tableau à 10 000 lignes ni profil Yjs de 1 Mio n'a été mesuré après cet arrêt. Une première tentative a été arrêtée avant la deuxième série par la garde RAM ; elle ne constitue pas la série finale publiée ici.

## Compromis à décider avant reprise

| Option                                                                                                                            | Conséquence                                                                                                                                                                                                                  | Recommandation                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Profiler puis réduire le travail effectué sous barrière exclusive, en gardant le recontrôle de session/politique/droits au commit | Examiner les plans et la réconciliation des accès ; déplacer un calcul hors verrou seulement avec version de précondition et revalidation atomique. Peut conserver le protocole accepté, sans garantie de gain avant preuve. | **Premier choix.** Diagnostiquer les coûts avant de choisir une optimisation. |
| Affiner la barrière d'une mutation individuelle par personne/base                                                                 | Évite de suspendre les rédacteurs dont les droits ne changent pas ; impose un protocole révisé, des courses et une couverture complète des révocations/politiques. Les mutations globales restent à résoudre.                | Deuxième piste si le coût sous verrou ne peut pas être suffisamment réduit.   |
| Réduire provisoirement les bornes de membres/partages, ou accorder une dérogation au seuil d'attente                              | Réduit le périmètre ou augmente la pause visible ; toute nouvelle borne doit être mesurée. Les réglages sont configurables, aucun plafond n'a été abaissé dans cette livraison.                                              | À décider explicitement ; aucune dérogation présumée.                         |

Hypothèse à profiler, non diagnostic établi : la barrière reste détenue pendant la réconciliation complète des droits des pages ordinaires, même quand seuls les droits d'un compte changent. Le banc démontre le blocage ; il n'attribue pas encore les millisecondes aux différents plans/triggers. Aucune optimisation après le constat d'échec.

## Ce qui est prouvé et ce qui ne l'est pas

| Sujet                              | Preuve réelle                                                                                                                                                    | Limite / absence de test                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Hooks du clone                     | 13 tests : hooks installés, absents, modifiés, redirection, vrais refus de commit/push ; `check` commence par le vérificateur                                    | POSIX non exécuté ; les hooks restent modifiables par le propriétaire du clone                                         |
| Bornes de déploiement              | Lecture de chaque variable, défauts, valeurs invalides, cohérence ; documentation des variables                                                                  | Pas encore de service de création/cellule/query appliquant toutes ces bornes transactionnellement                      |
| Héritage et séparation des lignes  | Résolveur de ligne autorise l'owner, ancienne portée de page refusée ; absence de lignes dans les droits matérialisés                                            | HTTP/WSS de lignes, guest read/edit et tickets de cache de lignes non exposés/non éprouvés                             |
| Barrière et snapshot après attente | Écriture d'abord : mutation bloquée et observée comme telle ; révocation de session d'abord : writer attend puis résolveur refuse dans une nouvelle commande SQL | Autres courses ciblées de 6a, regrant, relation, schéma, cycle de vie et erreurs concurrentes encore absentes          |
| Journal réel sous charge           | Quatre rooms, validation et commits réels pendant mutations ; dépassement documenté                                                                              | Transport, projection de ligne et outbox agrégée non qualifiés ; confirmations hors réseau                             |
| Pages ordinaires                   | Suite existante de partages HTTP/WS rejouée, dont invalidation ciblée et retrait/regrant                                                                         | Comparaison alternée avec main, profils 1 Mio et audit exhaustif des révocations reportés après résolution du blocage  |
| Cellules et personnes              | Schéma de versions et références stables préparé                                                                                                                 | CAS, rollback cellule, références massives, anonymisation et migration de données de bases préexistantes non qualifiés |

## Guide manuel de cette preuve

1. Sur cette branche, `pnpm hooks:install`, puis `pnpm hooks:check`. Le second doit annoncer des hooks installés et à jour. `pnpm exec vitest run scripts/git-hooks.test.mjs` crée ses propres clones et constate les refus ; ne pas supprimer les hooks du clone de travail pour faire ce test.
2. Démarrer PostgreSQL avec la configuration de développement existante. Lancer `pnpm test:collab:e2e --suite databases-barriers` **sans** `MEMORIA_MEASURE_DATABASES`. Attendre `PASS database barriers` et `EXIT_CODE=0`. Les deux clients SQL de la preuve sont suspendus dans les deux ordres ; les données sont créées et supprimées dans un schéma de test unique, sans reset de l'application.
3. Lire le journal et les trois distributions publiées. Pour reproduire le banc après décision : portable sur secteur et au moins 3 Gio libres avant chaque série ; dans PowerShell, définir `$env:MEMORIA_MEASURE_DATABASES='true'`, lancer la même commande, puis retirer cette variable avec `Remove-Item Env:MEMORIA_MEASURE_DATABASES`. Durée de préparation non incluse dans les résultats. Le banc doit actuellement finir en échec `STOP_6A_EDITOR_WAIT_BUDGET`, sans contourner la garde.
4. `pnpm test:db` vérifie les contraintes SQL existantes ; `pnpm test:shares:e2e` les parcours de pages/partages existants. `pnpm check` valide les contrôles locaux du socle. Aucun de ces succès ne rend vert le banc de performance.

Ce qui pourrait casser : une migration lancée prématurément sur des lignes existantes, une ancienne application écrivant sans les barrières nouvelles, un chemin de révocation non audité, une pause trop longue du journal sous mutation. **Migration de preuve uniquement : aucune commande `db:migrate` sur les données de travail dans ce guide.** La procédure définitive de déploiement coordonné, les tests deux clients de cellules et la suite complète de 6a restent à livrer après décision.

## Contrôles de la candidate arrêtée

- [`pnpm check`](evidence/session-6a-check.txt) : code 0, **136 tests réussis / 6 SQL ignorés**, 25 fichiers réussis / 1 ignoré ; hooks, lint/format, types des douze packages et preuve Nest réussis.
- [`pnpm test:db`](evidence/session-6a-db.txt) : **6/6 réussis**, exécutés séparément sur PostgreSQL réel.
- [Barrières 6a](evidence/session-6a-barriers-functional.txt) : code 0, accès hérité/portée ancienne fermée/matérialisation bornée et deux ordres de verrouillage observés.
- [Partages HTTP/WS existants](evidence/session-6a-shares-regression.txt) : **7/7 réussis** ; [journal](evidence/session-6a-journal-regression.txt) : **3/3** ; [révocations](evidence/session-6a-revocations-regression.txt) : **1/1**.
- [Performance](evidence/session-6a-barriers-measurement.txt) : **échec volontairement conservé**, assertion `STOP_6A_EDITOR_WAIT_BUDGET`. Ces contrôles fonctionnels ne remplacent pas le plafond bloquant.

La configuration, les bornes, l'indexation et le chemin de mutation chronométré n'ont pas été optimisés après la mesure. La candidate finale ajoute la FK de nettoyage du workspace, renforce l'observation de la seconde course fonctionnelle, contrôle le secteur dès le lanceur et documente les résultats. Le hash final poussé et vérifié figure dans le compte rendu ; aucun hash autoréférent n'est inscrit ici.

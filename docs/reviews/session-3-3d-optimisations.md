# 3d — optimisations préalables, seuil historique encore bloquant

24 octobre 2026. Branche `codex/session-3d-collaboration-capacity`, depuis main `e38a17e`. **Cette livraison ne termine pas 3d.** La borne reste à 1 Mio ; les critères restent p95 < 50 ms/update et < 500 ms au chargement froid sur les deux profils. Aucun pool ni réservation proportionnelle n'est activé.

## Résultat à relire

| Version / série                                      | Update contenu p95 | Update historique p95 | Froid contenu p95 | Froid historique p95 |
| ---------------------------------------------------- | -----------------: | --------------------: | ----------------: | -------------------: |
| Main après RAM libérée, diagnostic précédent         |           43,51 ms |          **65,01 ms** |         229,34 ms |        **642,91 ms** |
| Version finale, première série d'updates             |           15,96 ms |          **57,55 ms** |                 — |                    — |
| Version finale, contrôle des plans SQL / froid final |           16,16 ms |          **55,68 ms** |         296,24 ms |            438,81 ms |
| Cible inchangée                                      |            < 50 ms |               < 50 ms |          < 500 ms |             < 500 ms |

Les deux dernières séries d'updates ont le même code applicatif. La seconde ajoute seulement un relevé des compteurs PostgreSQL **après** les échantillons. Leurs journaux se terminent par **EXIT_CODE=1**, avec l'assertion historique visible. Le froid final termine par **EXIT_CODE=0**. Aucun essai en échec n'est transformé en succès ; aucun percentile n'est filtré. La capacité de trente pages et le dimensionnement 4 vCPU / 8 Gio restent non mesurés.

Machine : Ryzen 7 5800H, Windows, Node 24.21, PostgreSQL 17.11 local Docker. Le développeur doit rester **sur batterie** : état Windows 1, charge 56 % au dernier relevé ; environ 3,63 Gio de RAM libre sur 13,86 Gio visibles. Aucun réglage d'alimentation modifié. Cela décrit les conditions ; aucune comparaison secteur/batterie ne permet d'attribuer causalement l'écart à l'alimentation. Aucun build ni autre benchmark simultané. Les applications Memoria existantes restent lancées.

Méthode inchangée : snapshots contenu 1 045 110 octets / JSON 1 040 382 (500 blocs), historique 1 042 470 / JSON 100 802 (300 blocs, 41 129 clients historiques). Vingt chauffes puis **200 updates non filtrées**, validation isolée + transaction durable réelle + commit de réplique. Pas de réseau, projection ou attente de file. Deux chauffes puis **30 chargements froids non filtrés** via Hocuspocus, PostgreSQL, arbre vivant et nouveau worker par salle ; pas de queue de journal dans ce benchmark. Le client de la mesure chaude est simulé dans le processus de test, ce n'est pas une mesure de cinquante navigateurs.

## Fichiers et commits à lire en priorité

1. `fac1dcc` — `apps/collab/src/service/store.ts`, `access.ts`, `leadership.ts` et `testing/journal.e2e.ts` : transactions SQL.
2. `565cf55`, puis `9c28b3b` — `incremental-replica.ts`, `incremental-validator.ts`, `incremental-worker.ts`, `room.ts` et leurs tests : reconstruction, réservations et libération du journal rejoué.
3. Les [updates finales](session-3d-final-warm.txt), [échantillons](session-3d-final-warm.json), [froid final](session-3d-final-cold.txt) et [échantillons froids](session-3d-final-cold.json).
4. [ADR 017](../adr/017-collaboration-temps-reel.md), [ARCHITECTURE.md](../../ARCHITECTURE.md) et [guide d'hébergement](../self-hosting.md) : arrêt maintenu, objectifs inchangés.

## Ce qui change et ce qui est prouvé

| Sujet              | Changement                                                                                                                                                                                                  | Preuve réelle                                                                                                                                                                               | Limite                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plans SQL          | Requêtes nommées pour droits, leadership, reçus et journal. Seul le plan est réutilisé.                                                                                                                     | Après chauffe : 435 plans génériques / 5 personnalisés pour droits, fence, reçu et append ; suppression d'appartenance refusée après réutilisations.                                        | Pas de cache de session ou de droits. Pas de mesure sur une grande base peuplée.                                                                                      |
| Allers-retours SQL | Pipelining `pg` activé uniquement dans collab ; BEGIN/fence/verrou page envoyés dans l'ordre. Droits/révision lus après acquisition du verrou. Réservation/reçus regroupés.                                 | Concurrence entre pages pour un UUID, concurrence de révision sur une page, révocation sous verrou, leadership perdu, échec SQL au milieu d'un lot et réutilisation du même PID PostgreSQL. | Pas de test de toutes les partitions réseau. Les autres apps gardent le mode SQL précédent.                                                                           |
| Durabilité         | Réservation + contrôle d'appartenance en un CTE ; insertion journal + révision/planification en un CTE. Toutes les requêtes en vol sont attendues avant rollback/release. COMMIT reste après les contrôles. | Trigger faisant échouer le journal, trigger faisant échouer la réservation, collision de reçu tardive : aucune écriture partielle ; reprise réussie.                                        | Une coupure de connexion au COMMIT reste traitée par le reçu idempotent existant.                                                                                     |
| Réplique           | Un seul replay `Y.mergeUpdates` du snapshot/journal ; suppression du Y.Doc temporaire et du réencodage de chargement inutile. Envoi de l'init au worker avant le décodage vivant.                           | Rechargement SQL avec journal résiduel, égalité des deux documents ; test de 80 updates avec suppressions/champs et rollback ; deux séries froides sous 500 ms.                             | Pas de benchmark d'un journal très long. Un worker par document reste en place.                                                                                       |
| UUID déjà réservés | À la première update d'une réplique, contrôle de tous les UUID. Puis seulement ceux introduits depuis le dernier commit confirmé. Ensemble limité aux blocs courants.                                       | Tests : abort/retry, commit, insertion, suppression/réintroduction, rechargement ; collisions entre pages en SQL.                                                                           | Suppose la propriété immuable d'un UUID dans `collaboration_block_ids`. Aucun autre code ne doit réattribuer ou supprimer ces réservations pendant la vie de la page. |

L'exécution PostgreSQL reste séquentielle sur une même connexion ; le [pipelining](https://node-postgres.com/features/pipelining) réduit seulement l'attente entre commandes. Le contrôle des UUID utilise `RETURNING` pour les lignes nouvellement insérées : les sous-requêtes d'un [CTE de modification](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-MODIFYING) partagent un snapshot. Pas de verrou de workspace, pas de désactivation de fsync/synchronous_commit, pas de suppression de validation Zod ou de la limite de taille.

**Contrôles :** `pnpm check` réussit, 12 packages typés, preuve Nest, **92 tests Vitest réussis / 6 tests SQL génériques ignorés**. [Journal complet](session-3d-optimisations-check.txt). Les **12 suites fonctionnelles collab** passent : 26 tests Node comptés, dont les douze scénarios de transport et leur parent ; [journal complet](session-3d-functional.txt). La réussite de ces tests ne couvre pas l'échec du benchmark chaud. Pas de nouvelle relecture visuelle dans deux navigateurs ; les tests de transport utilisent des providers réels et PostgreSQL.

## Diagnostic et séries intermédiaires conservées

Le build de production collab passe aussi ([journal](session-3d-optimisations-build.txt)). Dernière correction `9c28b3b` : lorsqu'un chargement contient des updates SQL, retenir immédiatement un checkpoint compact au lieu de toute la liste rejouée. Les 19 tests de réplique et les 3 tests SQL du journal sont relancés après cette correction ([unitaire](session-3d-replay-final-unit.txt), [SQL](session-3d-replay-final-journal.txt)). Les douze suites fonctionnelles précédentes portaient sur les autres optimisations. Cette condition n'est pas empruntée par les mesures chaud/froid ci-dessus, qui initialisent une réplique sans journal résiduel ; aucune mesure de performance avec longue queue de journal n'est revendiquée.

Le [profilage instrumenté](session-3d-query-stages.json) sur la référence place le p95 historique à 51,57 ms dans l'application Yjs et à 1,67 ms dans le codec ; l'étape de contrôle de taille n'effectue presque aucun réencodage dans cette série. Ce test direct sans worker sert à localiser le coût, **pas à remplacer le benchmark de production**. Le [profil CPU brut](session-3d-yjs.cpuprofile) et sa [synthèse](session-3d-cpu-summary.json) montrent principalement des reconstructions/itérations des vecteurs d'état Yjs sur les nombreux clients historiques. L'instrumentation couvre aussi la génération des updates par le client simulé ; ce profil ne donne donc pas à lui seul une répartition exacte du CPU du serveur isolé. Le [plan SQL initial](session-3d-access-plan.json) relève 9,57 ms de planification et 0,923 ms d'exécution sur un appel, pas un percentile.

| Étape mesurée                      | Update contenu / historique p95 | Statut           |
| ---------------------------------- | ------------------------------- | ---------------- |
| Plans nommés + CTE, avant pipeline | 24,59 / 65,06 ms                | échec historique |
| Premier pipeline                   | 20,40 / 61,80 ms                | échec historique |
| Pipeline complet                   | 17,32 / 56,74 ms                | échec historique |
| Réservations incrémentales         | 15,96 / 57,55 ms                | échec historique |
| Relevé final des plans             | 16,16 / 55,68 ms                | échec historique |

Tous les fichiers `session-3d-{sql-warm,pipeline-warm,pipeline-final-warm,reservations-warm,final-warm}.{txt,json}` sont conservés. Le gain propre du dernier cache d'UUID n'est pas établi sur le profil historique ; il supprime une réservation redondante, sans être présenté comme une solution au seuil.

Froid : replay optimisé 214,91 / 531,86 ms (échec), dispatch anticipé 272,14 / 476,68 ms (succès), version finale 296,24 / 438,81 ms (succès). Journaux/JSON `session-3d-{replay-cold,dispatch-cold,final-cold}`. Les journaux ont seulement leurs fins de ligne et espaces terminaux normalisés ; les JSON sont formatés sans suppression d'échantillon.

Le [patch de profilage](session-3d-profiler.patch) vise exclusivement le diagnostic `5c7c201`, dans un checkout jetable, pas le code courant. Il ajoute les suites `diagnostic` et `access-plan`. Les anciens scripts ont été retirés du code de production ; les journaux [diagnostic](session-3d-query-stages.txt), [plan](session-3d-access-plan.txt) et [CPU](session-3d-cpu-profile.txt) conservent leurs fins d'exécution.

## Ce qui pourrait casser et test manuel

Le risque principal est l'ordre des requêtes : une lecture de révision déplacée avant le verrou, un commit envoyé avant vérification ou un rollback sans attendre les requêtes en vol casserait l'isolation. Les tests ci-dessus doivent rester obligatoires. Les réservations incrémentales doivent repartir de zéro après perte/recréation d'une réplique. Le replay groupé doit conserver les suppressions et les identités Yjs ; il ne reconstruit jamais le document depuis du JSON.

1. Utiliser `.env` et PostgreSQL de développement habituels ; ne pas réinitialiser les données. Les suites créent leurs propres schémas puis les retirent.
2. Lancer `pnpm check`, puis `pnpm test:collab:e2e --suite journal`, `--suite revocations` et `--suite transport`. Les refus intentionnels produisent des messages d'erreur ; vérifier les compteurs finaux et le code de sortie.
3. Sans build simultané, lancer séparément `pnpm test:collab:e2e --suite warm` puis `--suite cold`. Les sorties `.local/3a-warm-production.json` et `.local/3a-cold-production.json` contiennent les mesures avant assertion. Le chaud peut encore échouer : ne pas contourner ce seuil.
4. Pour une vérification visuelle après redémarrage de collab avec ce build, reprendre le guide 3b/3c : deux comptes dans une page, texte et champs de fiche simultanés, coupure/reconnexion et rechargement après confirmation. Comparer le contenu conservé. Ce parcours manuel n'a pas été refait dans cette livraison.

## Compromis avant reprise de 3d

- **Mesurer sur l'hôte cible** : garder 1 Mio et les seuils, lancer ces mêmes profils sur un serveur stable de 4 vCPU / 8 Gio. Recommandé pour qualifier la cible d'auto-hébergement ; nécessite un hôte accessible. Les chiffres du portable restent des diagnostics, sans garantie que le serveur passera. Aucun test n'est déclaré conforme par simple extrapolation.
- **Poursuivre une optimisation interne de Yjs** : travailler sur le coût des vecteurs d'état, dans une preuve isolée avant tout pool. Cela peut demander une modification de dépendance et des tests de convergence/GC bien plus larges. Aucun gain ni délai de résolution garanti ; pas de patch interne Yjs dans cette livraison.
- **Avancer le rebasage** : la preuve antérieure ramène l'historique à environ 103 Kio, mais seulement après nouvelle génération, sur page inoccupée, avec export pour les caches anciens. Cela ne ferait pas réussir le benchmark historique inchangé de 1 Mio : en faire une condition d'admission nécessiterait une nouvelle décision explicite, notamment pour une page continuellement occupée. Ce n'est pas activé ici.

La réservation proportionnelle, le pool partagé avec reprise PostgreSQL et la preuve des trente pages restent suspendus. Le choix « Poste partagé » et la politique de workspace restent planifiés en session 4, pas implémentés ici.

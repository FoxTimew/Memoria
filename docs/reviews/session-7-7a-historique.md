# Session 7a — diagnostic du scénario historique à deux auteurs

29 octobre 2026. Profilage autorisé après l'arrêt à **106,95 ms** de la [correction de contention](session-7-7a-contention.md). **Diagnostic terminé : trois paires alternées complètes après deux campagnes interrompues, toutes conservées. Code applicatif et seuils inchangés**, source `1eacc4abbae9dac2f33b9e664c929923e2a999fd`. Cette étape prépare la décision de correction du banc ; elle ne clôture pas 7a et ne commence pas 7b. Les fermetures des premières campagnes restent un point à expliquer.

## À lire en priorité

- [Banc](../../apps/collab/src/testing/history-profile.ts), [lanceur](../../scripts/profile-files-history.mjs) et [analyse reproductible](../../scripts/analyze-files-history.mjs).
- **Campagne finale** : [données brutes](evidence/session-7-7a-historique/final/measurement.json), [analyse](evidence/session-7-7a-historique/final/analysis.json), [journal complet](evidence/session-7-7a-historique/final/run.txt) et [observations du contrôle](evidence/session-7-7a-historique/final/control-analysis.json).
- [Première campagne, données brutes](evidence/session-7-7a-historique/initial/measurement.json), [analyse](evidence/session-7-7a-historique/initial/analysis.json) et [journal complet](evidence/session-7-7a-historique/initial/run.txt).
- [Reprise interrompue](evidence/session-7-7a-historique/continuous-interrupted/run.txt), [refus secteur](evidence/session-7-7a-historique/power-refusal.txt) et [refus mémoire](evidence/session-7-7a-historique/memory-refusal.txt). Aucune mesure pendant les refus ; reprise après confirmation puis vérification des conditions.

## Protocole et limites de l'instrumentation

Deux configurations, ordre prévu A/B, B/A, A/B : **A**, les deux clients synthétiques partagent le processus du serveur (montage du banc de qualification arrêté) ; **B**, chaque client tourne dans un processus Node séparé. Même machine, application, PostgreSQL, Caddy/WSS, authentification, droits, quotas, pool de validation et projection automatique. Aucun contrôle n'est désactivé. Les identifiants Yjs de la fixture et des clients sont fixes et distincts, pour avoir les mêmes octets et structures dans chaque configuration.

Profil historique : **1 042 017 octets encodés au départ, 41 164 identifiants clients**. Deux emplacements image vides et deux intentions `ready` restent dans la fixture comme dans le banc précédent ; les écritures sont uniquement du texte. Pour chaque configuration, 110 vagues à un auteur puis 110 à deux, avec les dix premières en chauffe et 100 ms de pause après les confirmations. Chaque scénario conserve 100 ou 200 confirmations. Le temps WSS est pris dans le processus client, sans soustraction entre horloges de processus.

Le banc enveloppe les méthodes réelles du pool **dans son processus jetable seulement**. Il mesure : demande → envoi au worker, travail rapporté par le worker, réception/résolution dans le serveur, préparation → commit SQL, reçu WSS, travail synchrone d'édition côté client, file de salle, boucle d'événements et GC. Le résidu hors worker est calculé par échantillon, pas par soustraction de p95. Il inclut messages, ordonnancement et retour JavaScript ; il n'est pas assimilé au seul transfert IPC.

Les profils CPU natifs sont capturés dans les deux configurations. Leurs fichiers `.cpuprofile.gz` ne contiennent que piles, fonctions et temps, pas de capture de variables ni de cookies. Les temps inclusifs de piles se chevauchent : ne pas les additionner. Les durées CPU par thread sont distinctes des percentiles de latence. Le profiler et les sondes ont un coût ; **ces chiffres ne constituent pas une qualification de performances**, même lorsqu'ils respectent 100 ms. Les dépassements restent enregistrés pour ce diagnostic autorisé, sans seuil relevé ni transformation en succès de qualification.

La configuration séparée possède deux samplers de plus pour les processus clients. Ce coût d'instrumentation supplémentaire et la concurrence CPU sur le même portable imposent une remesure sans profiler avant toute qualification.

## Trois paires finales : résultats et diagnostic

La capture CPU reste continue entre les phases à un et deux auteurs. Une sonde observe les deux connexions de contrôle et le recontrôle des accès ; une requête de contrôle dépassant 500 ms déclenche une lecture ponctuelle de `pg_stat_activity`/`pg_blocking_pids`, sans texte SQL ni paramètres. Les délais, l'échec fermé et tous les contrôles applicatifs restent inchangés. Ces sondes ont elles aussi un coût. Le [manifeste d'exécution](evidence/session-7-7a-historique/final/manifest.json) référence le commit intermédiaire `c9ab90a` et les SHA-256 des sources effectivement exécutées, dont la sonde encore non commitée à ce moment ; sa [source exacte](evidence/session-7-7a-historique/final/harness-v3.ts.txt) est conservée.

| p95 serveur validation → commit   |  Série 1 |       Série 2 |  Série 3 |      Médiane |
| --------------------------------- | -------: | ------------: | -------: | -----------: |
| A, clients partagés, un auteur    | 56,69 ms |      51,49 ms | 65,86 ms |     56,69 ms |
| B, clients séparés, un auteur     | 60,21 ms |      57,39 ms | 60,17 ms |     60,17 ms |
| A, clients partagés, deux auteurs | 94,01 ms | **111,48 ms** | 86,90 ms |     94,01 ms |
| B, clients séparés, deux auteurs  | 60,80 ms |      63,46 ms | 63,71 ms | **63,46 ms** |

Le dépassement individuel A2 de 100 ms est conservé. Le diagnostic autorisé ne transforme pas sa médiane en qualification. Chaque scénario comporte bien 100 ou 200 confirmations ; aucune série incomplète n'entre dans ces médianes, et aucune valeur des campagnes précédentes n'est mélangée à cette campagne.

| À deux auteurs, p95 / médiane des trois p95 | A, partagé : séries 1 / 2 / 3  |  Médiane A | B, séparé : séries 1 / 2 / 3   |  Médiane B |
| ------------------------------------------- | ------------------------------ | ---------: | ------------------------------ | ---------: |
| Travail dans le worker                      | 37,945 / 38,554 / 39,221 ms    |  38,554 ms | 49,306 / 46,286 / 50,671 ms    |  49,306 ms |
| Attente dans le pool                        | 0,013 / 0,012 / 0,015 ms       |   0,013 ms | 0,012 / 0,013 / 0,014 ms       |   0,013 ms |
| Résidu après envoi, hors worker             | 49,190 / 63,164 / 45,236 ms    |  49,190 ms | 0,512 / 0,466 / 0,488 ms       |   0,488 ms |
| SQL (`append`)                              | 13,137 / 12,553 / 12,864 ms    |  12,864 ms | 13,441 / 21,473 / 13,125 ms    |  13,441 ms |
| Reçu WSS                                    | 349,573 / 344,399 / 301,532 ms | 344,399 ms | 302,098 / 299,747 / 303,969 ms | 302,098 ms |
| Boucle d'événements du serveur              | 68,551 / 73,073 / 64,422 ms    |  68,551 ms | 10,207 / 10,478 / 10,011 ms    |  10,207 ms |

**Attribution :** le temps passé après l'envoi au worker mais hors de son calcul diminue d'environ 49 ms à 0,5 ms lorsque les clients quittent le thread serveur. Le SQL reste comparable et la file du pool n'explique pas cet écart. Aux points d'observation, aucun travail n'attend dans la file du pool ni dans celle de la salle ; tous les lots contiennent une contribution. Le travail du worker ne disparaît pas : il est même plus lent avec les processus clients concurrents sur les cœurs du portable. Les percentiles ne s'additionnent pas.

Sur toute la capture (un puis deux auteurs), le temps CPU échantillonné inclusif de `getStateVector` sur le thread serveur vaut **31,58 / 35,54 / 28,89 s** en A, contre **15,10 / 14,58 / 13,66 s** en B. Le validateur séparé porte encore environ 7,00–7,44 s dans `getStateVector`, contre 0,45 s dans `decodeDocument`. Le coût dominant observé vient des parcours de l'historique Yjs, pas du codec seul. Cela justifie de corriger d'abord le placement des clients du banc, sans modifier le validateur ni les droits. Le rebasage reste nécessaire avant usage prolongé.

### Conditions et fermetures observées

| Configuration, ordre d'exécution | Windows avant préparation | Windows après préparation | WSL MemAvailable après préparation | Secteur / swap |
| -------------------------------- | ------------------------: | ------------------------: | ---------------------------------: | -------------- |
| A1                               |                  4,74 Gio |                  4,26 Gio |                           5,28 Gio | 2 / zéro       |
| B1                               |                  4,80 Gio |                  3,98 Gio |                           5,28 Gio | 2 / zéro       |
| B2                               |                  4,93 Gio |                  4,06 Gio |                           5,28 Gio | 2 / zéro       |
| A2                               |                  4,89 Gio |                  4,36 Gio |                           5,26 Gio | 2 / zéro       |
| A3                               |                  4,87 Gio |                  4,39 Gio |                           5,29 Gio | 2 / zéro       |
| B3                               |                  4,92 Gio |                  4,03 Gio |                           5,26 Gio | 2 / zéro       |

Les fichiers `*-preparation-*.json` et `*-attempt-1-*.json` du dossier final contiennent les valeurs exactes, les relevés après série et vmstat : **454 intervalles, aucune entrée/sortie de swap**. Aucun build ni test en parallèle des séries.

Les six processus finaux terminent sans fermeture pendant la saisie. Toutefois, la sonde du renouvellement de leadership observe **92 attentes de verrou** en A et **10 en B** après dépassement de 500 ms. Ce sont des observations ponctuelles, pas des p95 de renouvellement ni une preuve de la cause des fermetures précédentes. Les erreurs `Connection terminated` de cette dernière campagne arrivent seulement pendant la fermeture des fixtures, après export des profils ; aucun échec de requête de contrôle ni de recontrôle des accès n'est relevé pendant les phases de saisie. **`CONTROL_UNAVAILABLE` reste non expliqué causalement** pour les campagnes interrompues ; il faut conserver les sondes lors de la requalification et analyser la transaction bloquante si cela se reproduit, sans prolonger le bail ni désactiver l'échec fermé.

## Première campagne conservée intégralement

| À deux auteurs, p95             | A1 : partagé | B1 : séparé | B2 : séparé | A2 : partagé |
| ------------------------------- | -----------: | ----------: | ----------: | -----------: |
| Serveur, validation → commit    |    109,12 ms |    56,53 ms |    52,41 ms |    107,71 ms |
| Travail dans le worker          |     42,72 ms |    44,23 ms |    41,88 ms |     36,94 ms |
| Attente dans la file du pool    |     0,014 ms |    0,014 ms |    0,012 ms |     0,013 ms |
| Résidu après envoi, hors worker |     58,78 ms |     0,55 ms |     0,54 ms |     63,90 ms |
| SQL (`append`)                  |     10,96 ms |    12,50 ms |    11,83 ms |     12,70 ms |
| Reçu WSS                        |    348,29 ms |   285,88 ms |   276,44 ms |    321,11 ms |

Ces deux paires montrent le même effet malgré l'ordre inversé. Dans la première paire, les échantillons CPU attribués à `getStateVector` sur le thread principal passent d'environ **21,37 s** à **8,89 s** sur la fenêtre à deux auteurs ; la première réplique de client séparé porte elle-même cette charge Yjs. La source locale de Yjs parcourt `store.clients` pour construire ce vecteur à chaque transaction. L'attente du pool est négligeable ; le travail réel du worker reste présent et comparable. Cela soutient fortement l'hypothèse d'une contamination de la latence serveur par les clients synthétiques du même processus.

La troisième série A s'arrête au début du scénario à deux auteurs, avec **`CONTROL_UNAVAILABLE`**. Sa phase à un auteur est conservée (59,92 ms serveur), mais ce processus n'est pas compté comme série complète. Aucune troisième paire ou médiane sur trois séries n'est revendiquée pour cette campagne. La cause précise de cette fermeture n'est pas démontrée par le premier journal ; elle ne doit pas être imputée sans preuve à l'export CPU, au pool ou à PostgreSQL. Le comportement de fermeture n'a pas été contourné.

Le banc suivant conserve une capture CPU continue sur les deux phases et ajoute le relevé de l'erreur de la connexion de révocation avec l'étape/vague. Les délais et la fermeture du service restent inchangés. La première version exécutée du banc et son lanceur sont conservés dans les preuves (`harness-v1.ts.txt`, `runner.mjs.txt`) ; la nouvelle version n'est pas présentée comme celle ayant produit les chiffres ci-dessus.

Après libération de mémoire, cette deuxième campagne termine A1, B1 et B2, puis s'arrête en A2 à deux auteurs avec `CONTROL_UNAVAILABLE`. P95 serveur à deux auteurs des phases complètes : **109,14 / 67,73 / 64,35 ms**. Pas de médiane de trois. La sonde de la connexion de révocation ne signale pas d'erreur ; la capture continue n'a donc pas supprimé la fermeture. [Traces et source v2](evidence/session-7-7a-historique/continuous-interrupted/measurement.json). La troisième campagne décrite plus haut ajoute l'observation du leadership et du recontrôle, sans correction applicative.

### Arrêts matériels et état vérifié

La reprise a d'abord été refusée sur batterie (`BatteryStatus=1`), puis après retour confirmé au secteur à **2,94 Gio Windows** avant préparation (minimum 3 Gio). Après les contrôles, une lecture à 3,11 Gio a permis une nouvelle tentative ; le garde-fou avant fixture a relevé **2,71 Gio** et l'a refusée aussi. WSL restait au-dessus de 5 Gio disponibles. Aucune série n'a commencé à ces moments : [second refus mémoire](evidence/session-7-7a-historique/memory-refusal-2.txt). Les campagnes suivantes n'ont repris qu'après confirmation du développeur et nouveaux contrôles conformes ; aucune baisse de seuil.

Les cinq séries initiales et les quatre de la reprise interrompue ont une hygiène conforme, mais le dernier processus de chacune est fonctionnellement incomplet. Les six séries finales sont complètes. `pnpm check` sur le code diagnostique final passe : **169 tests réussis, 6 ignorés, 32 fichiers réussis**, hooks vérifiés et preuve Nest inclus. [Journal complet final](evidence/session-7-7a-historique/check-final.txt), [journal intermédiaire conservé](evidence/session-7-7a-historique/check.txt). Ce succès statique/unitaire ne remplace pas la qualification collaborative sans profiler.

## Décision à préparer

La piste prioritaire est de placer les clients synthétiques hors du processus serveur dans le **banc de qualification**, puis de le rejouer sans profiler, avec tous les scénarios, trois séries et les plafonds existants. Ce serait une correction du dispositif de mesure ; aucune optimisation du validateur, des droits ou de SQL n'est livrée ici. Garder une trace légère des échecs du contrôle et arrêter si la fermeture se reproduit. Une nouvelle qualification resterait nécessaire, avec froid et comparaison main ; le rebasage demeure obligatoire dans la Liste pré-pilote. **Décision du développeur requise avant cette correction**, conformément à l'arrêt de l'ADR 021 et à l'autorisation actuelle limitée au profilage.

Le reçu WSS du pire cas historique reste supérieur à 200 ms dans les deux configurations, y compris la campagne finale : ne pas annoncer une résolution de l'attente utilisateur. Le plafond WSS <200 ms des campagnes mixtes demeure inchangé et doit être éprouvé dans son périmètre. La machine de développement avec clients et serveur, même en processus séparés, ne remplace pas l'hôte dédié 4 vCPU/8 Gio.

## Guide de relecture

1. Lire les trois p95 et leur médiane de la campagne finale, puis les deux campagnes interrompues et les traces secteur/mémoire/swap. Ne pas fusionner les campagnes ni effacer leurs fermetures.
2. `node scripts/analyze-files-history.mjs docs/reviews/evidence/session-7-7a-historique/final` recalcule les quatre médianes sur **six processus complets**, avec 18 profils CPU bruts. Sur `initial` ou `continuous-interrupted`, l'analyse refuse de produire une médiane de trois. Le recalcul reformate le JSON ; utiliser Prettier pour retrouver la présentation versionnée.
3. Après secteur et mémoire conformes, `node scripts/profile-files-history.mjs` prépare une campagne neuve dans `.local/history-profile/`, avec les contrôles mémoire avant/après préparation et vmstat pendant chaque série. Aucun build ou autre test en parallèle.
4. Le lanceur du diagnostic ne modifie ni les données utilisateur ni les sources de production. Il crée et nettoie ses schémas PostgreSQL, conteneurs Caddy et clients. La qualification `pnpm measure:files` reste inchangée dans cette livraison.

Les défauts que cette étape peut masquer sont ceux de l'instrumentation : coût du sampler, synchronisation des vagues, export des profils ou données partielles après fermeture. Les traces et compteurs d'échantillons sont conservés pour les rendre visibles. Aucune nouvelle route ni autorisation n'est introduite.

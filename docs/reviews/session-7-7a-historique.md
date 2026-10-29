# Session 7a — diagnostic du scénario historique à deux auteurs

29 octobre 2026. Profilage autorisé après l'arrêt à **106,95 ms** de la [correction de contention](session-7-7a-contention.md). **Diagnostic partiel : deux paires complètes, troisième paire interrompue ; reprise bloquée par la mémoire. Code applicatif et seuils inchangés**, source `1eacc4abbae9dac2f33b9e664c929923e2a999fd`. Cette étape prépare la décision de correction ; elle ne clôture pas 7a et ne commence pas 7b.

## À lire en priorité

- [Banc](../../apps/collab/src/testing/history-profile.ts), [lanceur](../../scripts/profile-files-history.mjs) et [analyse reproductible](../../scripts/analyze-files-history.mjs).
- [Première campagne, données brutes](evidence/session-7-7a-historique/initial/measurement.json), [analyse](evidence/session-7-7a-historique/initial/analysis.json) et [journal complet](evidence/session-7-7a-historique/initial/run.txt).
- [Refus secteur](evidence/session-7-7a-historique/power-refusal.txt) et [refus mémoire](evidence/session-7-7a-historique/memory-refusal.txt) : aucun échantillon nouveau après ces refus.

## Protocole et limites de l'instrumentation

Deux configurations, ordre prévu A/B, B/A, A/B : **A**, les deux clients synthétiques partagent le processus du serveur (montage du banc de qualification arrêté) ; **B**, chaque client tourne dans un processus Node séparé. Même machine, application, PostgreSQL, Caddy/WSS, authentification, droits, quotas, pool de validation et projection automatique. Aucun contrôle n'est désactivé. Les identifiants Yjs de la fixture et des clients sont fixes et distincts, pour avoir les mêmes octets et structures dans chaque configuration.

Profil historique : **1 042 017 octets encodés au départ, 41 164 identifiants clients**. Deux emplacements image vides et deux intentions `ready` restent dans la fixture comme dans le banc précédent ; les écritures sont uniquement du texte. Pour chaque configuration, 110 vagues à un auteur puis 110 à deux, avec les dix premières en chauffe et 100 ms de pause après les confirmations. Chaque scénario conserve 100 ou 200 confirmations. Le temps WSS est pris dans le processus client, sans soustraction entre horloges de processus.

Le banc enveloppe les méthodes réelles du pool **dans son processus jetable seulement**. Il mesure : demande → envoi au worker, travail rapporté par le worker, réception/résolution dans le serveur, préparation → commit SQL, reçu WSS, travail synchrone d'édition côté client, file de salle, boucle d'événements et GC. Le résidu hors worker est calculé par échantillon, pas par soustraction de p95. Il inclut messages, ordonnancement et retour JavaScript ; il n'est pas assimilé au seul transfert IPC.

Les profils CPU natifs sont capturés dans les deux configurations. Leurs fichiers `.cpuprofile.gz` ne contiennent que piles, fonctions et temps, pas de capture de variables ni de cookies. Les temps inclusifs de piles se chevauchent : ne pas les additionner. Les durées CPU par thread sont distinctes des percentiles de latence. Le profiler et les sondes ont un coût ; **ces chiffres ne constituent pas une qualification de performances**, même lorsqu'ils respectent 100 ms. Les dépassements restent enregistrés pour ce diagnostic autorisé, sans seuil relevé ni transformation en succès de qualification.

La configuration séparée possède deux samplers de plus pour les processus clients. Ce coût d'instrumentation supplémentaire et la concurrence CPU sur le même portable imposent une remesure sans profiler avant toute qualification.

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

Le banc suivant conserve une capture CPU continue sur les deux phases et ajoute le relevé de l'erreur de la connexion de contrôle avec l'étape/vague. Les délais et la fermeture du service restent inchangés. La première version exécutée du banc et son lanceur sont conservés dans les preuves (`harness-v1.ts.txt`, `runner.mjs.txt`) ; la nouvelle version n'est pas présentée comme celle ayant produit les chiffres ci-dessus.

### Arrêts matériels et état vérifié

La reprise a été refusée sur batterie (`BatteryStatus=1`), puis après retour confirmé au secteur à **2,94 Gio Windows** avant préparation (minimum 3 Gio). Après les contrôles, une lecture à 3,11 Gio a permis une nouvelle tentative ; le garde-fou avant fixture a relevé **2,71 Gio** et l'a refusée aussi. WSL restait au-dessus de 5 Gio disponibles. Aucune nouvelle série n'a commencé : [second refus mémoire](evidence/session-7-7a-historique/memory-refusal-2.txt). La demande de marge mémoire reste en attente ; aucune baisse de seuil.

Les cinq séries initiales ont une hygiène conforme (secteur, mémoire et zéro swap), mais le dernier processus est fonctionnellement incomplet. La nouvelle capture continue et sa sonde de contrôle passent typage/lint ; elles **n'ont pas encore été exécutées en campagne**, à cause des refus avant préparation. `pnpm check` passe : **169 tests réussis, 6 ignorés, 32 fichiers réussis**, hooks vérifiés et preuve Nest inclus. [Journal complet](evidence/session-7-7a-historique/check.txt). Ce succès statique/unitaire ne remplace ni les trois paires complètes ni la qualification collaborative.

## Décision à préparer

La piste prioritaire est de placer les clients synthétiques hors du processus serveur dans le **banc de qualification**, puis de le rejouer sans profiler, avec tous les scénarios, trois séries et les plafonds existants. Ce serait une correction du dispositif de mesure ; aucune optimisation du validateur, des droits ou de SQL n'est proposée sur ces deux seules paires. Une nouvelle qualification resterait nécessaire, avec froid et comparaison main ; le rebasage demeure obligatoire dans la Liste pré-pilote.

Le reçu WSS du pire cas historique reste supérieur à 200 ms dans ces deux configurations : ne pas annoncer une résolution de l'attente utilisateur. Le plafond WSS <200 ms des campagnes mixtes demeure inchangé et doit être éprouvé dans son périmètre. La machine de développement avec clients et serveur, même en processus séparés, ne remplace pas l'hôte dédié 4 vCPU/8 Gio.

## Guide de relecture

1. Lire les quatre colonnes brutes et la série interrompue, puis les traces secteur/mémoire/swap dans le dossier de preuve. Ne pas calculer une médiane de trois sur une série incomplète.
2. `node scripts/analyze-files-history.mjs docs/reviews/evidence/session-7-7a-historique/initial` recalcule l'analyse : quatre séries complètes et **aucune médiane**, avec les profils CPU bruts conservés.
3. Après secteur et mémoire conformes, `node scripts/profile-files-history.mjs` prépare une campagne neuve dans `.local/history-profile/`, avec les contrôles mémoire avant/après préparation et vmstat pendant chaque série. Aucun build ou autre test en parallèle.
4. Le lanceur du diagnostic ne modifie ni les données utilisateur ni les sources de production. Il crée et nettoie ses schémas PostgreSQL, conteneurs Caddy et clients. La qualification `pnpm measure:files` reste inchangée dans cette livraison.

Les défauts que cette étape peut masquer sont ceux de l'instrumentation : coût du sampler, synchronisation des vagues, export des profils ou données partielles après fermeture. Les traces et compteurs d'échantillons sont conservés pour les rendre visibles. Aucune nouvelle route ni autorisation n'est introduite.

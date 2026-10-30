# 7d — profilage de la charge historique et correction ciblée

30 octobre 2026. Suite autorisée après `a82105b` : profiler puis corriger une cause établie, contrôles et plafonds inchangés. La série initiale à 53,955 ms reste conservée dans la [fiche précédente](session-7-7d-reprise-campagne.md).

## Diagnostic présenté avant optimisation

Trois séries diagnostiques du même scénario historique avec conversions, dix clients séparés, cinq pages. Échantillonnage CPU du serveur et des quatre workers, horloges de file/IPC et observateur PostgreSQL séparé (20 ms). Secteur, mémoire et swap conformes. Ces mesures instrumentées ne constituent pas une qualification.

Le dépassement initial n'est pas reproduit dans ces trois séries : plus grand p95 des pages typiques **39,339 / 44,940 / 38,599 ms**. L'instrumentation et la variabilité peuvent modifier l'ordonnancement ; ces résultats ne remplacent pas l'échec antérieur.

Pour la page typique d'index 2 :

| Portion (p95, ms)                            | Série 1 | Série 2 | Série 3 |
| -------------------------------------------- | ------- | ------- | ------- |
| Travail dans le worker, durée murale         | 6,836   | 7,028   | 7,719   |
| Attente avant dispatch du pool               | 0,032   | 0,022   | 0,047   |
| IPC et reprise de la boucle Node hors worker | 10,942  | 10,742  | 8,890   |

Les projections partagent bien le pool et produisent des attentes ponctuelles jusqu'à 76 ms ; elles ne dominent pas son p95. Le retard de boucle Node atteint **154 / 111 / 116 ms** au maximum. Les échantillons CPU attribuent **18,359 / 18,434 / 17,256 secondes inclusives** à `applyUpdate` sur **52,951 / 52,132 / 51,343 secondes observées**, dont **11,325 / 11,575 / 10,494 secondes** dans `getStateVector`. Les piles inclusives se chevauchent : ne pas les additionner. L'application durable dans `Room` puis la réapplication idempotente native par Hocuspocus sont toutes deux présentes dans les piles.

PostgreSQL est très majoritairement en attente du client ou actif sans événement de verrou. Seulement **1 / 1 / 0** observations de verrou `transactionid`, avec un échantillonnage de 20 ms qui peut manquer des attentes brèves. La durée murale d'une requête côté Node inclut son retard de callback ; elle n'est pas du temps CPU SQL. Aucun retour de la contention de registre fichiers démontré. Le coût synchrone de l'historique sur la boucle commune est établi ; la cause exacte du seul p95 initial de 53,955 ms ne peut pas être attribuée rétroactivement avec certitude.

## Correction candidate, non qualifiée

Rendre la main à l'I/O (`setImmediate`) avant la publication Yjs du lot déjà committé, puis avant de laisser Hocuspocus réappliquer son message. La file de salle garde la propriété du lot jusqu'à la fin ; validation, transaction, application puis reçu conservent leur ordre. Aucun contrôle supprimé, aucun déplacement des points de mesure, aucun changement de quota/délai, aucune dépendance Yjs/Hocuspocus modifiée. La correction vise la progression des autres salles pendant les callbacks lourds ; elle ne supprime pas le coût structurel de l'historique. Rebasage pré-pilote toujours obligatoire.

## Requalification sans profileur : nouvel arrêt

Douze séries exécutées, **onze conformes et une en échec** ; aucune série écartée. Chaque série utilise dix rédacteurs dans des processus séparés, une page de 1 Mio et quatre pages typiques, avec les mêmes octets initiaux qu'avant correction. Les deux textures 8K (uniforme et peu compressible) chevauchent la saisie lorsque les conversions sont activées. Les horloges et les plafonds sont inchangés.

| Page principale / conversions | Trois p95 serveur (ms)   | Médiane | Trois p95 reçu WSS auteur (ms) | Médiane WSS |
| ----------------------------- | ------------------------ | ------- | ------------------------------ | ----------- |
| Contenu / non                 | 14,636 / 14,122 / 16,010 | 14,636  | 34,791 / 34,016 / 36,883       | 34,791      |
| Contenu / oui                 | 17,205 / 17,046 / 18,551 | 17,205  | 42,197 / 41,408 / 44,775       | 42,197      |
| Historique / non              | 59,829 / 51,902 / 52,759 | 52,759  | 288,536 / 256,689 / 265,332    | 265,332     |
| Historique / oui              | 75,505 / 68,639 / 72,997 | 72,997  | 370,640 / 348,293 / 368,246    | 368,246     |

Les pages principales respectent leurs plafonds serveur (<50 contenu, ≤100 historique). Le reçu historique reste un indicateur, pas le plafond contenu de 200 ms. En revanche, le plus grand p95 serveur des **pages typiques pendant historique + conversions** vaut **41,582 / 39,805 / 55,624 ms**. La troisième série échoue sur la page d'index 2, **175 992 octets** : serveur **55,624 >50 ms**, transaction **23,890 ms**, reçu **112,174 ms**, application chez l'autre rédacteur **112,744 ms**. La médiane de ces maxima ne masque pas l'échec individuel. L'arrêt est conservé, sans seconde optimisation ni relance sélective.

Les échantillons appariés de cette page montrent, pour sa contribution la plus lente, **51,500 ms entre début de validation et appel SQL**, puis **18,223 ms jusqu'au commit**. Ce premier intervalle inclut le worker, sa file et le retour sur Node : cette série sans profileur ne permet pas de les séparer. Ne pas attribuer rétrospectivement ses 55,624 ms uniquement à la boucle Node ou uniquement au pool. Les séries diagnostiques expliquent un coût important, pas une causalité exhaustive de chaque valeur extrême. La candidate ne démontre pas de gain fiable ; aucune comparaison alternée avant/après de cette correction n'a été effectuée.

Les **12 000 écritures mesurées** convergent, sans fermeture des 120 connexions observées sur les douze fixtures. Les **24 conversions** respectent 30 s/512 Mio : maximum **16,739 s**, pic cgroup **116,875 Mio**. Secteur reconnu, douze relevés conformes, **445 intervalles vmstat sans swap** ; minimum après préparation **2,274 Gio Windows / 5,491 Gio WSL**. Les relevés avant préparation ≥3 Gio sont également conservés. Ce sont des résultats de cette fixture, sans téléversement de gros fichiers ni saturation CPU volontaire.

### Décision suivante proposée

**Recommandation : preuve d'isolation du traitement Yjs lourd**, avant une nouvelle modification de production. La boucle qui reçoit les résultats de validation/SQL et assure le contrôle ne devrait pas subir les longues applications historiques d'une autre salle. Évaluer un worker/processus de publication par groupe de salles, avec IPC, ordre commit/diffusion/reçu, reprise PostgreSQL et budget mémoire explicitement testés. Cela demande un travail plus large que deux points de cession I/O ; aucune latence ni capacité de cette solution n'est encore mesurée. Garder les plafonds actuels. Une simple nouvelle relance de la même candidate ne suffirait pas à effacer cet échec.

Autre arbitrage possible, **non appliqué ni recommandé ici** : dérogation strictement limitée aux pages typiques coexistantes avec un historique synthétique de 1 Mio et conversions 8K, par exemple <60 ms au lieu de <50, jusqu'au rebasage pré-pilote. Le dernier p95 est 55,624 ms, soit +11,25 % sur le plafond ; aucune garantie qu'une future série reste sous 60. Les autres plafonds et l'échec fermé resteraient inchangés. Seul le développeur peut décider d'une dérogation.

La candidate reste sur la branche de travail, non prête au merge. Saturation CPU/`CONTROL_UNAVAILABLE`, gros transferts, charge NAT et comparaison alternée finale suspendus à cet arbitrage. Aucun risque accepté.

## Tests de correction

Les types du service passent. Six suites sur le vrai service passent après la modification : transport **13**, journal **3**, références fichiers WSS/HMAC **3**, révocations **1**, reprise du pool **2**, frontières d'accès **20**. Les **42 résultats** incluent les tests parents du runner Node ; ne pas les présenter comme 42 attaques distinctes. Ils couvrent notamment le commit avant diffusion, la confirmation de chaque contributeur regroupé, le rollback, la reconnexion, la perte d'un worker, les droits revérifiés après attente et les références de fichiers interdites. Aucun SQL ni règle de contrôle modifié.

`pnpm check` complet réussit : hooks installés, lint, types, bootstrap Nest, **187 tests réussis, 6 SQL ignorés**, 40 fichiers réussis. Les suites SQL réelles ci-dessus ont été exécutées séparément ; aucune migration modifiée. Premier contrôle arrêté au lint sur deux imports de timers manquants dans le script local de vérification de l'observateur : imports corrigés, journal échoué conservé, contrôle complet relancé sans contournement.

Preuves : [manifeste et empreintes](evidence/session-7-7d-profilage-mixte/manifest.json), [résumé de qualification](evidence/session-7-7d-profilage-mixte/qualification-summary.json), [analyse des profils](evidence/session-7-7d-profilage-mixte/profile-analysis.json), [qualification complète](evidence/session-7-7d-profilage-mixte/qualification.txt.gz), [contrôle complet](evidence/session-7-7d-profilage-mixte/check.txt.gz). Les JSON bruts, profils CPU, observations SQL et relevés d'hygiène sont compressés sans perte et recensés dans le manifeste ; aucun paramètre SQL ni contenu d'authentification enregistré par l'instrumentation. Les essais précédents ne sont pas remplacés.

À lire d'abord : [Room](../../apps/collab/src/service/room.ts), [beforeSync](../../apps/collab/src/service/server.ts), puis le [collecteur](../../apps/collab/src/testing/mixed-profile.ts) et son [analyse](../../scripts/analyze-files-mixed.mjs). Le profileur est exclusivement activé par le banc, jamais par le service livré.

## Reproduction et relecture manuelle

1. Vérifier le secteur, fermer les autres charges ; les garde-fous mémoire et swap restent actifs. Ne lancer aucun test ou build en parallèle.
2. Diagnostic : `node scripts/profile-files-mixed.mjs`, puis `node scripts/analyze-files-mixed.mjs .local/mixed-profile/<horodatage>`. Trois séries instrumentées ; leurs latences ne sont pas une qualification.
3. Qualification : `pnpm measure:files:mixed`, douze séries non instrumentées, arrêt au premier plafond dépassé. Le watchdog extérieur couvre trente minutes de préparation/mesure/nettoyage ; aucun délai du service ni fenêtre mesurée n'a changé.
4. Dans deux navigateurs, modifier simultanément deux pages puis la même page ; attendre « Enregistré sur le serveur », recharger et vérifier les deux contributions. Couper/reprendre le réseau d'un navigateur, puis retirer son accès depuis l'autre : ses écritures ultérieures doivent rester refusées.

Limites : céder la boucle I/O ne garantit pas sa disponibilité sous saturation CPU. Le coût Yjs historique subsiste ; `CONTROL_UNAVAILABLE`, sa reprise dans le vrai front, les gros transferts, la charge NAT et la comparaison alternée finale restent à qualifier séparément. Aucun risque accepté, aucune conclusion de capacité de production.

## Limite de l'instrumentation

Le premier essai a fini ses écritures et exporté les profils CPU, mais sa collecte SQL par IPC est restée bloquée. Processus du banc arrêté et conteneur Caddy de cette seule fixture nettoyé ; aucun service de développement arrêté. Essai conservé, non qualifié. Le collecteur écrit désormais un rapport de sortie, attendu avec une borne de dix secondes ; son protocole a été vérifié sur une connexion PostgreSQL réelle en lecture seule avant les trois séries. L'origine exacte de la perte du premier retour IPC n'est pas affirmée. Une annulation après préparation est également distinguée de l'autorisation de démarrer : aucun démarrage sur un message `cancel`.

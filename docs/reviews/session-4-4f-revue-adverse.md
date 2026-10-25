# Session 4f — revue adverse de la session 4

**Suite décidée le 25 octobre 2026 :** le développeur a statué sur R01–R14 dans la [matrice](session-4-4f-matrice.md). Le [diagnostic et l'optimisation SQL](session-4-4f-sql-performance.md) traitent R15 avec la nouvelle marge `max(10 %, 2 ms)`. La comparaison finale, correctifs 4f inclus, passe cette nouvelle règle et les plafonds absolus. Les chiffres ci-dessous décrivent la livraison initiale et restent archivés sous son ancienne règle ; ils ne sont pas réétiquetés comme un succès.

Branche `codex/session-4-strong-auth`, après les validations manuelles de 4a à 4e. **La revue est livrée pour décision ; la validation de performance reste en échec. Aucun risque résiduel n'est accepté par l'agent.** Création et fusion de l'unique PR par le développeur, après décision. La description consolidée se trouve dans `.local/session-4-final-pr.md` ; les descriptions intermédiaires sont conservées.

## Résultat et corrections

Les tentatives exécutables traversent les véritables handlers Nest/Better Auth, PostgreSQL, WebSockets et, pour les scénarios navigateur, HTTPS Caddy et IndexedDB. Les attaques récupération/reset, promotion d'une session restreinte, contournement de politique et falsification des en-têtes IP échouent dans les scénarios décrits par la [matrice complète](session-4-4f-matrice.md). Cela ne constitue pas une preuve générale d'absence de vulnérabilité.

Deux défauts ont été reproduits puis corrigés :

1. **Cache réautorisé par une réponse retardée après retrait d'appartenance.** La version de la politique workspace reste identique lors d'un retrait de membre. Une ancienne réponse « autorisé » pouvait donc annuler le tombstone local. Le ticket capture maintenant les époques locales avant la requête HTTP. Une réponse antérieure au retrait ne peut plus annuler l'interdiction ; une nouvelle requête après réadhésion peut autoriser une nouvelle copie. Test IndexedDB en échec avant correction, passant après ; contre-épreuve avec vraie révocation SQL, décision HTTP et IndexedDB dans Edge.
2. **Contenu invalide divulgué par une erreur collaborative.** Un champ `tags` contenant du JSON invalide faisait remonter un extrait de sa valeur dans le message `JSON.parse`, puis dans les journaux Hocuspocus et la raison de fermeture. Le worker ne renvoie plus de messages d'erreur bruts. Les frontières Hocuspocus/ingress ne transmettent que des codes constants autorisés, sans cause privée ; les autres erreurs deviennent génériques. L'attaque envoie effectivement ce champ par WebSocket, puis un token de connexion malformé. La fuite a été constatée avant correction ; logs, erreurs et raisons de refus sont contrôlés après correction. Les codes opérationnels utiles, comme le refus de capacité, restent distincts.

Les journaux avant/après sont archivés sous `evidence/session-4f-cache-regression-*.txt` et `evidence/session-4f-collab-leak-*.txt`. Les échecs attendus avant correction sont conservés avec `EXIT_CODE=1`, sans imprimer les valeurs secrètes utilisées par le test.

Le JSON de présence est également contrôlé dès l'entrée, après sa borne de 1 Kio, avant le parseur natif de Hocuspocus. A08 vérifie qu'une trame malformée reçoit le code constant `PRESENCE_INVALID_JSON` et ne divulgue pas son contenu. Ce contrôle supplémentaire ne change pas le parcours des updates de document.

## À lire en priorité

1. [Matrice et décisions R01–R15](session-4-4f-matrice.md) : scénario, test concret, absence de test et recommandation séparés. [Inventaire des 27 routes](session-4-4f-routes.md) : quota et frontière d'autorisation de chaque route.
2. [Attaques serveur A01–A08](../../apps/api/src/adversarial.e2e.ts) et [attaques navigateur B01–B03](../../scripts/test-auth-adversarial-browser.mjs) : ce que les preuves tentent réellement. La matrice ne repose pas seulement sur une lecture du code.
3. [Cache et tickets](../../apps/web/src/lib/yjs-cache.ts), [régression IndexedDB](../../apps/web/src/lib/yjs-cache.test.ts), [messages publics](../../apps/collab/src/service/public-error.ts), [worker](../../apps/collab/src/service/incremental-worker.ts) et [frontière Hocuspocus](../../apps/collab/src/service/server.ts) : les corrections applicatives de 4f.
4. [Comparaison alternée](../../scripts/compare-collab.mjs), [résumé chiffré](evidence/session-4f-performance/summary.json) et [journal intégral](evidence/session-4f-performance/complete.txt) : la raison de l’arrêt initial de performance, avant la nouvelle campagne liée ci-dessus.
5. [Guide manuel consolidé](session-4-guide-manuel.md), environ trente minutes avec Android, Windows Hello et YubiKey. Les validations matérielles de 4a–4e sont celles rapportées par le développeur ; cette campagne automatisée ne les remplace pas.

## Contrôles et journaux complets

Chaque journal référencé contient la commande, la sortie complète et le code final. Les suites Node comptent leur test parent dans le total ; huit scénarios A correspondent ainsi à neuf tests Node. Les six tests SQL ignorés par Vitest sont exécutés séparément.

| Contrôle                                                   | Résultat                                         | Journal                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check` : lint, types, bootstrap et Vitest            | 114 réussis, 6 SQL ignorés dans cette commande   | [check](evidence/session-4f-check.txt)                                                                                                                                                                                         |
| `pnpm test:db`                                             | 6 réussis sur PostgreSQL                         | [SQL](evidence/session-4f-db.txt)                                                                                                                                                                                              |
| `pnpm build`                                               | Web, API, collab et worker compilés              | [build](evidence/session-4f-build.txt)                                                                                                                                                                                         |
| `pnpm test:auth:adversarial`                               | A01–A08, 9 tests réussis                         | [attaques](evidence/session-4f-adversarial.txt)                                                                                                                                                                                |
| Facteurs, workspace, récupération, quotas, cache           | Respectivement 14, 13, 13, 12 et 7 tests réussis | [facteurs](evidence/session-4f-strong.txt), [workspace](evidence/session-4f-workspace.txt), [récupération](evidence/session-4f-recovery.txt), [quotas](evidence/session-4f-limits.txt), [cache](evidence/session-4f-cache.txt) |
| Authentification initiale et pages                         | 6 et 8 tests réussis                             | [auth](evidence/session-4f-auth.txt), [pages](evidence/session-4f-pages.txt)                                                                                                                                                   |
| Transport, admission, présence, révocations collaboratives | 13, 1, 1 et 1 tests réussis                      | [transport](evidence/session-4f-transport.txt), [admission](evidence/session-4f-admission.txt), [présence](evidence/session-4f-presence.txt), [révocations](evidence/session-4f-revocations.txt)                               |

Les cinq parcours navigateur réussissent, un test Node chacun : [facteurs](evidence/session-4f-strong-browser.txt), [récupération](evidence/session-4f-recovery-browser.txt), [délais](evidence/session-4f-limits-browser.txt), [cache](evidence/session-4f-cache-browser.txt) et [attaques](evidence/session-4f-adversarial-browser.txt). Ils couvrent les interfaces réelles, la boîte Mailpit, l'authentificateur WebAuthn virtuel UV, trois onglets dont un figé hors ligne, les décisions de cache et les en-têtes forgés à travers Caddy. Le dernier renforcement du parsing de présence est contrôlé séparément dans A08 et la suite présence ; les parcours de cache et de récupération ne sont pas des benchmarks.

Les scénarios serveur isolent leurs schémas PostgreSQL. La vérification d'email, certains délais et certaines pannes sont préparés en SQL ; les mots de passe, preuves cryptographiques, contrôles d'accès, transactions et sockets ne sont pas remplacés par des mocks. Pour rendre une course reproductible, B01/B02 chargent le module de cache de production dans Edge et contrôlent l'ordre de décisions réellement obtenues par HTTP ; la navigation complète est testée séparément par le parcours cache 4e.

## Fuites et routes

A08 recherche des canaris dans les journaux capturés de l'API et du serveur collaboratif, les audits, réponses d'erreur, compteurs et tâches email chiffrées. Il provoque aussi une erreur SQL, une erreur SMTP et des entrées JSON/Yjs invalides. Le [résultat détaillé](evidence/session-4f-leaks.json) donne le nombre de canaux/messages inspectés. L'adresse email ne figure pas en clair dans les compteurs d'authentification. Les adresses présentes dans la table des comptes et la boîte de réception sont des données fonctionnelles, pas des métriques.

Seules exceptions fonctionnelles validées par le développeur : lien à usage unique dans l'email de récupération, secret/URI/QR pendant l'enrôlement authentifié, codes de secours affichés une fois. Aucun de ces éléments n'est autorisé dans les journaux, audits, erreurs ou métriques. Aucune preuve exhaustive de flux d'information, ni inspection de logs ajoutés par un exploitant, n'est revendiquée. Le motif opérateur reste une saisie humaine à maintenir sans donnée personnelle.

Les 27 routes exposées sont inventoriées et testées à leur plafond. La façade Better Auth porte explicitement `@Public()` : le guard global s'exécute mais délègue à ses handlers natifs et hooks d'assurance. Une nouvelle route métier sans exception reste refusée à 401. L'inventaire et ses contrôles ne doivent donc pas être résumés comme « toutes les routes exigent une session forte » : la connexion et la récupération doivent recevoir des utilisateurs anonymes.

## Performance : échec de la marge relative

Mesure du 25 octobre 2026, Windows, Ryzen 7 5800H, Node 24.21.0. Main figé à `0b8c0f03ca44c9e0b3e233b91ba27fcf4db10e41`, candidate 4e à `a725b91adb57ad9ad352aa0f2e2f8d2d9d1f79a5`. Trois paires alternées AB/BA/AB pour chaque type de mesure, aucun échantillon supprimé. `BatteryStatus=2` et RAM libre entre 4,84 et 4,99 Gio avant chacune des douze séries. Les deux profils encodés et les empreintes des bundles sont conservés dans le [manifest](evidence/session-4f-performance/manifest.json).

| p95 en ms               | Main : trois valeurs → médiane        | Candidate : trois valeurs → médiane   | Variation           |
| ----------------------- | ------------------------------------- | ------------------------------------- | ------------------- |
| Update contenu 1 Mio    | 8,31 / 7,86 / 7,72 → **7,86**         | 11,72 / 11,50 / 11,65 → **11,65**     | **+48,24 %**, échec |
| Update historique 1 Mio | 32,85 / 32,69 / 32,23 → **32,69**     | 37,19 / 35,83 / 36,65 → **36,65**     | **+12,12 %**, échec |
| Froid contenu 1 Mio     | 146,88 / 146,76 / 145,97 → **146,76** | 146,35 / 149,88 / 145,94 → **146,35** | −0,28 %             |
| Froid historique 1 Mio  | 242,89 / 239,60 / 242,10 → **242,10** | 263,83 / 235,73 / 227,74 → **235,73** | −2,63 %             |

Les plafonds absolus passent (contenu <50 ms, historique surveillé <100 ms, froid <500 ms), mais ils n'annulent pas la règle de +10 %. Le banc retourne donc **EXIT_CODE=1**. Les écritures avec politique obligatoire et assurance vivante sont préparées par fixture SQL côté candidate ; le coût de la cérémonie cryptographique n'est pas inclus dans l'update. Chaque commit emploie ses propres packages et migrations, avec les mêmes profils et versions des dépendances communes.

Les correctifs d'erreur/cache de 4f sont postérieurs à cette mesure, exécutée sur la dernière version 4e poussée. Leur performance n'est pas déclarée validée. Le protocole exact utilisé est archivé en texte avec son empreinte ; le script courant a ensuite été formaté sans changement de protocole.

**Compromis à décider avant la suite :** recommandation de diagnostiquer puis optimiser le contrôle SQL par écriture, en conservant tous les contrôles de session/politique, et de relancer la comparaison sur la candidate finale. L'autre option est une dérogation explicite et chiffrée du développeur : environ +3,79 ms contenu et +3,96 ms historique sur ce portable, sans garantie de charge studio. Aucune optimisation ni dérogation n'a été engagée après le dépassement. Le test dédié 4 vCPU / 8 Gio avec cinquante comptes reste obligatoire avant utilisateurs réels.

## Ce qui pourrait casser / décisions restantes

Un ticket de cache plus strict peut refuser une réponse ancienne et demander une nouvelle ouverture ; c'est préférable à restaurer une copie interdite. Les erreurs collaboratives génériques donnent moins de détail diagnostique : les codes opérationnels, incidents et tests restent disponibles, sans réintroduire le contenu privé dans les logs. Toute nouvelle route, tout nouveau bloc et toute mise à jour Better Auth/Hocuspocus exigent de relancer les attaques correspondantes.

À la livraison initiale, toutes les décisions étaient en attente. Le [tableau R01–R15](session-4-4f-matrice.md#tableau-final-des-risques-résiduels--décisions-du-25-octobre-2026) contient désormais les décisions du développeur du 25 octobre 2026 et les recommandations/lacunes : réservations épuisables, navigateur hors ligne, saturation globale, opérateur humain, email au moins une fois, timing distribué, exports, tombstones, crashs non exhaustifs, confiance dans l'hôte, capacité studio, futurs endpoints, rétention et replay complet du cache après grâce. Un test passant ne transforme aucune de ces limites en acceptation.

Pour tester manuellement, suivre le [parcours consolidé](session-4-guide-manuel.md). Pour relancer les attaques nouvelles : `pnpm test:auth:adversarial`, puis, pile démarrée, `pnpm test:auth:adversarial:browser`. La suite autorisée, son diagnostic et la nouvelle campagne sont décrits dans la [fiche SQL](session-4-4f-sql-performance.md). La commande de l’ancienne mesure reste archivée dans `evidence/session-4f-performance/complete.txt`.

# Session 7d — preuve limitée d'isolation de la publication Yjs

30 octobre 2026. Branche `codex/session-7-files`, référence de départ `d389b68e86a71d0e44a9342b8444b2e592baba26`. Preuve expressément autorisée après l'arrêt à **55,624 ms** sur une page typique ; **aucun plafond modifié**. Le prototype reste dans `proof/7d-isolation`, à relire avant toute intégration. Il n'est pas activé par le build normal ni par Compose.

**Résultat : les plafonds absolus passent dans les douze séries mixtes, les six séries froides et les six séries de capacité.** Cela ne vaut pas validation de non-régression : la comparaison alternée avec main reste requise, et un surcoût sur la page historique apparaît dans la comparaison descriptive avec la campagne précédente. Aucune intégration ni dérogation décidée ici.

## Ce qui est déplacé

Un worker partagé héberge Hocuspocus et les documents Yjs vivants : chargement, application des mises à jour déjà committées, réapplication native, snapshots et présence. Il remplace les documents de la boucle commune, sans y laisser une seconde copie. Le contrôleur conserve les vrais sockets, l'admission dès réception des octets, Better Auth, les contrôles de session/politique/droits, le leadership/LISTEN, les files de salle, le Store PostgreSQL, la projection et le pool partagé de validation.

Les hooks rejoignent le contrôleur par un MessagePort privé. L'ordre reste validation → commit PostgreSQL → publication → traitement natif → reçu sur le vrai socket. L'identité originale du tampon d'admission est retrouvée par un identifiant de trame ; les compteurs sont libérés après traitement ou fermeture. Aucun changement de SQL, de contrôle, de quota ni de dépendance Hocuspocus. Le build de preuve adapte explicitement les sources Room/server et échoue si une frontière attendue disparaît ou se répète ; les sources générées sont conservées avec leurs empreintes.

## Reprise et mémoire

La perte réelle du worker ferme les sockets avec `ROOM_RELOAD_REQUIRED`. Le contrôleur invalide ses salles, attend les écritures pendantes puis recrée le worker. À la reconnexion, les salles sont rechargées depuis PostgreSQL, avec les droits et références de fichiers revérifiés. Les anciens documents et appels IPC sont liés à leur génération, sans réemploi après le redémarrage.

Le budget demeure **1 Gio**. Une réserve fixe supplémentaire de **32 Mio** couvre le worker de publication ; les classes de documents et les quatre workers de validation sont inchangés. Trente pages typiques réservent **1 008 Mio**, réserve fixe comprise. La limite V8 du worker de publication est de 384 Mio de vieille génération et 16 Mio de jeune génération ; elle ne constitue pas un plafond RSS.

Le pont borne les appels pendants à 4 096 et attend au plus 30 secondes ; cette borne ne remplace aucun délai de contrôle d'accès. Les flux entrants gardent l'admission d'origine. Le pic mémoire d'une saturation simultanée de toutes les files IPC n'est pas prouvé : la capacité mesurée ci-dessous porte sur trente pages ouvertes et écrites. Le worker partagé peut aussi différer la diffusion des autres salles ; le reçu auteur et l'application chez l'autre rédacteur sont donc mesurés en plus du temps validation/SQL.

## Mesures non instrumentées

Même fixture que la campagne précédente : dix rédacteurs dans des processus séparés, cinq pages dont une de 1 Mio et quatre typiques ; les mêmes assertions par page, sans moyenne entre salles pour masquer un dépassement. Les valeurs ci-dessous sont les p95 par série, puis leur médiane. Le temps serveur couvre validation/transaction ; le reçu WSS et l'application chez l'autre client incluent la publication. Les horloges de départ/arrivée n'ont pas été déplacées.

| Page de 1 Mio / conversions | Trois p95 serveur (ms)   | Médiane | Trois p95 reçu auteur (ms)  | Médiane WSS |
| --------------------------- | ------------------------ | ------- | --------------------------- | ----------- |
| Contenu / non               | 14,550 / 14,411 / 15,733 | 14,550  | 36,286 / 35,815 / 38,502    | 36,286      |
| Contenu / oui               | 18,940 / 17,747 / 20,219 | 18,940  | 45,541 / 43,101 / 47,744    | 45,541      |
| Historique / non            | 64,509 / 63,411 / 61,289 | 63,411  | 299,734 / 295,056 / 296,605 | 296,605     |
| Historique / oui            | 86,288 / 72,868 / 76,802 | 76,802  | 426,856 / 388,747 / 402,800 | 402,800     |

Le plafond de 200 ms ne s'applique pas à la grosse page historique, conformément à la décision de 3d ; elle reste sous 100 ms serveur dans chaque série. Son coût reste visible chez l'autre rédacteur : avec conversions, **452,119 / 422,173 / 432,572 ms**, médiane **432,572 ms**. Le rebasage pré-pilote demeure nécessaire.

| Plus grand p95 des quatre pages typiques | Trois valeurs serveur (ms) | Médiane | Trois valeurs reçu auteur (ms) | Médiane WSS |
| ---------------------------------------- | -------------------------- | ------- | ------------------------------ | ----------- |
| Contenu / non                            | 14,861 / 15,329 / 16,215   | 15,329  | 40,614 / 40,353 / 43,623       | 40,614      |
| Contenu / oui                            | 18,502 / 17,431 / 19,833   | 18,502  | 47,729 / 46,877 / 52,676       | 47,729      |
| Historique / non                         | 20,119 / 21,973 / 23,651   | 21,973  | 85,178 / 80,278 / 87,243       | 85,178      |
| Historique / oui                         | 23,360 / 23,817 / 24,343   | 23,817  | 104,722 / 103,019 / 102,554    | 103,019     |

Toutes les pages typiques restent sous **50 ms serveur et 200 ms reçu**, y compris pendant l'historique et les conversions. Leur plus grand p95 d'application chez l'autre rédacteur est **116,570 ms**. Les **12 000 contributions** convergent, sans fermeture ni échec des clients. Les **24 conversions** passent : décodage/réencodage maximal **17,173 s**, pic cgroup **119,238 Mio**, sous 30 s/512 Mio.

### Froid et capacité

| Chargement froid de 1 Mio | Trois p95 (ms)              | Médiane | Plafond |
| ------------------------- | --------------------------- | ------- | ------- |
| Contenu                   | 162,863 / 162,940 / 161,404 | 162,863 | <500 ms |
| Historique                | 335,522 / 352,141 / 340,752 | 340,752 | <500 ms |

Trente pages typiques sont ouvertes, écrites et projetées dans chaque série, avec trente sockets authentifiées (deux comptes, quinze salles chacun). Elles mesurent environ 173 Kio contenu / 172 Kio historique encodés, sous la borne typique de 200 Kio. Les quatre workers hébergent 8/8/7/7 répliques. Réservation totale constante **1 008 Mio ≤1 Gio**, dont 288 Mio fixes avec le nouveau worker.

| Trente pages       | Trois pics RSS mesurés à 25 ms (Mio) | Médiane |
| ------------------ | ------------------------------------ | ------- |
| Contenu typique    | 601,871 / 598,133 / 600,238          | 600,238 |
| Historique typique | 768,371 / 780,313 / 768,414          | 768,414 |

Le maximum RSS de durée de vie du processus vaut **780,520 Mio**. Ces RSS incluent les clients/fixture/auth dans le même processus et tous ses workers ; ils ne représentent pas la pile entière. Le heap+external du worker de publication vide est **16,186 à 17,166 Mio**, ce qui soutient la réserve fixe de 32 Mio dans cette preuve. Chargé : environ **65 Mio** contenu, **107 à 114 Mio** historique, inclus dans les réservations de documents. Aucun GC explicite dans ce worker : ces lectures ne sont pas une preuve de mémoire strictement retenue après GC.

Portable Ryzen 7 5800H, 16 processeurs logiques, Windows 11, Node 24.21.0. Les **24 séries finales** respectent secteur/mémoire : minimum après préparation **2,362 Gio Windows / 5,485 Gio WSL**, **638 intervalles vmstat sans swap** ; les relevés avant préparation ≥3 Gio sont conservés. Pas de compilation ou autre suite en parallèle. Aucun résultat extrapolé à l'hôte dédié 4 vCPU/8 Gio.

### Compromis avant intégration

La campagne précédente sans isolation échouait à 55,624 ms sur une page typique. Cette preuve passe, mais les campagnes ne sont **pas alternées** : on ne peut attribuer toute différence au code ni déclarer la marge `max(10 %, 2 ms)` respectée. Sur la page historique sans conversion, les médianes descriptives passent de **52,759 à 63,411 ms serveur** (+10,652 ms, environ +20,2 %) et de **265,332 à 296,605 ms reçu**. Avec conversions : **72,997 à 76,802 ms serveur**, **368,246 à 402,800 ms reçu**. Ce surcoût apparent doit être arbitré à partir d'une comparaison alternée, pas écarté parce que les petites pages passent.

**Recommandation : conserver l'isolation comme direction, puis vérifier son surcoût par comparaison alternée avant de décider son intégration.** Aucun seuil relevé, aucune non-régression déclarée acquise. Une intégration devra ensuite passer la campagne finale avec main sur sa version durcie.

## Incident fonctionnel Windows conservé

Le premier essai mixte passe une série contenu sans conversion, puis s'arrête pendant l'échauffement avec conversion : `EPERM` lors du remplacement atomique de `owner.json`. Aucun p95 de conversion issu de cet essai n'est qualifié. Le processus ayant ouvert le fichier au moment précis de l'incident n'a pas été identifié.

La classe de panne a été reproduite séparément avec un vrai lecteur Windows refusant le partage de suppression : le renommage échoue, le fichier précédent reste intact, puis le même renommage réussit après fermeture du lecteur. Correction limitée dans `packages/storage/src/exchange.ts` : sur Windows seulement, réessayer le renommage atomique sur `EPERM`, `EACCES` ou `EBUSY`, au plus six tentatives, temporisations de 5 à 80 ms et échéance de 250 ms. Aucun effacement de la destination, aucune nouvelle écriture du temporaire, aucune prolongation d'expiration ; un lecteur persistant entraîne toujours l'échec fermé.

Les tests permanents couvrent le lecteur temporaire et le lecteur persistant. Les cinq tests du canal d'échange et les six contrôles du convertisseur Docker réel passent. La campagne mixte est ensuite reprise depuis sa première série, sans changement de fixture, d'horloge ni de plafond. Cette correction fonctionnelle Windows est distincte du prototype d'isolation ; elle n'affecte pas les bancs froid/capacité déjà mesurés.

## Portée des tests

| Preuve                                           | Ce qu'elle couvre                                                                                                                                                                                  | Limite                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Transport : 13 résultats Node, parent compris    | Douze scénarios permanents du service réel avec le bundle de preuve ; mêmes assertions                                                                                                             | Pas le front final                                                                                                                 |
| Références fichiers : 3 résultats                | Vrai WSS/Caddy et HMAC ; références interdites refusées                                                                                                                                            | Pas de gros transferts                                                                                                             |
| Mort du worker : 1 résultat, trois interruptions | Une page, deux providers : édition hors ligne, reconnexion automatique, commit avant publication conservé sans duplication, compte révoqué refusé, autre rédacteur fonctionnel, compteurs nettoyés | Observations fonctionnelles, pas des p95 ; pas encore trente salles en reprise simultanée ; ne reproduit pas `CONTROL_UNAVAILABLE` |
| Chargement à froid                               | Trois séries par profil 1 Mio, 30 chargements après deux échauffements                                                                                                                             | Salle froide et réplique neuve dans un pool réutilisable ; pas démarrage complet du processus, réseau ni saisie concurrente        |
| Capacité                                         | Trois séries par profil typique, 30 vrais providers avec deux comptes, pages écrites et projetées                                                                                                  | RSS inclut clients/fixture/auth dans le même processus ; pas une qualification de toute la pile à 50 personnes                     |
| Charge mixte                                     | Dix clients séparés, cinq pages, une de 1 Mio et quatre typiques ; trois séries avec/sans deux textures 8K                                                                                         | Pas encore les transferts 1/5 Gio, la charge NAT ni la saturation CPU volontaire avec le vrai front                                |

## Relecture et reproduction

Lire d'abord [répartition et commandes](../../proof/7d-isolation/README.md), puis [adaptations du build](../../proof/7d-isolation/build.mjs), [pont vers le worker](../../proof/7d-isolation/remote-hocus.mjs), [worker](../../proof/7d-isolation/publication-worker.mjs) et [test de reprise](../../proof/7d-isolation/recovery.mjs). Le changement applicatif Windows se limite au [renommage atomique](../../packages/storage/src/exchange.ts) et à son [test](../../packages/storage/src/exchange.test.ts).

1. Exécuter séparément `node proof/7d-isolation/run.mjs transport`, puis `files-wire`, puis `recovery`. Le dernier test tue réellement son worker à trois reprises ; attendre son résumé final. Ne pas interpréter la fermeture de cette fixture comme une panne du développement.
2. Pour reproduire les mesures : portable sur secteur, aucune autre compilation ou suite ; lancer successivement `cold`, `capacity`, puis `files-mixed`. Les garde-fous Windows/WSL/vmstat refusent une série non conforme. Les rapports vont dans `.local/isolation`.
3. Exécuter `node proof/7d-isolation/summarize.mjs` pour retrouver les trois valeurs et médianes. Une série échouée reste visible ; ne pas sélectionner uniquement les séries conformes.
4. L'interface habituelle utilise toujours le service normal. Le guide à deux navigateurs de 7d sera rejoué après une éventuelle intégration ; il ne constitue pas une preuve de ce prototype.

Ce qui pourrait casser à l'intégration : annulation tardive d'un hook, saturation du pont IPC, répétition des pannes du worker, admission mémoire aux différentes classes et ordre de diffusion. La reprise du worker ici ne rétablit pas le service global après `CONTROL_UNAVAILABLE`. Saturation volontaire avec vrai front, gros transferts, charge NAT et comparaison alternée avec main restent obligatoires. Aucun risque accepté ; aucune qualification de production annoncée.

Si l'intégration est retenue après relecture, remplacer les adaptations de build par des interfaces typées, comptabiliser explicitement les octets IPC en attente, puis éprouver les files pleines et la reprise simultanée de plusieurs salles. Les trente pages de la preuve de capacité n'ont pas subi ensemble la panne du worker. Le seul worker de publication est un domaine de panne commun ; les données durables restent dans PostgreSQL, mais les reconnexions peuvent se concentrer. La comparaison alternée finale devra porter sur le code intégré et durci, pas sur ce prototype.

## Contrôles et preuves conservées

`pnpm check` complet passe : hooks du clone vérifiés, lint, types, bootstrap Nest, **188 tests réussis et 6 tests SQL ignorés**, 40 fichiers réussis. Les suites du prototype ci-dessus utilisent PostgreSQL réel séparément. Le contrôle d'isolation Docker réel passe également (1 résultat). Aucun hook contourné, aucune migration ni nouvelle route applicative. Le résumé Vitest final figure dans le journal complet.

Les [empreintes et sources](evidence/session-7-7d-isolation/manifest.json), le [résumé calculé](evidence/session-7-7d-isolation/summary.json), le [journal complet des mesures mixtes](evidence/session-7-7d-isolation/session-7-7d-isolation-mixed.txt.gz) et le [contrôle complet](evidence/session-7-7d-isolation/session-7-7d-isolation-check.txt.gz) sont versionnés. Rapports bruts, relevés avant/après préparation, vmstat, source des adaptations du build, reprise, journaux fonctionnels et essais échoués sont conservés sans perte. Les deux premiers problèmes de montage du bundle de preuve (résolution d'une dépendance puis chemin des migrations) ont été corrigés avant les tests réussis ; leurs journaux sont également gardés. Ce sont des erreurs de préparation, pas des séries de performance rejetées.

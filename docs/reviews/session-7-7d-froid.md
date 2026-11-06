# Session 7d — profilage puis réduction du transfert au chargement

6 novembre 2026. Suite autorisée du [dépassement de non-régression](session-7-7d-comparaison.md), référence de diagnostic `29eb2dd` (application `b31dd28`). Profilage présenté au développeur avant modification applicative ; aucun contrôle ni délai relevé. **La correction attend encore la comparaison alternée non instrumentée avant qualification.**

## Diagnostic mesuré avant correction

Trois processus successifs, deux profils de 1 Mio, trente chargements après deux échauffements par profil. Le banc Hocuspocus/PostgreSQL existant est instrumenté par un module réservé au profilage : durées des appels réels, valeur `elapsed` déjà retournée par le worker, aucune réponse ou condition de succès remplacée. Même protocole secteur/mémoire/swap, aucun build ni test pendant les séries. Le profilage sert à attribuer le coût ; ses p95 ne remplacent pas ceux de la comparaison finale.

Secteur reconnu dans les trois séries, **51 intervalles vmstat sans swap**, relevés valides. Minima : Windows **5,51 Gio avant préparation**, **5,50 Gio après** ; WSL **5,63 Gio après préparation**. Les trois relevés et leurs échantillons bruts sont versionnés.

| Étape, profil contenu                                 | Moyenne série 1 / 2 / 3 (ms) | p95 série 1 / 2 / 3 (ms)    |
| ----------------------------------------------------- | ---------------------------- | --------------------------- |
| Lecture PostgreSQL du document et du journal          | 19,149 / 19,611 / 18,839     | 21,156 / 23,179 / 20,718    |
| Initialisation de réplique, vue depuis l'appelant     | 25,896 / 26,579 / 26,210     | 127,288 / 123,405 / 120,464 |
| Inspection : aller-retour complet avec tous les blocs | **3,358 / 3,953 / 3,332**    | **4,672 / 6,744 / 4,568**   |
| Inspection : travail chronométré dans le worker       | **0,006 / 0,007 / 0,006**    | 0,025 / 0,024 / 0,023       |
| Vérification transactionnelle du registre             | 6,634 / 7,277 / 6,965        | 7,381 / 10,517 / 13,954     |
| Dont lecture/comparaison du registre sous transaction | 1,332 / 1,465 / 1,384        | 1,571 / 2,473 / 1,999       |

L'initialisation inclut l'attente du worker et chevauche l'application Yjs du document principal ; elle ne doit pas s'ajouter à une seconde durée d'application du même document. La comparaison du registre est déjà incluse dans sa transaction. Les p95 de différentes étapes ne sont pas additifs. Total `Room.load` contenu : **158,972 / 152,861 / 156,495 ms** au p95 ; historique : **242,967 / 241,774 / 251,185 ms**. Tous les plafonds absolus du banc passent.

Le coût établi et évitable est l'aller-retour d'inspection : `inspect()` retourne simplement les blocs déjà validés, mais les sérialise et transfère tous au processus principal, qui n'en garde que les références de fichiers. L'écart avec le temps interne du worker englobe sérialisation, transport IPC et ordonnancement ; cette mesure ne les sépare pas. Le registre SQL reste un coût nécessaire, inchangé par la correction. Ce diagnostic ne prétend pas expliquer à lui seul toute la différence de 15,859 ms entre main et session 7.

## Correction ciblée et invariants

Les deux chemins d'initialisation du worker (`init`, et `init-finish` après journal découpé) retournent maintenant la taille encodée et les couples **identifiant de bloc / identifiant de fichier** extraits du contenu entièrement validé. `Room.load` utilise ces couples et ne demande plus un second transfert du contenu complet. L'extraction applique exactement les mêmes types de blocs et conditions que précédemment, y compris les blocs imbriqués et les fichiers sans référence, ignorés.

La reconstruction Yjs, le codec, les modèles Zod, les bornes et l'application de tout le journal restent exécutés. Le contrôle SQL de génération/révision, le fencing et les verrous du registre restent identiques : aucun raccourci « document sans fichiers », aucune confiance nouvelle dans une projection, aucun cache d'autorisation. L'API d'inspection complète reste disponible aux autres usages. Le prototype d'isolation reste hors production.

## Preuves fonctionnelles et points de relecture

Le test de pool vérifie avec le vrai worker une image imbriquée, un fichier, un emplacement vide et une référence changée dans la fin du journal. Les chemins direct et découpé (>17 Mio d'updates redondantes, document final borné) doivent retourner les mêmes références finales. La réplique voisine reste inchangée ; un identifiant de fichier invalide est refusé par l'initialisation. Le test existant de perte de worker et de rechargement depuis PostgreSQL reste exécuté.

Le test PostgreSQL de fichiers ouvre un document valide, retire une entrée du registre, vérifie le refus d'ouverture, restaure exactement l'entrée de la fixture puis vérifie l'ouverture. Le refus d'un registre absent, les contrôles d'auteur, la révocation, le rollback et les barrières GC restent dans cette suite. Les tests WebSocket fichiers, transport et reprise sont relancés sur cette candidate. Les journaux complets et les profils sont conservés dans les [artefacts](evidence/session-7-7d-froid/manifest.json).

**42 résultats réussis, aucun échec ni test ignoré dans ces suites** : pool 3, fichiers PostgreSQL 17, fichiers WSS/HMAC 3, transport 13, reprise 6 (les compteurs Node incluent les tests parents). Ces preuves fonctionnelles ne valident pas encore la non-régression de performance.

`pnpm check` complet passe également : hooks installés, lint, types, bootstrap Nest et **189 tests réussis, six tests SQL ignorés** dans la suite générale. Les suites SQL/WebSocket dédiées ci-dessus ont été exécutées séparément, sans test ignoré. Journal complet conservé dans `check.log.gz`.

Lire d'abord `apps/collab/src/service/room.ts`, puis `incremental-worker.ts`, `incremental-replica.ts` et `incremental-validator.ts`. Vérifier particulièrement que **les deux chemins d'initialisation** fournissent l'état final et que `Store.verifyFileLedger` n'a pas changé. Tests prioritaires : `pool.e2e.ts` et `files.e2e.ts`. Instrumentation : `cold-profile.ts`, appelée seulement par `scripts/profile-collab-cold.mjs` ; ni l'entrée de production ni la suite fonctionnelle générale ne l'importent.

## Guide manuel

Dans deux navigateurs autorisés, ouvrir une page contenant une image, un fichier et un bloc fichier vide. Modifier une légende, fermer les deux onglets et attendre le déchargement de la page ; la rouvrir et vérifier contenu, aperçus, téléchargements et reprise de la collaboration. Refaire après retrait de l'accès de l'autre compte : ce compte ne doit plus ouvrir le document. Ne pas corrompre le registre de développement manuellement : le scénario de registre incomplet utilise une base de test isolée via `node scripts/test-collab.mjs --suite files`.

La qualification finale reste conditionnée à trois paires alternées avec main, plafonds absolus et marge `max(10 %, 2 ms)` inchangés. Un nouvel échec impose un nouvel arrêt ; aucune sélection de séries favorables.

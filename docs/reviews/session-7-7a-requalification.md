# Session 7a — clients séparés et requalification sans profiler

29 octobre 2026. Correction du banc autorisée après le [diagnostic historique](session-7-7a-historique.md). **Les 24 cas WSS et les douze séries de comparaison avec main passent. La marge max(10 %, 2 ms) et les plafonds absolus sont respectés.** Reprise après libération de mémoire confirmée, sans modifier les neuf séries déjà obtenues. Les autres preuves de clôture de 7a restent distinctes ; 7b non commencée. Aucun code applicatif, contrôle ou plafond modifié.

## À lire en priorité

- [Banc officiel](../../apps/collab/src/testing/files-load.e2e.ts), [clients séparés](../../apps/collab/src/testing/file-load-client.ts), [traces légères du contrôle](../../apps/collab/src/testing/file-load-controls.ts).
- [Mesures WSS brutes](evidence/session-7-7a-requalification/files/measurement.json), [trois p95 et médianes](evidence/session-7-7a-requalification/files/summary.json), [journal complet](evidence/session-7-7a-requalification/files/run.txt).
- [Comparaison complète et médianes](evidence/session-7-7a-requalification/comparison/summary.json), [manifestes des douze séries](evidence/session-7-7a-requalification/comparison/manifest.json), [journal et refus mémoire](evidence/session-7-7a-requalification/comparison/run.txt), [reprise complète](evidence/session-7-7a-requalification/comparison/resume.txt).
- [Contrôles complets](evidence/session-7-7a-requalification/check.txt), [preuves des verrous et courses RustFS](session-7-7a-contention.md), [routes et quotas](session-7-7a-transferts.md#matrice-routes-quotas-et-preuves).

## Ce qui a changé et ce qui est réellement mesuré

Commit du banc **`1e40bce`** : chaque compte utilise son processus Node, un vrai provider Hocuspocus et WSS via Caddy. Le serveur et les deux clients ont des PID distincts vérifiés ; les trois identifiants Yjs de fixture/auteurs sont fixes, distincts et absents du profil initial. Le contenu initial est identique entre séries, empreinte dans chaque résultat. Les quatre scénarios sont conservés : texte sans changement de référence, ou ajout/retrait de référence, un puis deux auteurs ; deux clients restent connectés, projection automatique active.

Le temps serveur va de la préparation du candidat au retour du commit SQL, par lot. Le client mesure dans son propre processus depuis son édition locale jusqu'au reçu durable correspondant ; l'aller-retour de commande IPC n'entre pas dans ce temps. Dix vagues de chauffe puis cent mesurées, pause de 100 ms **après** les confirmations (au plus dix vagues/seconde). Vérification de 100/200 reçus distincts par cas et du même nombre de contributions journalisées ; aucun retry de connexion ne masque une fermeture. Registre vide après les bascules paires ; compte et droits réels.

**Aucun profiler CPU, aucune requête SQL de diagnostic pendant les séries.** La sonde du contrôle note seulement les erreurs, fermetures et durées supérieures à 500 ms des requêtes déjà effectuées ; elle ne change ni leurs délais ni l'échec fermé. Les observations lentes ne sont pas des durées d'attente SQL pures. Les sondes système restent dans le parent, pour ne pas bloquer le serveur. Le lanceur de comparaison a également été corrigé (`0e4df17`) pour conserver une série échouée puis arrêter immédiatement avant la suivante.

Les objets de fichiers de ce banc sont des métadonnées `ready` préparées en SQL, sans transfert d'octets S3 pendant la saisie. C'est la qualification de la validation, du registre et de la collaboration ; les transferts réels RustFS sont éprouvés séparément par les tests HTTP et GC déjà publiés. Cela ne qualifie ni les gros uploads mixtes, ni les images 8K, ni cinquante rédacteurs.

## Trois séries WSS complètes

Durées en millisecondes ; chaque médiane porte sur trois p95. Plafonds serveur inchangés : contenu <50 ms, historique ≤100 ms. **Les 24 p95 individuels passent**, 3 600 écritures mesurées confirmées, aucune fermeture pendant la saisie.

| Profil 1 Mio | Écriture      | Auteurs | p95 serveur, séries 1 / 2 / 3 | Médiane serveur | Médiane p95 WSS |
| ------------ | ------------- | ------: | ----------------------------- | --------------: | --------------: |
| Contenu      | Texte         |       1 | 16,41 / 14,08 / 13,95         |       **14,08** |           22,41 |
| Contenu      | Texte         |       2 | 15,43 / 15,74 / 16,14         |       **15,74** |           35,07 |
| Contenu      | Ajout/retrait |       1 | 26,92 / 30,67 / 30,39         |       **30,39** |           37,83 |
| Contenu      | Ajout/retrait |       2 | 29,86 / 33,32 / 27,15         |       **29,86** |           56,03 |
| Historique   | Texte         |       1 | 62,79 / 74,47 / 51,44         |       **62,79** |          235,57 |
| Historique   | Texte         |       2 | 52,42 / 75,69 / 61,17         |       **61,17** |          300,25 |
| Historique   | Ajout/retrait |       1 | 38,70 / 49,81 / 54,65         |       **49,81** |          177,45 |
| Historique   | Ajout/retrait |       2 | 63,35 / 59,89 / 61,54         |       **61,54** |          276,61 |

Les trois valeurs WSS, SQL, verrou et registre sont aussi dans le résumé lié plus haut. Avec références et deux auteurs, les médianes SQL sont 26,80 ms (contenu) et 33,33 ms (historique), les prises de verrou 6,05 et 7,39 ms. Aucune addition de p95 pour attribuer un temps de bout en bout.

Hygiène : `BatteryStatus=2` partout ; Windows avant préparation **3,36–4,01 Gio**, après préparation **2,45–3,63 Gio** ; WSL MemAvailable **5,26–5,30 Gio**. **587 intervalles vmstat, si/so zéro, compteurs swap inchangés**. Préparations et traces complètes versionnées. Aucun autre build/test pendant les mesures. Les ralentissements du contrôle n'ont déclenché aucune fermeture dans ces séries ; les deux campagnes de profilage antérieures restent conservées et leur cause exacte n'est pas démontrée.

## Comparaison avec main : trois paires alternées complètes

Main figé **`56c52b4b5cb4c4df94841328398d141955b48394`**, candidate **`0e4df17`** (même application que le banc WSS et que `1eacc4a`). Lanceur commun `--session6`, qui impose dans **les deux versions** assurance forte, politique obligatoire et époque d'accès par page. Sources/packages/migrations propres à chaque commit, mêmes profils et dépendances, compilation terminée avant les mesures.

Le banc chaud mesure validation, transaction clôturée par le fence et commit de réplique, sans réseau, projection ni clients concurrents. Le froid mesure la salle Hocuspocus, la lecture PostgreSQL, le document Yjs et la réplique ; sans authentification réseau ni frappe simultanée. Ces mesures complètent WSS et ne s'y substituent pas.

| p95, ms           | Main S1 | Candidate S1 | Main S2 | Candidate S2 | Main S3 | Candidate S3 |
| ----------------- | ------: | -----------: | ------: | -----------: | ------: | -----------: |
| Update contenu    |   9,070 |        8,689 |  10,093 |        8,876 |  14,311 |       10,460 |
| Update historique |  39,878 |       35,706 |  36,425 |       38,482 |  44,562 |       36,758 |
| Froid contenu     | 146,016 |      157,043 | 145,846 |      157,857 | 148,521 |      161,816 |
| Froid historique  | 279,945 |      295,414 | 293,311 |      304,782 | 286,933 |      311,381 |

| Médianes de trois p95 |       Main |  Candidate |                Écart | Marge autorisée | Verdict           |
| --------------------- | ---------: | ---------: | -------------------: | --------------: | ----------------- |
| Update contenu        |  10,093 ms |   8,876 ms | −1,217 ms (−12,06 %) |       +2,000 ms | Conforme, <50 ms  |
| Update historique     |  39,878 ms |  36,758 ms |  −3,120 ms (−7,83 %) |       +3,988 ms | Conforme, ≤100 ms |
| Froid contenu         | 146,016 ms | 157,857 ms | +11,841 ms (+8,11 %) |      +14,602 ms | Conforme, <500 ms |
| Froid historique      | 286,933 ms | 304,782 ms | +17,849 ms (+6,22 %) |      +28,693 ms | Conforme, <500 ms |

Les douze processus terminent avec code 0, sans échec de série ni dépassement absolu. Le froid est un peu plus lent ; cet écart est publié, pas masqué par le gain sur les updates. La règle porte sur les médianes de trois p95, pas sur une sélection de la meilleure série. Cette mesure sur portable ne remplace pas la qualification dédiée.

**Interruption conservée :** après neuf processus, avant `candidate-warm-3`, le garde-fou a refusé **2,28 Gio Windows** (minimum 3 avant préparation), secteur reconnu, WSL 5,26 Gio. Relevé indicatif : WSL 1 852 Mio, Node 510 Mio, Edge 386 Mio, Docker Desktop + backend 497 Mio ; PostgreSQL 270 Mio déjà inclus dans WSL. Aucun processus terminé du banc ne restait actif. Le journal initial et le refus restent versionnés.

Après confirmation du développeur, reprise des trois seuls processus manquants à **13:10 UTC**, mêmes commits, Node, empreintes de profils/bundles et protocole vérifiés par `--resume`. Windows avant préparation : **4,60 / 4,65 / 4,54 Gio**. La pause coupe la troisième paire chaude : cette limite du protocole alterné est explicite ; aucun résultat antérieur n'est effacé ni rejoué pour améliorer la comparaison. Sur les douze séries : secteur reconnu partout, Windows avant préparation **3,06–4,65 Gio**, relevés de début/fin **2,38–4,65 Gio**, WSL **5,26–5,35 Gio** ; **228 intervalles vmstat sans swap**, compteurs inchangés. Les observations après préparation propres à chaque profil sont dans les rapports bruts. Aucun build/test en parallèle et aucun seuil abaissé.

## Relecture et reproduction

`pnpm check` relancé après la comparaison complète : **169 tests réussis, 6 ignorés ; 32 fichiers réussis**, [journal complet final](evidence/session-7-7a-requalification/check-comparison-complete.txt), hooks vérifiés, lint/formatage, typage et preuve Nest inclus. Ce sont les contrôles du dépôt, distincts des 24 cas réseau mesurés. La correction touche uniquement les bancs ; aucun nouveau droit, endpoint ou contournement de quota. Les preuves R12/GC citées en tête restent celles des commits applicatifs précédents, elles ne sont pas présentées comme relancées dans cette étape.

Le premier pre-push a ensuite été [refusé](evidence/session-7-7a-requalification/push-timeout.txt) : le test d'équivalence JSON du validateur dépasse son délai de 5 secondes (5 111 ms), sans assertion métier en défaut. La même suite inchangée, isolée, passe [20 tests en 2,51 secondes](evidence/session-7-7a-requalification/replica-recheck.txt), puis le [hook complet rejoué](evidence/session-7-7a-requalification/push-retry.txt) passe 169 tests et autorise le push. Aucun timeout, test, parallélisme ou hook n'est modifié ; cause précise du dépassement ponctuel non démontrée. Ce rejet n'est pas effacé ni présenté comme un premier passage réussi.

1. Lire les trois valeurs de chaque cas, les PID distincts et les comptes de contributions/reçus dans `files/measurement.json`. Comparer aux mesures instrumentées sans confondre leurs périmètres.
2. Pour reproduire WSS : PostgreSQL et Docker actifs, `.env` local, portable sur secteur, mémoire conforme ; `pnpm measure:files`, sans build/test parallèle. Attendre les six séries, les 24 cas et `EXIT_CODE=0`. Les schémas et Caddy de test sont jetables, sans reset utilisateur.
3. Pour la comparaison neuve : `node scripts/compare-collab.mjs --session6 --reference 56c52b4b5cb4c4df94841328398d141955b48394 --candidate 0e4df17`. Après libération de mémoire, la campagne interrompue peut reprendre avec les mêmes arguments et `--resume .local/3d-alternating/2026-10-29T12-44-15-308Z` : empreintes, protocole et séries précédentes sont vérifiés et conservés.
4. Sur tout dépassement ou nouvelle fermeture, arrêter et conserver le journal. Aucun allongement de délai, baisse de seuil ou reprise cachée autorisé.

Ce qui peut encore casser : une fermeture de contrôle non reproduite ici, le coût de projection sous une charge plus importante, et l'attente utilisateur du pire historique. **Le WSS historique reste autour de 300 ms** ; le plafond <200 ms de la charge mixte 7d reste inchangé. Rebasage et qualification dédiée restent obligatoires. La requalification de performance est terminée ; la clôture 7a attend les autres preuves listées dans la [fiche de contention](session-7-7a-contention.md#suite-proposée-et-limites) : réponses ambiguës/job tardif, capacité globale/rapprochement, navigateur/CORS et anciens fichiers sans registre. Aucun démarrage de 7b dans cette livraison.

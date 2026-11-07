# Session 7d — diagnostic alterné du chargement historique

**Suite autorisée le 7 novembre :** [affinement du protocole et nouvelle comparaison](session-7-7d-protocole-froid.md), sans changement applicatif. Les quatre mesures d'origine passent dans cette campagne ; la première ouverture du contenu avec pool vide dépasse la marge (+19,74 %). Nouvel arrêt, anciens résultats conservés.

7 novembre 2026, campagnes réalisées dans la nuit du 6 au 7 (horodatages UTC conservés). **Le profilage ne démontre pas de régression causée par le dernier correctif. Aucun nouveau changement applicatif n'est justifié par ces résultats. La qualification non instrumentée reste rouge et 7d reste ouverte.**

## Question et méthode

Le [résultat précédent](session-7-7d-froid.md) est conservé : froid historique **240,685 → 272,246 ms, +13,11 %**, soit 7,493 ms au-delà de la marge. Le développeur a autorisé le profilage alterné avant/après puis une correction de la cause établie. Nous comparons des sources applicatives immuables :

- Avant réduction du transfert IPC : `29eb2dd8e76524468770953298c36110ab5b0555`.
- Après réduction, candidate actuelle : `cbfd14acc931c50ebcb1a8c28d3982849a814f40` (également application de `8ebbdee`).
- Main, sans le service fichiers : `56c52b4b5cb4c4df94841328398d141955b48394`.

Trois campagnes distinctes, chacune de trois paires AB/BA/AB, **18 processus au total**. Deux profils proches de 1 Mio, mêmes octets, deux échauffements puis trente chargements par profil/processus. Les deux versions d'une campagne reçoivent la même instrumentation. Aucun build ou autre test pendant les mesures. Aucun seuil ni délai changé, aucune série supprimée ou rejouée pour améliorer le résultat.

Le banc mesure l'ouverture réelle d'une salle Hocuspocus et sa réplique depuis PostgreSQL, admission mémoire comprise. Il ne mesure pas une ouverture de navigateur, l'authentification réseau, une queue de journal non vide ou une saisie concurrente. Les durées instrumentées servent au diagnostic, **pas à remplacer la qualification non instrumentée**.

## Résultats complets

Chaque cellule donne les trois p95 puis leur médiane, en millisecondes.

| Campagne / profil                                 | Référence : trois p95 ; médiane           | Candidate : trois p95 ; médiane           | Écart des médianes  |
| ------------------------------------------------- | ----------------------------------------- | ----------------------------------------- | ------------------- |
| A, avant/après, contenu                           | 161,283 / 166,257 / 158,531 ; **161,283** | 163,877 / 161,665 / 157,802 ; **161,665** | +0,24 %             |
| A, avant/après, historique                        | 246,081 / 248,490 / 258,279 ; **248,490** | 246,962 / 259,574 / 257,643 ; **257,643** | +3,68 %             |
| B, main/candidate, contenu                        | 160,546 / 146,026 / 221,391 ; **160,546** | 160,762 / 163,440 / 156,278 ; **160,762** | +0,13 %             |
| B, main/candidate, historique                     | 243,056 / 243,029 / 334,858 ; **243,056** | 251,423 / 268,414 / 254,097 ; **254,097** | +4,54 %             |
| C, main/candidate, contenu, worker instrumenté    | 148,900 / 143,366 / 148,330 ; **148,330** | 166,344 / 164,340 / 160,273 ; **164,340** | **+10,79 %, rouge** |
| C, main/candidate, historique, worker instrumenté | 245,576 / 264,560 / 285,712 ; **264,560** | 250,953 / 259,345 / 289,894 ; **259,345** | −1,97 %             |

A et B terminent avec le code 0. C termine avec le code 1 : contenu +16,010 ms pour une marge de 14,833 ms, **1,177 ms de dépassement**. Aucun plafond absolu de 500 ms n'est dépassé. Le pic de **334,858 ms sur main** est conservé ; il montre la variabilité du banc sur ce portable, sans prouver la cause du précédent échec. Aucune nouvelle mesure après C.

## Attribution des coûts

La campagne C ajoute des chronomètres dans les copies de sources utilisées par le banc. Les appels Yjs, le codec et les modèles sont exécutés normalement ; aucune réponse, erreur ou condition de succès n'est remplacée. Voici les **moyennes par série** du profil historique, pas des p95 additionnables :

| Étape (ms)                                       | Main : 1 / 2 / 3            | Candidate : 1 / 2 / 3       |
| ------------------------------------------------ | --------------------------- | --------------------------- |
| Initialisation interne du worker                 | 177,975 / 179,573 / 172,630 | 174,605 / 183,603 / 177,662 |
| Application de l'historique Yjs                  | 169,641 / 171,094 / 165,190 | 166,920 / 175,809 / 169,345 |
| Parcours de comptage des structures              | 1,477 / 1,270 / 1,353       | 1,284 / 1,572 / 1,367       |
| Décodage et validation des modèles               | 6,450 / 6,786 / 5,636       | 5,958 / 5,779 / 6,477       |
| Pauses GC du worker chevauchant l'initialisation | 42,792 / 43,437 / 43,085    | 43,247 / 43,217 / 43,639    |

Les pauses GC sont **déjà comprises dans les durées**, et certains événements peuvent chevaucher une frontière. L'initialisation du worker chevauche aussi l'application du document Yjs principal : on ne somme pas leurs temps muraux. L'observateur mémoire du thread principal et celui du worker sont distincts ; le compteur CPU de processus inclut les workers.

Dans B, la vérification transactionnelle du registre de fichiers ajoute **7,186 / 7,090 / 7,419 ms en moyenne** côté candidate. Ce contrôle n'existe pas sur main ; il ne peut être retiré. Les moyennes d'initialisation du worker sont 183,4 / 179,2 / 190,7 ms sur main contre 181,2 / 187,0 / 175,6 ms sur la candidate : aucun ralentissement stable de cette étape n'est établi. La campagne A ne reproduit pas une dégradation de plus de 10 % après le correctif IPC.

**Conclusion limitée :** l'application de l'historique synthétique domine les deux versions ; le nouveau contrôle SQL a un coût réel et nécessaire, mais ces profils n'attribuent pas les 31,561 ms du précédent écart à une cause applicative corrigible. Les anciennes séries non instrumentées ne permettent pas de reconstituer leur GC ou leur ordonnancement. Affirmer que leur échec « était le GC » serait injustifié.

Autre limite du protocole existant : le pool comporte quatre workers et le banc n'a que deux échauffements. Les deux premiers chargements mesurés du contenu comprennent encore un démarrage de worker ; avec trente échantillons, ils pèsent fortement sur le p95. L'historique est mesuré ensuite avec le pool déjà démarré. Ce comportement est identique entre versions ; il n'a pas été modifié pour obtenir un résultat vert. Toute séparation future des mesures « démarrage du pool » et « chargement d'une réplique » devra être explicite et reconstituer une référence commune.

## Hygiène et preuves reproductibles

BatteryStatus=2 à chaque série ; **303 intervalles vmstat sans swap**, compteurs inchangés. Les valeurs minimales sont :

| Campagne | Windows avant préparation (Gio) | Windows après (Gio) | WSL MemAvailable après (Gio) | Intervalles sans swap |
| -------- | ------------------------------- | ------------------- | ---------------------------- | --------------------- |
| A        | 5,408                           | 5,034               | 5,609                        | 102                   |
| B        | 5,168                           | 4,726               | 5,591                        | 102                   |
| C        | 5,381                           | 4,893               | 5,589                        | 99                    |

Le [manifeste d'artefacts](evidence/session-7-7d-historique-froid/manifest.json) contient les journaux complets, résultats de toutes les séries, relevés bruts de mémoire/swap, échantillons et GC, sources instrumentées et empreintes SHA-256 compressées/décompressées. Les octets exacts de chaque protocole sont archivés : leur concaténation reproduit son `protocolHash`. L'avertissement de compilation sur `FileBoundary` absent de main est attendu : le wrapper de registre y est optionnel ; l'application main n'est pas modifiée.

Les scripts d'analyse sont également archivés. Pour les spans du worker, on joint les horodatages absolus aux 64 fenêtres de `Room.load` (deux profils, 2+30). Une initialisation supplémentaire de projection hors mesure ne fait pas partie de ces fenêtres. Les événements GC reçus au message `dispose` sont conservés et rattachés par thread/horodatage, plutôt que perdus en fin de mesure.

## Fiche de relecture et reproduction

Lire d'abord ce diagnostic, puis `scripts/compare-collab.mjs`, `apps/collab/src/testing/cold-profile.ts` et `cold-worker-profile.ts`. Ces deux derniers modules ne sont importés que par les entrées explicites du banc, jamais par la production ou Compose. Les nouvelles options ne changent pas la comparaison ordinaire. Les substitutions de sources instrumentées refusent les marqueurs incompatibles ; une mise à jour du worker impose de relire ces substitutions.

Pour reproduire A, après préparation des fixtures de 1 Mio existantes et sans autre charge :

```powershell
node --env-file=.env scripts/compare-collab.mjs --session6 --reference 29eb2dd --candidate cbfd14a --profile-cold
```

Pour B, remplacer la référence par `56c52b4`. Pour C, ajouter `--profile-worker`. Les garde-fous secteur/mémoire/swap restent actifs. Les journaux `summary.json`, `*-profile.json`, `manifest.json` et `*.instrumented.txt` de chaque campagne doivent être conservés, y compris les sorties rouges. Ne pas enchaîner une qualification ordinaire après un échec sans l'arbitrage prévu.

`pnpm check` complet réussi : hooks installés, lint/formatage, types, bootstrap Nest et **189 tests réussis, six tests SQL ignorés dans la suite générale**. Journal complet versionné. Un premier échec de lint dans le script local d'archivage (expression régulière) a été corrigé ; le suivant venait d'un refus d'accès d'esbuild dans le bac à sable, puis la même commande complète a réussi hors bac à sable. Les deux journaux rouges sont conservés. Les 42 tests ciblés du correctif applicatif précédent restent rattachés à leur [fiche datée](session-7-7d-froid.md) ; ils ne sont pas présentés comme relancés ici. Aucun code applicatif n'a changé.

## Décision attendue

La règle de non-régression n'est pas levée : le précédent résultat non instrumenté reste **bloquant**, tout comme le diagnostic C rouge qui interdit de prétendre à une stabilité démontrée. Aucun seuil ni risque accepté automatiquement. Nous ne poursuivons pas une optimisation sans cause établie.

Option proposée pour arbitrage : dérogation explicite et limitée au froid historique déjà mesuré sur ce portable (**272,246 ms, +13,11 %**), avec qualification sur hôte dédié et rebasage toujours obligatoires ; elle ne couvrirait pas une nouvelle régression du contenu. Autre option : préciser le protocole de froid (démarrage du pool séparé du chargement de réplique) puis refaire une référence commune, sans présumer qu'elle résoudra l'écart historique. Dans les deux cas, les plafonds absolus et tous les contrôles de sécurité restent inchangés. Le développeur décide ; **7d n'est pas clôturée**.

# Session 7d — requalification du protocole de chargement

7 novembre 2026. Suite autorisée du [diagnostic historique](session-7-7d-diagnostic-historique.md). États du pool définis avant mesure ; aucun changement applicatif. **Les quatre mesures d'origine passent, mais la première ouverture du contenu avec pool vide régresse de 19,74 %. Requalification arrêtée, aucune dérogation ni optimisation appliquée.** La correction du verdict après mesure est explicitée ci-dessous.

## Critères et mesures

La comparaison d'origine reste intégralement conservée : `warm.e2e.ts` et `cold.e2e.ts`, deux échauffements puis trente ouvertures par profil pour le froid, mêmes octets et contrôles. Les quatre critères bloquants restent update contenu <50 ms, update historique ≤100 ms, froid contenu et historique <500 ms ; non-régression des médianes de trois p95 limitée à **max(10 %, 2 ms)**. Les résultats rouges précédents restent dans leurs fiches. Aucun profiler, GC forcé ou retrait d'échantillon.

Une suite complémentaire, `cold-lifecycle.ts`, rend explicite l'état du pool : pour chacun des deux profils de 1 Mio, deux paires d'échauffement puis trente paires mesurées, avec un nouveau serveur de test par paire :

1. **Pool vide :** vérifier qu'aucun worker ni aucune salle ne réside, puis chronométrer admission mémoire et ouverture complète depuis PostgreSQL. Cette ouverture démarre réellement le premier worker à la demande.
2. Attendre le déchargement réel de la salle et la libération de sa réplique. Initialiser les autres workers par leur commande de métriques, sans charger de document, sans forcer le GC ; attendre leurs réponses. Cette préparation est hors chronomètre.
3. **Pool démarré :** vérifier tous les workers présents, aucune salle/réplique résidente, puis chronométrer une nouvelle ouverture complète de la même page. Vérifier les mêmes identifiants de workers après l'ouverture, puis le déchargement et fermer le serveur de test.

Les ouvertures supplémentaires sont des ouvertures complètes : le verdict final leur applique **500 ms et max(10 %, 2 ms)**, sans remplacer ni supprimer les quatre critères existants. Les deux ouvertures sont mesurées séparément : **ne pas soustraire leurs p95 pour annoncer un temps de démarrage**. Le deuxième chargement réutilise un worker ayant déjà traité ce profil : c'est un état différent, annoncé, et non une accélération applicative. Le démarrage des listeners/du leadership, l'authentification réseau et le transfert au navigateur sont hors chronomètre, comme dans le banc d'origine.

Trois paires AB/BA/AB par suite, référence main `56c52b4`, application candidate `cbfd14a` inchangée. Suite update, suite froid d'origine, puis complément, soit dix-huit processus. Même source de chaque banc entre les versions ; applications, migrations et packages extraits de commits immuables. Chaque préparation/série contrôle secteur, mémoire Windows/WSL et swap. Aucun build ni test concurrent. Les octets des scripts de protocole sont archivés dès le lancement et leur empreinte est incluse dans le manifeste.

Le comparateur refuse les séries manquantes, dupliquées ou non finies. Un test conserve le témoin rouge historique 240,685 → 272,246 ms même si toutes les ouvertures complémentaires sont vertes ; un autre vérifie le refus d'une ouverture complémentaire à 500 ms. Un nouveau test conserve le témoin pool vide 156,168 → 187,001 ms alors que les quatre mesures d'origine passent. **Sept tests ciblés du comparateur/de la marge réussissent**, ainsi que TypeScript du service collaboratif.

## Reproduction et relecture

Lire `scripts/compare-collab.mjs`, `scripts/collab-comparison.mjs` et son test, puis `apps/collab/src/testing/cold-lifecycle.ts`. Le nouveau banc ne fait partie ni de la production ni de la suite fonctionnelle générale. Les fichiers des bancs warm/cold d'origine restent inchangés.

```powershell
node --env-file=.env scripts/compare-collab.mjs --session6 --reference 56c52b4 --candidate cbfd14a --cold-lifecycle
```

Conserver `summary.json`, `manifest.json`, les rapports/logs de chaque processus, les relevés d'hygiène et les sources `protocol-*.txt`. Les résultats complémentaires sont dans `supplementaryMetrics`, les quatre critères existants dans `metrics` ; les deux groupes participent au verdict. Tout plafond absolu dépassé arrête immédiatement la campagne ; la marge relative est jugée une fois les trois paires disponibles. Une campagne rouge ne déclenche pas de nouvelle optimisation sans arbitrage.

## Résultats

Applications immuables main **`56c52b4b5cb4c4df94841328398d141955b48394`** et candidate **`cbfd14acc931c50ebcb1a8c28d3982849a814f40`**. Le contrôle d'empreintes prouve que les deux applications, les fixtures et les quatre sources communes (`warm.e2e.ts`, `cold.e2e.ts`, `database.ts`, `profiles.ts`) sont identiques à celles de la comparaison non instrumentée précédente. Les résultats de cette nouvelle campagne ne démontrent donc aucune accélération par une correction applicative ; les échecs précédents restent publiés.

| Mesure                      | Main : trois p95 (ms)       | Candidate : trois p95 (ms)  | Médiane main → candidate | Écart        | Verdict   |
| --------------------------- | --------------------------- | --------------------------- | ------------------------ | ------------ | --------- |
| Update contenu              | 8,764 / 9,166 / 9,105       | 9,351 / 8,987 / 9,059       | 9,105 → 9,059            | −0,51 %      | Conforme  |
| Update historique           | 33,622 / 33,224 / 34,109    | 35,224 / 34,145 / 36,479    | 33,622 → 35,224          | +4,76 %      | Conforme  |
| Froid d'origine, contenu    | 150,286 / 172,282 / 147,151 | 159,356 / 164,129 / 158,087 | 150,286 → 159,356        | +6,04 %      | Conforme  |
| Froid d'origine, historique | 270,855 / 235,770 / 258,117 | 288,274 / 260,304 / 277,285 | 258,117 → 277,285        | +7,43 %      | Conforme  |
| Pool vide, contenu          | 147,348 / 156,168 / 182,027 | 188,422 / 187,001 / 184,270 | **156,168 → 187,001**    | **+19,74 %** | **Arrêt** |
| Pool démarré, contenu       | 52,724 / 58,999 / 58,549    | 62,277 / 61,001 / 65,619    | 58,549 → 62,277          | +6,37 %      | Conforme  |
| Pool vide, historique       | 323,637 / 332,113 / 352,127 | 332,661 / 377,761 / 352,318 | 332,113 → 352,318        | +6,08 %      | Conforme  |
| Pool démarré, historique    | 246,379 / 235,081 / 258,477 | 273,406 / 250,572 / 252,884 | 246,379 → 252,884        | +2,64 %      | Conforme  |

Le surcoût pool vide/contenu est **30,833 ms**, pour une marge de **15,617 ms** : dépassement de **15,217 ms**, limite résultante **171,785 ms**. Tous les plafonds absolus passent. Les écarts appariés de ce cas sont +27,88 / +19,74 / +1,23 % : la référence varie encore (147 à 182 ms), il ne faut pas présenter le surcoût de 30,833 ms comme un coût constant établi. Le résultat localise le régime concerné ; il ne distingue pas encore chargement des modules, IPC, validation, SQL ou pauses mémoire.

## Correction du verdict, sans rejouer les mesures

Le premier comparateur classait les écarts relatifs complémentaires comme explicatifs. Son `summary.json` contient bien `exceedsRegression: true` pour le pool vide/contenu, mais **`failures: []` et le processus sort avec 0**. Ce classement était trop permissif pour une requalification à seuils inchangés : le vert initial ne vaut pas validation.

La règle générale est maintenant appliquée à toute ouverture complète. **`verdict.json` est rouge**, produit en recalculant les mêmes dix-huit séries avec le comparateur corrigé, sans nouveau benchmark, sans changer un échantillon ni un seuil. Le résumé initial, son empreinte, le code de décision corrigé et son empreinte sont tous conservés. Le script de recalcul sort avec 1 et le nouveau test permanent reproduit ce cas. Les prochains lancements émettront directement ce verdict rouge. Il ne s'agit ni d'une dérogation ni d'une nouvelle mesure verte substituée à l'ancienne.

## Hygiène et preuves

Dix-huit processus valides, aucune série rejouée ; secteur reconnu, **540 intervalles vmstat sans swap**, compteurs inchangés. Minima Windows **5,182 Gio avant préparation**, **4,793 Gio après** ; WSL **5,576 Gio disponibles après préparation**. Les six processus complémentaires conservent chacun 64 paires, dont les quatre paires d'échauffement explicitement marquées ; 360 ouvertures supplémentaires mesurées par état au total (deux profils × trente × six processus).

Le [manifeste d'artefacts](evidence/session-7-7d-protocole-froid/manifest.json) conserve les sources exactes du protocole initial, les huit mesures avec leurs trois p95 par configuration, chaque log et relevé brut, le verdict corrigé et les contrôles de code. Les empreintes du protocole initial se reconstruisent depuis les octets archivés ; le verdict corrigé est identifié séparément. Aucun code applicatif ou contrôle d'accès modifié.

`pnpm check` complet réussi : hooks installés, lint/formatage, TypeScript, bootstrap Nest, **193 tests réussis et six tests SQL ignorés dans la suite générale**. Les sept tests ciblés du comparateur passent séparément. Les suites fonctionnelles applicatives antérieures ne sont pas annoncées comme relancées : ce point ne change que le banc, son verdict et les documents. Le verdict de performance rouge reste distinct de ces contrôles de code verts.

## Suite proposée pour arbitrage

**7d reste arrêtée.** Proposition : profiler uniquement les premières ouvertures avec pool vide, en comparant main et candidate avec le même protocole, puis corriger seulement une cause établie, sans retrait de contrôle. Le protocole distingue enfin un état reproductible à investiguer ; il ne justifie pas encore une optimisation précise. Alternative produit : dérogation limitée à cette première ouverture du contenu sur le portable (**187,001 ms, +19,74 %**), en conservant la règle pour tous les autres cas et la qualification dédiée pré-pilote. **Aucune option appliquée sans décision du développeur.** Gros transferts, contrôle global `CONTROL_UNAVAILABLE`, antivirus et clôture documentaire restent ouverts.

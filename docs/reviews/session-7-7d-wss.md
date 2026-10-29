# 7d — décomposition du reçu durable WSS

29 octobre 2026. Mesure instrumentée sur la candidate en cours, **pas la comparaison finale avec main ni une qualification de charge mixte**. Les clients synthétiques séparés, le protocole et les seuils de 7a restent inchangés. Aucun profil CPU, build ou autre test exécuté pendant la campagne.

## Résultats

Deux profils encodés proches de 1 Mio, un ou deux auteurs dans la même salle ; chaque cas comprend dix tours de chauffe puis cent tours mesurés, avec 100 ms de pause après confirmation. « Références » alterne attache et retrait d'une référence de fichier déjà valide, sans téléversement simultané. Trois séries par profil, quatre cas par série : **24 cas et 3 600 reçus**, aucune fermeture pendant les cas. `RESIDENT_REPLICA` et `control-ended` dans le journal de nettoyage ne sont pas des déconnexions de rédacteurs pendant la mesure.

| Profil / écriture / auteurs | p95 serveur, trois séries (ms) | Médiane | p95 reçu WSS, trois séries (ms) | Médiane |
| --------------------------- | ------------------------------ | ------- | ------------------------------- | ------- |
| Contenu / texte / 1         | 14,763 / 13,695 / 13,276       | 13,695  | 23,006 / 27,452 / 24,769        | 24,769  |
| Contenu / texte / 2         | 15,888 / 14,573 / 13,107       | 14,573  | 32,194 / 32,410 / 30,889        | 32,194  |
| Contenu / références / 1    | 22,928 / 24,937 / 27,759       | 24,937  | 29,074 / 32,862 / 33,848        | 32,862  |
| Contenu / références / 2    | 26,442 / 26,434 / 25,456       | 26,434  | 52,006 / 54,308 / 49,861        | 52,006  |
| Historique / texte / 1      | 57,698 / 52,563 / 53,193       | 53,193  | 201,197 / 185,318 / 186,799     | 186,799 |
| Historique / texte / 2      | 56,888 / 60,748 / 57,150       | 57,150  | 298,742 / 289,264 / 273,687     | 289,264 |
| Historique / références / 1 | 50,281 / 43,096 / 47,984       | 47,984  | 164,264 / 154,376 / 166,283     | 164,264 |
| Historique / références / 2 | 55,863 / 51,133 / 49,479       | 51,133  | 238,129 / 219,748 / 228,325     | 228,325 |

Le compteur serveur historique de 7a couvre validation du candidat jusqu'au retour du commit SQL, **pas** toute la résidence côté serveur. Tous les cas respectent <50 ms contenu et ≤100 ms historique. Le reçu contenu reste sous 200 ms dans ce banc ; l'historique est surveillé, sans transformer son résultat en dérogation. Le rebasage pré-pilote reste obligatoire.

## Où passent les millisecondes

Les observations suivantes sont les médianes des trois p95 de chaque composante. **Ne pas additionner les colonnes : leurs p95 ne décrivent pas nécessairement le même reçu.** Le [rapport détaillé](evidence/session-7-7d-initiale/decomposition.json) fournit les trois valeurs et un échantillon effectivement situé au p95 du reçu dans chaque série. Le script vérifie, sur chacun des 3 600 échantillons, que les intervalles disjoints reconstituent exactement leur durée totale.

| Composante, deux auteurs en texte (ms)                 | Contenu | Historique |
| ------------------------------------------------------ | ------- | ---------- |
| Modification client → appel d'envoi                    | 0,86    | 50,32      |
| File de la salle avant traitement                      | 11,52   | 94,17      |
| Validation/réservation avant SQL                       | 3,02    | 46,14      |
| Transaction SQL                                        | 10,34   | 13,95      |
| Commit de réplique + application Yjs/callbacks serveur | 0,61    | 63,27      |
| Résidence totale serveur jusqu'à envoi du reçu         | 28,89   | 225,81     |
| Résidu transport + Caddy + ordonnancement              | 2,91    | 3,47       |

L'écart ≈57/289 ms sur l'historique ne vient donc pas principalement du réseau dans cette fixture locale. Il inclut du travail Yjs avant l'envoi, l'attente derrière l'autre contribution et le commit/application de la réplique après durabilité SQL. Le passage `Room.update` terminé → envoi du reçu est observé séparément ; le champ brut `diffusionAndReceiptMs` ne signifie **pas** que toute la diffusion aux autres rédacteurs y est isolée. Hocuspocus peut regrouper la diffusion au tour de boucle suivant. La réception/application du contenu chez un autre navigateur reste à mesurer avec la charge mixte ; aucune latence réseau unidirectionnelle n'est inférée de deux horloges de processus.

Autre limite : ce banc reprend le provider synthétique de 7a sans retry masquant les fermetures. Il n'utilise pas le délai d'envoi de 100 ms du composant front final. Les chiffres ne sont donc pas présentés comme la latence d'une frappe de l'interface finale. Celle-ci doit être distinguée dans la mesure mixte et le scénario de reconnexion.

## Hygiène et reproductibilité

Secteur reconnu avant chaque série (`BatteryStatus=2`), Windows ≥3 Gio avant préparation. Après préparation :

| Série        | Windows libre (Gio) | WSL MemAvailable (Gio) | Intervalles vmstat | Swap entrant/sortant |
| ------------ | ------------------- | ---------------------- | ------------------ | -------------------- |
| Contenu 1    | 3,62                | 5,25                   | 60                 | 0 / 0                |
| Contenu 2    | 3,52                | 5,20                   | 60                 | 0 / 0                |
| Contenu 3    | 3,30                | 5,23                   | 60                 | 0 / 0                |
| Historique 1 | 2,85                | 5,25                   | 132                | 0 / 0                |
| Historique 2 | 2,87                | 5,22                   | 127                | 0 / 0                |
| Historique 3 | 2,53                | 5,25                   | 127                | 0 / 0                |

Les **566 intervalles** et compteurs cumulatifs ne montrent aucune activité de swap. Les valeurs complètes avant/après préparation et série sont versionnées dans `evidence/session-7-7d-initiale/hygiene/` ; fichiers de série compressés sans perte, incluant le vmstat brut. Les [échantillons complets](evidence/session-7-7d-initiale/wss.json.gz), le [journal](evidence/session-7-7d-initiale/wss-trace.txt) et le [manifeste SHA-256](evidence/session-7-7d-initiale/manifest.json) permettent de contrôler le résultat.

Reproduction : définir `MEMORIA_FILES_TRACE=true`, lancer `pnpm measure:files` seul, puis `node scripts/summarize-file-trace.mjs`. Pour relire les preuves sans mesurer : `node scripts/summarize-file-trace.mjs docs/reviews/evidence/session-7-7d-initiale/wss.json.gz`. Le premier essai d'instrumentation avorté est conservé : trames client `ArrayBuffer` non décodées, correction couverte par un test dédié. Ce n'était ni un dépassement de plafond ni une série valide écartée.

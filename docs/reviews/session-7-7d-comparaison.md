# Session 7d — comparaison alternée finale, arrêt sur le froid contenu

6 novembre 2026. Application candidate **`b31dd28adf98c7c16067955d6979bba2a358ddbd`**, incluant la [reprise ciblée](session-7-7d-reconnexion.md), comparée à main **`56c52b4b5cb4c4df94841328398d141955b48394`**. **La campagne s'arrête : une médiane dépasse la règle de non-régression.** Aucun seuil changé, aucune optimisation après ce résultat. Cette fiche ne clôture pas 7d.

## Protocole et portée

Deux instantanés immuables des sources applicatives, packages et migrations ; même banc, mêmes octets Yjs et mêmes dépendances contrôlées. Ordre AB, BA, AB, pour le chaud et le froid, soit douze processus successifs. Tous les builds précèdent les mesures ; aucun test ou build en parallèle. Deux profils de près de 1 Mio : contenu 1 045 110 octets, historique 1 042 470 octets, empreintes dans le manifeste.

Le chaud mesure la validation incrémentale, la transaction de journal avec assurance de session, politique forte et accès courants, puis l'application à la réplique : deux cents échantillons après vingt échauffements. Il ne mesure pas le reçu WSS. Le froid mesure l'admission mémoire, le chargement PostgreSQL, la création du document Hocuspocus et de sa réplique ; pas de session, réseau, frappe concurrente ou fin de journal à rejouer. Les workers du pool peuvent être réutilisés. Trente échantillons froids après deux échauffements par profil et par série. Cette comparaison isolée ne remplace ni la charge mixte ni le scénario CPU du vrai front.

Secteur `BatteryStatus=2` à chaque série. Minima : **4,52 Gio Windows avant préparation**, **4,49 Gio Windows et 5,61 Gio WSL après préparation**. Douze relevés d'hygiène valides, **213 intervalles vmstat sans swap**, compteurs inchangés. Ryzen 7 5800H, 16 processeurs logiques disponibles, Node 24.21.0, Windows 10.0.26300. Les chiffres ne qualifient pas l'hôte cible 4 vCPU / 8 Gio.

Le premier lancement a échoué à la construction, avant toute mesure : le helper mémoire importait `docker-test-isolation.mjs`, absent des instantanés du banc. Le script copie désormais aussi ce helper et l'inclut dans l'empreinte du protocole, pour les deux configurations. Aucun garde-fou n'est retiré. Ce refus de préparation est conservé avec la campagne complète suivante.

## Résultats

Les trois valeurs sont les p95 de chaque série, en millisecondes ; la décision compare leurs médianes. Aucun échantillon mesuré ni série retiré, aucune répétition destinée à sélectionner un résultat favorable.

| Mesure                  | Main : trois p95            | Candidate : trois p95       | Médiane main → candidate | Écart                     | Marge autorisée | Résultat  |
| ----------------------- | --------------------------- | --------------------------- | ------------------------ | ------------------------- | --------------- | --------- |
| Update contenu 1 Mio    | 9,055 / 8,629 / 10,453      | 9,481 / 9,590 / 9,214       | 9,055 → 9,481            | +0,427 ms (+4,71 %)       | 2 ms            | Conforme  |
| Update historique 1 Mio | 32,549 / 33,974 / 33,266    | 35,590 / 36,210 / 32,802    | 33,266 → 35,590          | +2,324 ms (+6,99 %)       | 3,327 ms        | Conforme  |
| Froid contenu 1 Mio     | 143,128 / 146,679 / 145,649 | 161,508 / 158,243 / 163,001 | 145,649 → 161,508        | **+15,859 ms (+10,89 %)** | **14,565 ms**   | **Arrêt** |
| Froid historique 1 Mio  | 244,891 / 235,301 / 232,130 | 284,735 / 243,920 / 245,761 | 235,301 → 245,761        | +10,460 ms (+4,45 %)      | 23,530 ms       | Conforme  |

Tous les plafonds absolus passent dans chaque série : update contenu <50 ms, historique <100 ms, froid <500 ms. Le froid contenu dépasse cependant la marge `max(10 %, 2 ms)` de **1,294 ms**. La limite résultante de cette référence est **160,214 ms**, contre 161,508 mesurées. La dérogation historique + conversions 8K ne s'applique pas à ce cas. Le processus de comparaison sort en erreur, avec une seule entrée dans `failures` et aucune série invalide.

## Diagnostic disponible, sans optimisation

La lecture du différentiel montre un travail supplémentaire dans `Room.load` : la candidate demande `replica.inspect()`, récupère les blocs, extrait les références de fichiers puis appelle `Store.verifyFileLedger()`. Ce dernier relit l'état courant et vérifie le registre dans une transaction avec les protections existantes. Main ne possède pas ce chemin de session 7. Il appartient bien à la région chronométrée du froid.

**Cela désigne une piste, pas une attribution des 15,859 ms.** Cette campagne n'instrumente pas séparément copie IPC, inspection, validation du registre et attentes SQL ; elle ne permet pas non plus d'attribuer la régression au seul correctif de reconnexion. Les deux commits diffèrent de toute la session 7. Aucun contrôle ne peut être supprimé sur la base de ce résultat.

Deux suites à arbitrer :

1. **Recommandée : profiler le froid**, attribuer son coût à l'initialisation, à l'inspection/transfert des blocs et au registre SQL, puis corriger uniquement une cause établie en préservant toutes les vérifications. Rejouer ensuite les trois paires sur la candidate finale. Objectif, pour cette référence : gagner au moins 1,294 ms, avec une marge réelle, sans viser seulement l'arrondi.
2. **Dérogation explicite limitée à ce résultat**, si le développeur accepte 161,508 ms, +10,89 %, sur ce portable malgré une limite de 160,214 ms. Aucune telle dérogation n'est appliquée ici ; le plafond absolu 500 ms et les autres règles resteraient inchangés.

## Preuves et relecture

Les [57 artefacts et leurs empreintes](evidence/session-7-7d-comparaison/artifacts.json) conservent le manifeste, les douze journaux complets, les rapports bruts, les relevés mémoire/secteur/vmstat, la sortie et la synthèse de comparaison, le refus initial et les cinq scripts du protocole. Sources applicatives reproductibles par les deux commits, empreintes des bundles et des fixtures dans le manifeste. Les fichiers compressés préservent exactement les octets mesurés malgré les fins de ligne Windows.

Lire cette fiche, `summary.json.gz`, `manifest.json.gz`, puis le changement de copie de helper dans `scripts/compare-collab.mjs`. Le commit de publication de cette fiche n'ajoute aucune modification applicative à la candidate mesurée. La [fiche de reconnexion](session-7-7d-reconnexion.md) décrit séparément les tests fonctionnels et le guide à deux navigateurs.

Le contrôle général après le résultat rouge passe : `pnpm check` complet, hooks installés, lint, types, bootstrap Nest et **189 tests réussis, six tests SQL ignorés**. Journal local complet : `.local/session-7-7d-comparison-check.log`. Cette réussite ne remplace pas la comparaison rouge et ne valide pas les charges restant à exécuter.

Reproduction opérateur, uniquement sur l'environnement de mesure, après disponibilité des fixtures et respect des garde-fous :

```powershell
node scripts/compare-collab.mjs --session6 --reference 56c52b4b5cb4c4df94841328398d141955b48394 --candidate b31dd28adf98c7c16067955d6979bba2a358ddbd
```

Attendre les douze processus ; examiner `summary.json` même si la commande retourne 1. Une série refusée par l'hygiène ne constitue pas une mesure. Ne pas exécuter d'autre charge pendant ce contrôle. **Aucune relance ni optimisation n'est effectuée avant l'arbitrage demandé.** Gros transferts, charge NAT des fichiers, coût antivirus et clôture globale `CONTROL_UNAVAILABLE` restent ouverts.

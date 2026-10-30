# 7d — diagnostic du banc à dix rédacteurs

30 octobre 2026. Suite autorisée par le développeur après le commit `5ddd81c` : diagnostiquer la déconnexion, puis corriger la préparation du banc si l'hypothèse est confirmée. Ce point ne clôt pas 7d.

## Cause prouvée avant correction

La reproduction conserve l'ordre initial : dix clients WSS réels sans awareness, puis préparation des textures et démarrage du convertisseur. L'instrumentation relève la dernière réception, l'appel local de fermeture avec sa pile, puis le code de fermeture reçu. Elle ne modifie ni Hocuspocus ni ses délais.

La connexion séquentielle des dix clients prend **22,053 s**, puis la préparation des textures **18,690 s**. Cinq clients se ferment avant la première écriture : `HocuspocusProviderWebsocket.checkConnection()` appelle `webSocket.close()` après **30,009 à 32,945 s** sans message. Code observé **1005**, raison vide. Le délai natif est **30 000 ms**. La pile prouve que cette fermeture vient du client synthétique ; aucune fermeture `CONTROL_UNAVAILABLE` n'est observée dans cette reproduction.

Un défaut secondaire du banc rendait une erreur sans message ambiguë : le parent IPC testait la valeur de `error` au lieu de sa présence, puis tentait de lire un reçu absent. La correction traite aussi une chaîne vide comme un échec et donne un message de déconnexion explicite. Aucun résultat précédemment réussi n'est transformé par ce changement ; les essais en échec restent conservés.

## Correction et vérification

Les textures et le convertisseur sont préparés **avant** les connexions WSS. Aucun délai produit, budget mémoire, quota, contrôle d'accès ou plafond n'est modifié. Le mode `MEMORIA_MIXED_DIAGNOSE_IDLE=true` conserve volontairement l'ancien ordre comme témoin rouge reproductible ; il ne fait pas partie d'une campagne de qualification.

La première relance corrigée termine ses **1 000 écritures** et vérifie la convergence de chaque paire. Aucun des dix clients n'est fermé. Elle échoue toutefois à son assertion de couverture : une seule conversion lourde a été terminée, car la fenêtre d'écriture est plus courte que deux conversions. Cette série n'est donc pas déclarée qualifiée. Les valeurs observées sont conservées, sans les substituer aux trois séries finales : p95 global validation/transaction **19,591 ms**, SQL **14,602 ms** ; reçu de la page de 1 Mio **48,398 ms**, application chez l'autre client **48,581 ms**.

Le banc commence désormais par l'image uniforme puis l'image bruitée et enregistre début/fin de chaque conversion. Il exige que **chacun des deux profils chevauche réellement la fenêtre de saisie**, au lieu de compter seulement les résultats reçus. Une conversion peut se terminer après la dernière écriture ; cette attente de nettoyage ne sera pas présentée comme du temps de saisie sous charge. Cadence, dix échauffements et cent vagues mesurées inchangés. Cette correction de couverture ne constitue pas une optimisation de l'application.

La relance suivante a été refusée **avant préparation** : Windows **2,711 Gio** libres, WSL **4,872 Gio** disponibles, secteur reconnu. Aucune nouvelle série lancée sous ce seuil. Les trois séries par configuration restent à exécuter après libération de mémoire. Gros transferts, saturation volontaire, reconnexion du vrai front et comparaison finale avec main restent ouverts.

Les [journaux et relevés complets](evidence/session-7-7d-banc-mixte/manifest.json) sont versionnés, y compris la reproduction rouge, le refus de couverture et celui de mémoire ; les rapports JSON volumineux sont compressés sans perte. `pnpm check` final réussit : hooks, lint, types, bootstrap Nest, **187 tests réussis et six SQL ignorés**. Aucun changement de code SQL ni hook contourné.

## Relecture et reproduction

- Lire [le banc](../../apps/collab/src/testing/files-mixed.e2e.ts), [le client](../../apps/collab/src/testing/file-load-client.ts) et [la boucle de conversion](../../scripts/file-mixed-converter.mjs).
- `pnpm measure:files:mixed` prépare une page de 1 Mio et quatre pages ≤200 Kio, avec deux comptes par page. Garde-fous secteur/mémoire/swap actifs ; aucun autre build ou test en parallèle. Arrêt au premier échec.
- Pour reproduire uniquement la cause initiale, définir `MEMORIA_MIXED_DIAGNOSE_IDLE=true` pour cette commande, puis retirer cette variable. Le résultat attendu du témoin est un refus avec les traces `checkConnection`, jamais un résultat de capacité réussi.
- Lire les événements de fermeture avant ceux du nettoyage ; ne pas confondre les connexions fermées à la fin du test avec une perte pendant l'édition.

Ce qui peut encore casser : préparation des clients exceptionnellement longue, ressources insuffisantes, latence pendant les conversions et contrôle d'accès sous saturation. Le diagnostic actuel ne prouve pas la reprise du produit après une saturation CPU.

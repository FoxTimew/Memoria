# Session 3 — preuve de validation incrémentale avant 3a

> Document historique : les lanceurs `proof:collab*` ont été retirés en 3a. Voir la [fiche du service réel](session-3-3a-service.md) pour les commandes actuelles.

La cible passe sur les deux profils proches de 1 Mio : **13,64 ms au p95 pour le contenu dense, 48,86 ms pour l'historique**. La marge historique est faible (1,14 ms) ; à presque 4 Mio, le diagnostic reste à **152,91 ms**. Le prototype reste isolé ; **3a n'a pas commencé**.

## Fichiers à lire en priorité

1. [ADR 017, preuve incrémentale](../adr/017-collaboration-temps-reel.md#preuve-incrémentale-avant-3a--décision-et-résultats) : décisions, chiffres exacts, mémoire, rebasage et limites. [ARCHITECTURE.md](../../ARCHITECTURE.md) situe les trois livraisons suivantes.
2. [`incremental-replica.ts`](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/incremental-replica.ts), [`codec.ts`](../../apps/collab/src/codec.ts) et [tests différentiels](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/incremental-replica.test.ts) : cache des contenus validés, blocs touchés, invariants globaux, reconstruction après rejet.
3. [`incremental-validator.ts`](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/incremental-validator.ts) et [worker](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/incremental-worker.ts) : séparation prepare/commit/abort et budgets ; [`server.ts`](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/server.ts), [file](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/room-batch-queue.ts) et [budget de refus](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/rejection-budget.ts) : revalidation de chaque contribution après rejet du lot.
4. [Mesures de performance](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/incremental-performance.ts), [fixture contenu](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/content-fixture.ts), [mémoire/rebasage](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/incremental-memory.ts) et [scénario d'abus](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/abuse.ts).

## Ce qui est démontré

- **Contenu proche des bornes :** 500 blocs, profondeur 3, 55 fiches, neuf types ; 1 040 382 octets JSON métier, 1 045 110 octets Yjs au départ. Les biographies UTF-8 denses respectent Zod ; ce n'est pas un document de 1 Mio de texte ASCII. p95 total 13,638 ms.
- **Historique proche de 1 Mio :** 300 blocs, 100 802 octets métier, 41 129 clients Yjs historiques ; encodage 1 042 470 octets, GC actif et taille stable après rechargement. p95 total 48,859 ms, p99 57,264 ms. Vingt updates de chauffe puis 200 non filtrées par profil, transaction PostgreSQL réelle, délai normal 250 ms/worker 128 Mio. Le total inclut les échanges worker et le commit de la réplique, exclut réseau/file/projection/chargement froid.
- **4 Mio indicatif :** 4 126 752 octets et 176 619 clients historiques. Premier essai interrompu par le délai de 250 ms. Série complète de 200 mesures avec budget de diagnostic explicite 10 s/512 Mio : p95 152,908 ms. Les bornes métier et celles du serveur ne sont pas relevées.
- **100 répliques effectivement chargées :** contenu dense, 357,40 Mio de tas + 99,67 Mio de buffers ; historique, 1 883,19 Mio de tas + 99,42 Mio de buffers. RSS absolue respective 646,55 et 2 634,58 Mio. Les mesures incluent les checkpoints indépendants et les index, mais excluent les autres objets du service et l'overhead de 100 workers. Deux tentatives historiques se sont arrêtées à la réserve physique ; la série finale dans un processus neuf atteint bien 100 après libération de RAM.
- **Rebasage évalué seulement :** historique 1 Mio réduit à 103 111 octets, reconstruction/validation p95 24,73 ms ; ancien document déjà chargé, ni SQL ni reconnexion dans le coût. Critère proposé : au moins 768 Kio encodés et ratio Yjs/JSON au moins 4. Pas de rebasage ni de changement de génération ajouté au service ; clients hors ligne orientés vers le parcours d'export spécifié dans l'ADR si ce mécanisme est retenu plus tard.
- **Rejet sélectif :** lot refusé réévalué contribution par contribution ; seule la contribution invalide est rejetée. Un compte fautif se reconnecte et recommence pendant que deux autres rédigent : 162 reçus sains vérifiés en SQL, aucun reçu fautif, convergence et **zéro déconnexion des deux rédacteurs**. Trois connexions fautives déclenchent un blocage de 60 s pour ce compte dans cette salle ; deux nouvelles tentatives sont refusées avant chargement du contenu.

## Ce qui pourrait casser

- **Cache incomplet :** une mauvaise invalidation pourrait accepter un contenu non vérifié. Les tests comparent au validateur complet pour texte, liens/marques, champs, remplacement/suppression de sous-arbres et bornes globales. Ils vérifient aussi que le worker incrémental n'importe aucune UI. Une évolution du format BlockNote/Yjs exige de rejouer ces contrôles.
- **Temps et mémoire :** 1 Mio historique passe de peu ; 4 Mio ne tient pas 50 ms. Un serveur plus lent ou plusieurs salles actives peuvent dépasser la cible. Le coût froid/rejet et l'encodage exact à la limite sont distincts de la frappe acceptée. Le tas mesuré à 100 documents ne dimensionne pas tout le service.
- **Réplique après erreur :** repartir du checkpoint et des updates acceptées, jamais fusionner un ancien snapshot pour annuler. Une erreur après commit impose un rechargement durable. Le journal retenu par la réplique n'est pas encore compacté automatiquement ; 3a doit borner sa croissance.
- **Abus et files :** le budget de refus suit le compte dans une salle ; il ne prouve pas la résistance à plusieurs comptes hostiles ni l'admission globale. Les quotas dès réception des octets, avant les files natives Hocuspocus, restent en 3a. Le refus peut ralentir les autres clients pendant la reconstruction, même si les tests garantissent ici qu'ils ne sont pas déconnectés.
- Leadership, triggers, HMAC, writer de production, projection/compaction automatiques, interface, WSS, présence/cache et nettoyage restent dans 3a/3b/3c. Aucun changement de l'application session 2 ; aucun utilisateur réel avant la fin de la session 4.

## Contrôles et test manuel

PostgreSQL local et `.env` de développement requis. Les preuves créent puis suppriment uniquement leurs schémas SQL aléatoires. Ne pas lancer plusieurs benchmarks en parallèle. Les grosses mesures peuvent demander plusieurs minutes et plusieurs Gio libres ; la mémoire s'arrête si moins de 384 Mio physiques restent disponibles.

```powershell
pnpm check
# Mesure requise des deux profils 1 Mio, puis diagnostic 4 Mio ; génère les snapshots locaux :
pnpm proof:collab:incremental
# Réutilise les snapshots générés ; mesure contenu + historique + rebasage en mémoire :
pnpm proof:collab:incremental --memory
# Série historique seule dans un processus neuf, utile pour atteindre 100 :
pnpm proof:collab:incremental --memory --history-only
# Douze scénarios réels avec la réplique incrémentale, puis scénario d'abus :
pnpm proof:collab:incremental --transport --incremental
pnpm proof:collab:incremental --abuse
# Régression de la preuve initiale avec le validateur complet :
pnpm proof:collab
```

Pour une relecture rapide, lancer transport et abus : attendre les douze lignes `PASS`, puis `healthyDisconnections:[0,0]`, les 162 reçus SQL et `ABUSE PROOF COMPLETE`, avec code final 0. Les erreurs de validation/SQL injectées sont attendues. Les deux navigateurs ne deviennent testables qu'en fin de 3b.

Pour les performances, comparer les valeurs exactes des deux profils requis : le script s'arrête avec code 2 si l'un échoue au seuil. 4 Mio est indicatif : un code 0 de fin n'affirme pas qu'il passe 50 ms. La commande facultative `--four` réutilise le snapshot 4 Mio local pour mesurer le diagnostic séparément. La série archivée à 1 Mio précède cet ajout de délai diagnostique : son échec 4 Mio à 250 ms est conservé, sans échantillons inventés. La mémoire exige `loaded:100`, pas une extrapolation. Pour le rebasage, comparer le contenu validé et la taille reconstruite ; rien n'est appliqué aux pages de l'application.

## Journaux et échantillons

- [Mesures 1 Mio et premier essai 4 Mio](session-3-incremental-performance.txt), [échantillons bruts](session-3-incremental-performance.json).
- [Diagnostic 4 Mio complet](session-3-incremental-four.txt), [200 échantillons](session-3-incremental-four.json).
- [Mémoire contenu 100 et première série historique partielle ; rebasage](session-3-incremental-memory.txt), [mesures mémoire](session-3-incremental-memory.json), [rebasage](session-3-incremental-rebase.json).
- [Mémoire historique, 100 répliques, processus neuf](session-3-incremental-memory-history.txt), [mesures](session-3-incremental-memory-history.json).
- [Douze scénarios incrémentaux](session-3-incremental-transport.txt), [attaquant et deux rédacteurs sains](session-3-incremental-abuse.txt).
- [Régression de la preuve initiale et douze scénarios](session-3-incremental-regression.txt), [échantillons de régression](session-3-incremental-regression-performance.json).
- [Contrôle complet pnpm check](session-3-incremental-check.txt), résumé final Vitest et code de sortie inclus.

Résultat vérifié : `pnpm check` terminé avec code 0, **89 tests réussis / 6 tests SQL génériques ignorés**, types des 12 packages et preuve Nest valides. Les tests SQL de collaboration sont bien exécutés dans les commandes de preuve, indépendamment des six tests génériques ignorés. Transport incrémental : 12 scénarios, code 0. Abus : 162 reçus et zéro déconnexion saine, code 0. Régression complète : p95 initial 20,351 ms et 12 scénarios, code 0. Les sorties et codes finaux sont archivés ci-dessus.

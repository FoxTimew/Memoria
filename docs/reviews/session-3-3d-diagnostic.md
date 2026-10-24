# 3d — contrôle préalable et arrêt sur les performances

Date : 24 octobre 2026. Statut : **diagnostic, capacité 3d non livrée**.

La session 3 a été fusionnée avec autorisation explicite par la [PR #3](https://github.com/FoxTimew/Memoria/pull/3). Cette nouvelle branche `codex/session-3d-collaboration-capacity` part de main synchronisé, commit `e38a17e`.

## Résultat et décision

Les seuils ne passent pas sur le profil historique de 1 Mio. Le problème est déjà présent sur main ; la première expérience de pool ne le résout pas. La suite de 3d est interrompue avant réservation proportionnelle, mesure des 30 pages et reprise après panne du pool. Le développeur a choisi de **conserver 1 Mio, diagnostiquer puis optimiser validation et transaction avant de reprendre 3d**. Aucun seuil n'est relevé et aucune taille plus basse n'est déclarée conforme sans mesure.

| Série                         | Update contenu p95 | Update historique p95 | Froid contenu p95 | Froid historique p95 |
| ----------------------------- | -----------------: | --------------------: | ----------------: | -------------------: |
| Main, première mesure         |           41,63 ms |          **66,06 ms** |         348,57 ms |        **752,37 ms** |
| Main, après libération de RAM |           43,51 ms |          **65,01 ms** |         229,34 ms |        **642,91 ms** |
| Pool minimal                  |           36,67 ms |          **77,19 ms** |         232,43 ms |        **504,29 ms** |
| Cible inchangée               |            < 50 ms |               < 50 ms |          < 500 ms |             < 500 ms |

Toutes les suites de ce tableau terminent avec **EXIT_CODE=1**, assertions visibles dans leurs journaux. Il ne s'agit pas de tests bloqués. Les valeurs de 3a restent des résultats historiques, pas une validation de la configuration actuelle. Une série par configuration ne démontre pas à elle seule que le pool cause toute la variation observée.

## Méthode et preuves

Même Ryzen 7 5800H, Windows, Node 24, PostgreSQL local Docker. RAM disponible observée : environ 1 Gio au premier relevé, puis 3,6 Gio après intervention du développeur ; compression mémoire initiale environ 1,6 Gio. Aucun build simultané aux mesures. Les applications Memoria existantes restent ouvertes. La machine n'est pas un hôte dédié de 4 vCPU / 8 Gio ; aucune certification de cette cible.

Fixtures inchangées : contenu **1 045 110 octets Yjs / 1 040 382 octets JSON**, historique **1 042 470 / 100 802**. Updates : 20 chauffes puis 200 échantillons, texte et champs de fiche ; validation isolée, transaction PostgreSQL réelle avec droits et réservation des UUID, puis commit de la réplique. Réseau, attente en file et projection exclus. Froid : deux chauffes puis 30 chargements Hocuspocus depuis PostgreSQL, arbre vivant et réplique ; pas de journal résiduel ni de contrôle de session dans ce benchmark.

Le pool expérimental conserve ses workers entre déchargements de documents. Il est paresseux, au plus quatre workers sur cette machine (moitié des processeurs disponibles, bornée de 1 à 4), plusieurs répliques possibles par worker, une opération dispatchée à la fois, réponses corrélées, file bornée. Le test froid inclut encore les créations de workers restantes après les deux chauffes ; ce n'est pas une mesure de trente redémarrages du processus. Le test d'updates ne mesure pas la contention de plusieurs pages.

Les six journaux `session-3-3d-{baseline,baseline-free,pool}-{warm,cold}.txt` et leurs JSON contiennent tous les échantillons et les résumés finaux. Seuls fins de ligne et espaces terminaux des journaux ont été normalisés. La référence avant optimisation correspond à `e38a17e`. Le [patch de l'expérience](session-3-3d-pool-experiment.patch) reproduit exactement les changements applicatifs mesurés ; **il n'est pas activé dans cette livraison**. `git apply --check` vérifie son applicabilité à la référence.

Sur le profil historique, après libération de RAM, les p95 séparés sont 35,73 ms de validation et 30,91 ms de transaction ; avec pool, 40,68 ms et 36,76 ms. Ces percentiles ne s'additionnent pas. Ces données motivent l'analyse des deux étapes, sans désigner une requête ou un algorithme comme cause prouvée.

## Fichiers à lire en priorité

- Cette fiche et les JSON `baseline-free-warm` / `pool-warm` pour les mesures.
- `apps/collab/src/service/store.ts` et `incremental-replica.ts` pour les prochaines investigations.
- Le patch expérimental pour le périmètre exact du pool minimal.
- `ARCHITECTURE.md`, session 4 : option « Poste partagé » et politique de workspace interdisant le cache persistant ajoutées au programme, sans implémentation anticipée.

## Ce qui pourrait casser et ce qui n'est pas prouvé

Le code applicatif reste celui de main. Le patch est une expérience incomplète : pas de réservation par classes, pas de test de capacité à 30 pages, pas de reprise proactive PostgreSQL de toutes les répliques d'un worker perdu, pas de budget global du pool ni de test de contention multi-pages. Il ne doit pas être déployé comme livraison 3d. Les projections temporaires conservent encore leur worker propre dans cette expérience. Le guide d'hébergement reste marqué provisoire.

## Reproduire

Sur la référence, installer les dépendances et démarrer PostgreSQL avec la configuration `.env` locale habituelle. Aucun reset des données n'est nécessaire : les tests utilisent des schémas isolés.

```powershell
pnpm test:collab:e2e --suite warm
pnpm test:collab:e2e --suite cold
```

Dans un checkout jetable de cette référence uniquement, appliquer `git apply docs/reviews/session-3-3d-pool-experiment.patch`, puis relancer les mêmes commandes. Chaque JSON conserve les résultats avant l'assertion du seuil. Les fichiers `.local/3a-*-production.json` appartiennent aux tests de référence ; l'expérience écrit `.local/3d-pool-*-production.json`. Ne pas lancer les deux benchmarks en parallèle ni pendant une compilation. Conserver aussi les échecs ; ne pas filtrer les échantillons ni contourner les hooks.

Contrôles de la livraison documentaire : `pnpm check` réussit (12 packages typés, preuve Nest, **90 tests Vitest réussis / 6 SQL génériques ignorés**), `EXIT_CODE=0` dans `session-3-3d-diagnostic-check.txt`. Cette réussite ne transforme pas les benchmarks ci-dessus en réussites. Aucun test fonctionnel d'un pool de production n'est revendiqué.

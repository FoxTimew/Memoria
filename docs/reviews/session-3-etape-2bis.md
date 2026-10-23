# Session 3, étape 2 bis — tailles et dix rédacteurs

Livraison limitée à la preuve. **L'intégration attend un choix : borne réduite à 192 Kio, ou nouvelle preuve de validation incrémentale pour conserver 4 Mio.** Recommandation : seconde option. Le regroupement des updates en attente est livré dans le prototype. L'application active reste celle de session 2.

## Résultats

| Mesure                                                      | Résultat p95                              |
| ----------------------------------------------------------- | ----------------------------------------- |
| Candidat + transaction, proche de 192 Kio, limites normales | **38,734 ms**                             |
| Même traitement, proche de 256 Kio                          | 51,636 ms                                 |
| Même traitement, proche de 1 Mio                            | **327,797 ms**                            |
| Même traitement, proche de 4 Mio                            | **1 608,796 ms**                          |
| Confirmation, dix rédacteurs, journal unitaire              | 2 223,526 ms ; maximum 106 non confirmées |
| Confirmation, dix rédacteurs, regroupement                  | **53,022 ms ; maximum 5 non confirmées**  |

Tailles exactes et composantes dans l'ADR. Les profils 1/4 Mio contiennent 41 190/179 548 identifiants de clients historiques et 100 802 octets de contenu métier. Ils éprouvent une forme coûteuse mais admissible de l'historique, GC actif, sans prétendre représenter un usage ordinaire. Ils dépassent le délai normal de 250 ms dès le premier essai : les percentiles complets sont des **diagnostics à 10 s/512 Mio**, pas une capacité validée du serveur. Le profil réduit utilise 250 ms/128 Mio pour tous les échantillons. Les limites métier, de structures et de taille ne sont jamais relevées.

Dix vrais providers, cookies Better Auth et sockets loopback, PostgreSQL avec `fsync=on` et `synchronous_commit=on`. 5 frappes/s/rédacteur, intervalles 180–220 ms, 600 updates après 20 de chauffe ; aucune attente de reçu avant la frappe suivante. Retard de planification p95 : 7,5 ms sans regroupement, 10,3 ms avec. Tous les reçus vérifiés en base, dix documents convergents. Avec lots : 620 reçus / 456 lignes de journal, chauffe comprise. Le ralentissement ne réduit pas volontairement le débit fourni pour masquer la file.

Environnement : Windows 10.0.26300, Ryzen 7 5800H, Node 24.21.0, PostgreSQL 17.11 en conteneur, Yjs 13.6.33 / Hocuspocus 4.7.1. Serveur, clients et worker partagent la machine ; preuve de 12 secondes, sans essai d'endurance ni réseau de production. Séries exécutées séparément. Le seuil initial sur 300 blocs sans gros historique passe encore à **25,868 ms** dans le journal de régression.

## Fichiers à lire en priorité

1. [ADR 017](../adr/017-collaboration-temps-reel.md), section étape 2 bis : arbitrage et limites ; [ARCHITECTURE.md](../../ARCHITECTURE.md) pour 3a/3b/3c.
2. [`server.ts`](../../apps/collab/src/proof/server.ts), [`room-batch-queue.ts`](../../apps/collab/src/proof/room-batch-queue.ts), [`batch-journal.ts`](../../apps/collab/src/proof/batch-journal.ts) : fusion, validation avant commit/application, reçu et droits courants de chaque émetteur. Journal unitaire précédent conservé pour comparaison.
3. [`sized-fixture.ts`](../../apps/collab/src/proof/sized-fixture.ts), [`sizing.ts`](../../apps/collab/src/proof/sizing.ts), [`load.ts`](../../apps/collab/src/proof/load.ts), [`metrics.ts`](../../apps/collab/src/proof/metrics.ts) : génération, chauffe, mesures et files natives comprises.
4. [`transport.ts`](../../apps/collab/src/proof/transport.ts) : douze scénarios réels renforcés, lot multi-auteur commis une fois et lot invalide sans fuite ; [`projection.ts`](../../apps/collab/src/proof/projection.ts) retrouve tous les auteurs via leurs reçus.

## Ce qui pourrait casser

- **Gros historique :** copie et validation complète dominent le coût. Vérifier moins de modèles Zod ne suffit pas ; la proposition incrémentale inclut réplique persistante isolée et index globaux, à prouver avant 3a.
- **Rejet de lot :** toutes ses connexions sont fermées, même si une contribution était valide. Les clients hors lot continuent. Le front devra permettre la reprise sans réinjecter indéfiniment un document invalide.
- **Attribution :** une ligne de journal peut avoir plusieurs contributeurs. L'audit lit leurs reçus, conservés après compaction ; la migration de production formalisera ces métadonnées.
- **Admission :** la file de salle ne borne pas les files natives par connexion. Quotas dès réception, leadership, triggers, HMAC et exploitation automatique restent en 3a.
- Pas d'interface collaborative, présence, WSS Caddy, cache Yjs ou suppression des brouillons dans cette étape. Deux navigateurs seront testables en fin de 3b. Les quotas NAT HTTP restent en session 4 ; le banc utilise des IP de test distinctes et valides.

## Contrôles et reproduction

Les journaux ci-dessous contiennent résumés et codes finaux. Refus d'accès, erreurs de validation et pannes SQL injectées dans la régression sont attendus.

```powershell
pnpm check
pnpm proof:collab
# Mesures A et B, plusieurs minutes, PostgreSQL local et .env requis :
pnpm proof:collab:2bis
# Ou séparément :
pnpm proof:collab:2bis --size
pnpm proof:collab:2bis --size --small
pnpm proof:collab:2bis --load --baseline
pnpm proof:collab:2bis --load --batched
```

Le code 0 des mesures signifie « mesure terminée », pas « cible 50 ms respectée ». Comparer les percentiles et l'échec d'admission des gros profils. Aucun reset applicatif : seuls des schémas PostgreSQL aléatoires de preuve sont créés et supprimés. Pour un contrôle manuel rapide, lancer les deux variantes de charge, comparer la file seconde par seconde et vérifier les 600 confirmations/convergences ; lancer la régression pour les douze scénarios.

Preuves complètes :

- [Tailles 256 Kio, 1 Mio, 4 Mio](session-3-2bis-size.txt) et [200 échantillons par profil](session-3-2bis-size.json).
- [Profil réduit, budget normal](session-3-2bis-small.txt) et [200 échantillons](session-3-2bis-small.json).
- [Charge avant](session-3-2bis-baseline.txt), [mesures et transitions](session-3-2bis-load-baseline.json).
- [Charge après](session-3-2bis-batched.txt), [mesures et transitions](session-3-2bis-load-batched.json).
- [Régression, douze scénarios](session-3-2bis-regression.txt), [échantillons du seuil initial](session-3-2bis-regression-performance.json).
- [Contrôle complet pnpm check](session-3-2bis-check.txt).

Les premières séries de tailles ont un compteur d'affichage de progression décalé de +1 ; tableau brut et résumé contiennent exactement 200 échantillons après 20 de chauffe. Affichage corrigé dans le script livré et la série réduite. Aucun échantillon retiré. Les premières tentatives de génération et d'inscription ont servi à corriger la fixture ; seules les séries complètes alimentent les résultats.

Résultats des contrôles de cette livraison : `pnpm check` terminé avec code 0, **69 tests réussis et 6 tests SQL ignorés**, types des 12 packages et preuve Nest valides. Les 5 nouveaux tests couvrent la mesure des files/percentiles et le regroupement (confirmation après commit, rejet et reprise, capacité bornée). `pnpm proof:collab` termine avec code 0, seuil initial respecté et **12 scénarios réels réussis** ; les mesures A et B terminent toutes avec code 0. Les tests SQL isolés de cette preuve sont exécutés par ses commandes, indépendamment des 6 tests génériques ignorés par Vitest.

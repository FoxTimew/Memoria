# Auto-hébergement — base de dimensionnement après 3a

**Décision produit du 24 octobre 2026 : ce dimensionnement est refusé comme cible.** Les valeurs ci-dessous décrivent l'état transitoire de 3a. L'étape **3d**, obligatoire avant la session 4, doit prouver au moins 30 pages typiques (≤ 200 Kio) ouvertes avec 1 Gio de budget, via réservations proportionnelles et pool partagé de workers. Cible minimale pour toute la pile de 50 personnes : 4 vCPU / 8 Gio. Ce guide sera redimensionné avec les mesures de 3d ; aucune optimisation 3d n'est réalisée dans 3b.

Les chiffres ci-dessous sont les **anciennes propositions extrapolées de 3a, conservées comme historique**, pas des recommandations actuelles ni une certification de charge. Aucune utilisation réelle avant la fin de la session 4 ; le rebasage automatique sur page inoccupée est obligatoire avant une exploitation prolongée.

| Configuration                                                   | CPU                                            | RAM physique | Disque                               | Budget répliques proposé               |
| --------------------------------------------------------------- | ---------------------------------------------- | ------------ | ------------------------------------ | -------------------------------------- |
| Minimale, usage partagé sur quelques pages                      | 4 vCPU modernes à bonnes performances par cœur | 8 Gio        | SSD 100 Gio, marge libre ≥ 25 %      | 1 Gio par défaut : 5 salles résidentes |
| Recommandée pour permettre jusqu'à 50 pages distinctes ouvertes | 8 vCPU modernes                                | 32 Gio       | SSD/NVMe 250 Gio, marge libre ≥ 25 % | 10 Gio : 53 réservations de 192 Mio    |

Une salle peut accueillir plusieurs personnes ; 50 personnes ne signifie pas forcément 50 documents. La recommandation réserve assez de mémoire pour ces documents, **sans prouver le débit de 50 rédacteurs simultanés**. Le plafond de 500 sockets et celui de 20 par utilisateur sont des protections d'admission. Un réglage mémoire trop bas donne un refus explicite d'une nouvelle salle, sans éviction de celles occupées.

Justification de 1 Gio par défaut : marge prudente sur une machine de 8 Gio partagée avec PostgreSQL, Next, Nest, worker et système. Une réservation couvre le validateur (128 + 16 Mio V8), une estimation de l'arbre Hocuspocus (32 Mio) et des buffers (16 Mio), soit 192 Mio. Ce budget d'admission n'est pas une limite RSS globale. Ajouter de la RAM puis ajuster `COLLAB_REPLICA_MEMORY_BYTES` augmente les documents admissibles, pas les performances par update. Le projecteur temporaire et les files réseau sont hors de ce budget ; garder plusieurs Gio de marge et surveiller la RSS réelle, les files et le retard de projection.

Mesures réellement effectuées sur Ryzen 7 5800H, Windows/Node 24.21.0, PostgreSQL 17.11 local en conteneur, fsync et synchronous_commit activés : deux profils proches de 1 Mio, chargement froid et validation/journal, résultats dans la [fiche 3a](reviews/session-3-3a-service.md). La preuve antérieure a retenu 100 répliques historiques dans un seul processus : 1 883 Mio de tas et 99 Mio de buffers, RSS absolue 2 635 Mio. Elle n'incluait pas 100 workers séparés ni les documents vivants Hocuspocus. La série à dix rédacteurs concernait un document plus petit ; elle ne remplace pas une mesure à 50 personnes sur 50 gros documents.

Les capacités CPU/RAM globales, les marges de disque et le nombre de salles conseillé sont **extrapolés**. Le disque proposé ne dimensionne ni les futurs fichiers S3 ni une politique de sauvegarde longue. Prévoir des sauvegardes hors de ce disque et tester leur restauration. Les journaux/reçus/outbox continuent de croître jusqu'à la rétention de session 9 ; une panne de projection peut allonger le journal d'updates. Surveiller espace libre, WAL, plus ancienne projection en retard, retries, réservations, RSS et p95 mesuré sur la machine cible.

PostgreSQL recommande environ 25 % de RAM pour `shared_buffers` sur un serveur **dédié** ; ce pourcentage ne doit pas être appliqué aveuglément à toute la RAM de cet hôte partagé. `work_mem` peut être consommé plusieurs fois par requête/session : laisser une marge pour concurrence et cache système ([documentation PostgreSQL 17](https://www.postgresql.org/docs/17/runtime-config-resource.html)). Les limites de worker V8 ne couvrent pas toute la mémoire externe ni la RSS ([Node 24](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#new-workerfilename-options)).

Avant mise en service, refaire les mesures sur l'hôte prévu, avec authentification forte, deux navigateurs puis la charge attendue, et vérifier que la sauvegarde/restauration couvre snapshot + journal + reçus. Les commandes 3a utilisent des schémas isolés et ne nécessitent pas de réinitialiser les données applicatives :

```powershell
pnpm test:collab:e2e --suite cold
pnpm test:collab:e2e --suite warm
pnpm test:collab:e2e --suite memory
```

Ne pas exécuter les benchmarks simultanément avec un build ou une autre mesure. Ils gardent tous les échantillons après deux chauffes (froid) ou vingt (updates). Un échec du seuil est un résultat à analyser, pas un motif pour filtrer les observations.

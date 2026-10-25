# Auto-hébergement — capacité locale 3d et qualification dédiée à réaliser

## État actuel, 25 octobre 2026

La branche `codex/session-3d-collaboration-capacity` est fusionnée dans main par la PR #4 (`0b8c0f0`) : pool partagé et réservations proportionnelles. **Les critères locaux de 3d passent et la livraison est validée.** La comparaison alternée de la candidate `875c63f` à `665a829`, sans changement applicatif, respecte les plafonds absolus et la marge de 10 %. La forte régression de la campagne non alternée n'est pas reproduite ; les conditions d'exécution ont changé et leur cause exacte n'est pas isolée. Tous les essais, les trois p95 par configuration et les limites sont dans la [fiche 3d](reviews/session-3-3d-capacite.md).

La cible minimale reste **4 vCPU / 8 Gio pour toute la pile de cinquante personnes**. Une qualification sur cet hôte dédié, avec le paquet reproductible et cinquante comptes actifs, est obligatoire avant les premiers utilisateurs réels. Elle est différée faute de serveur disponible. Aucun nouveau dimensionnement recommandé pour cinquante personnes n'est certifié par ces essais du portable.

La candidate réserve une enveloppe par document selon sa taille encodée, historique inclus :

| Taille encodée                      | Réservation par salle |
| ----------------------------------- | --------------------: |
| ≤64 Kio                             |                 8 Mio |
| >64 à 128 Kio                       |                12 Mio |
| >128 à 256 Kio                      |                24 Mio |
| >256 à 512 Kio                      |                64 Mio |
| >512 à 768 Kio                      |               128 Mio |
| >768 Kio, jusqu'à la borne de 1 Mio |               192 Mio |

Le budget inclut aussi **32 Mio par worker** et **128 Mio pour une projection temporaire sérialisée**. Sur ce portable, quatre workers : 30 × 24 + 4 × 32 + 128 = **976 Mio**, dans le défaut de 1 Gio. Sur quatre vCPU, le défaut serait deux workers, soit **912 Mio** pour les mêmes réservations : calcul d'admission, **pas une mesure de charge** sur quatre vCPU. Le défaut utilise la moitié des CPU disponibles, au minimum un et au maximum quatre ; `COLLAB_VALIDATION_WORKERS` accepte un à huit. `COLLAB_REPLICA_MEMORY_BYTES` doit couvrir l'enveloppe fixe et au moins une petite salle. Monter le nombre de workers consomme une part du budget.

Trois séries finales ont réellement ouvert **trente sockets/pages à la fois**, avec deux comptes Better Auth, sur chacun de deux profils d'environ **173 et 172 Kio**, 300 blocs. Les trente écritures sont confirmées et automatiquement projetées, sans déconnexion. Par réplique isolée, tas + mémoire externe retenus après GC : **2,146–2,149 Mio (contenu, facteur 12,7)** et **3,367–3,379 Mio (historique, facteur 20,1)**. À 1 Mio, la preuve antérieure donnait environ 4,6 / 19,9 Mio par réplique. Les classes extrapolent ces expansions avec une marge pour l'arbre vivant, les index, candidats, copies et GC ; **les bornes intermédiaires ne sont pas toutes mesurées**. Les 32 Mio fixes par worker couvrent une base observée d'environ 14,4 Mio de tas/externe, plus une marge de file/runtime. La réserve du projecteur est prudente, pas un maximum démontré sur tout journal possible.

RSS maximale échantillonnée du banc, trois séries : contenu **560,45 / 562,01 / 558,73 Mio**, historique **749,59 / 738,34 / 739,25 Mio** (médianes 560,45 / 739,25). Clients simulés, générateur de fixtures et authentification sont inclus dans le même processus. Ce n'est ni la RSS du serveur seul ni celle de toute la pile. Le budget est une comptabilité d'admission, **pas un plafond RSS système**. Les workers ont une limite V8 de 256 Mio de vieille génération et 16 Mio de jeune génération ; les buffers et la mémoire native ne sont pas couverts par ce plafond. Un gros budget personnalisé doit être requalifié, y compris ces limites et la répartition des répliques.

Une salle sans connexion est déchargée après cinq minutes (`COLLAB_REPLICA_IDLE_MS`) ou plus tôt si une nouvelle réservation manque de place. Les salles actives restent présentes ; ouverture ou croissance refusée explicitement si aucune place ne peut être libérée. Les commandes hors éditeur demandent temporairement une réservation entière : elles peuvent être refusées sous forte pression, même pour une petite modification. Une panne de worker ferme ses connexions et recharge les répliques depuis PostgreSQL ; le client se reconnecte. La qualification couvre une terminaison réelle d'un worker, pas un véritable épuisement de RAM de la machine.

**Trente pages sont prouvées pour ces deux profils sur le portable, pas pour toutes les structures admissibles ni pour la pile complète.** Le code applicatif est identique à celui des tests réels de panne/reprise PostgreSQL. Le rebasage automatique sur page inoccupée reste obligatoire avant utilisation prolongée, et n'est pas activé ici. Les très longs journaux SQL, le disque, le WAL, la rétention et les sauvegardes restent à dimensionner avec la charge complète.

Pour reproduire les performances avec les fixtures du paquet : `node scripts/compare-collab.mjs --reference 665a829 --candidate 875c63f`. Pour les trois séries de capacité : `node scripts/measure-collab.mjs --label capacity --suite capacity`. Depuis le 25 octobre, le [protocole courant](../ARCHITECTURE.md#protocole-de-mesure-de-performance--règle-du-25-octobre-2026) impose le secteur : contrôle seul par `node scripts/measurement-power.mjs`, puis relevé BatteryStatus strictement égal à 2 avant chaque série, sinon refus. Garder aussi au moins 3 Gio libres avant chaque série et aucun build/test concurrent. Les anciens relevés d'alimentation diffèrent de la première campagne ; ne pas extrapoler ces temps à un portable dans un autre mode ni à un serveur non mesuré. Avant utilisateurs réels, exécuter les mêmes profils sur l'hôte dédié de 4 vCPU / 8 Gio, puis la charge complète à cinquante comptes ; publier CPU, RAM, disque, configuration PostgreSQL et tous les résultats. Un hôte sans sonde Windows exigera une adaptation explicite du contrôle d'alimentation, pas une exemption silencieuse.

## Historique 3a et diagnostic préalable

Contrôle préalable 3d du 24 octobre : [mesures et diagnostic](reviews/session-3-3d-diagnostic.md). Les seuils du profil historique de 1 Mio ne sont pas reproduits sur la machine actuelle, y compris sur main. Le premier pool expérimental est arrêté ; aucune nouvelle capacité mémoire n'est revendiquée. La borne de 1 Mio et les objectifs restent inchangés pendant l'analyse autorisée.

Après optimisations SQL et reconstruction : [fiche et journaux complets](reviews/session-3-3d-optimisations.md). Sur le portable Windows **sur batterie**, p95 contenu/historique 16,16 / **55,68 ms par update**, 296,24 / 438,81 ms à froid. Le froid passe ; l'update historique échoue encore. Ce matériel et ces conditions ne qualifient pas un serveur de 4 vCPU / 8 Gio. Aucun pool ni capacité de trente pages validé ; refaire les mêmes mesures sur l'hôte cible avant toute conclusion de dimensionnement. Les profils de 1 Mio ne prouvent pas la charge de cinquante personnes.

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

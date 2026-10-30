# 7d — reprise de campagne et arrêt au plafond d'une page typique

30 octobre 2026. **7d non clôturée, aucune optimisation ni modification de plafond.** Code du banc et du produit : `4f285a0fc129f410ce00e0267d00b85ed6b79b16`. Ce point ajoute le test du front inactif et publie les mesures ; il ne change pas le service collaboratif.

## Résultat et arrêt

Les trois séries du profil contenu passent, avec et sans conversions. La **deuxième série historique avec conversions** échoue : page typique d'index 2, **175 992 octets encodés**, p95 validation/transaction **53,955 ms**, plafond **<50 ms**. Le reçu WSS de cette page reste conforme à **114,023 ms**, application chez l'autre rédacteur à **115,701 ms**. La page historique de 1 Mio reste sous son plafond serveur de 100 ms à **67,162 ms** ; son WSS de **347,963 ms** est un indicateur surveillé, pas la cause de l'arrêt.

Le banc s'arrête avant les deux dernières séries. **Dix séries mesurées, neuf conformes et une en échec**, 10 000 contributions mesurées ; convergence vérifiée pour chaque paire, aucun événement de fermeture, aucun client marqué déconnecté. Tous les relevés d'hygiène sont valides : cela valide la mesure, pas le résultat applicatif de la série en échec. Aucun benchmark supplémentaire lancé après ce dépassement.

## Trois séries du contenu

Dix comptes/processus WSS séparés, deux rédacteurs par page ; une page de 1 Mio et quatre pages ≤200 Kio, budget de répliques par défaut 1 Gio. Dix vagues d'échauffement puis cent vagues à cadence inchangée. P95 ci-dessous sur la **page principale**, en millisecondes. Les maxima des quatre autres pages sont également contrôlés séparément ; aucun dépassement pour ce profil.

| Charge              | Serveur, séries 1 / 2 / 3 | Médiane | Reçu WSS, séries 1 / 2 / 3 | Médiane | Autre client, séries 1 / 2 / 3 | Médiane |
| ------------------- | ------------------------- | ------- | -------------------------- | ------- | ------------------------------ | ------- |
| Sans conversion     | 17,950 / 16,557 / 16,691  | 16,691  | 41,966 / 39,054 / 38,754   | 39,054  | 42,928 / 38,946 / 38,732       | 38,946  |
| Avec conversions 8K | 20,557 / 17,944 / 17,779  | 17,944  | 47,889 / 42,260 / 41,382   | 42,260  | 47,855 / 42,699 / 41,537       | 42,699  |

La réception chez l'autre client est observée à l'application Yjs, avec calibration et incertitude d'horloge conservées par échantillon. Ce n'est pas la peinture de l'interface React. La comparaison avec/sans conversion **n'est pas** la comparaison alternée avec main, qui reste à faire sur la candidate finale.

## Historique : résultats partiels conservés

Pas de médiane de trois séries annoncée : la troisième répétition n'a pas été lancée. Les pages typiques de ce profil contiennent elles aussi de l'historique, mais leur plafond reste 50 ms ; l'exception de 100 ms est réservée à la page historique de 1 Mio.

| Série / conversions | Serveur page 1 Mio | Reçu WSS page 1 Mio | Application autre client | Plus grand p95 serveur des pages typiques | Résultat  |
| ------------------- | ------------------ | ------------------- | ------------------------ | ----------------------------------------- | --------- |
| 1 / sans            | 51,258             | 316,173             | 356,099                  | 32,133                                    | Conforme  |
| 1 / avec            | 67,702             | 345,575             | 392,903                  | 40,190                                    | Conforme  |
| 2 / sans            | 51,795             | 257,516             | 290,988                  | 30,896                                    | Conforme  |
| 2 / avec            | 67,162             | 347,963             | 394,630                  | **53,955**                                | **Arrêt** |

## Diagnostic à partir des traces existantes

La page en échec comporte 200 contributions mesurées. Une trace appariée proche du p95 donne **53,936 ms** : **36,465 ms** entre départ de validation et appel SQL, puis **17,471 ms** de transaction. La légère différence avec le compteur par lot (53,955 ms) vient des points de chronométrage et du regroupement. Ce sont les composantes d'un même échantillon, pas une addition de p95 indépendants. Douze contributions dépassent 50 ms sur cette décomposition ; plusieurs ont 31 à 74 ms dans la première portion.

Cette première portion inclut l'attente du pool, l'IPC, le travail du worker et la reprise de la boucle Node. La durée SQL est aussi une durée murale côté Node. **Les traces ne permettent pas encore de séparer CPU, ordonnancement et attente de verrou PostgreSQL.** Elles ne démontrent pas le retour de la contention du registre fichiers corrigée en 7a ; ce scénario ne change aucune référence de fichier. Aucun profil CPU ou nouveau benchmark n'a été lancé après l'arrêt.

Les renouvellements de leadership ralentissent ponctuellement (jusqu'à 810 ms observés pendant la première série historique avec conversions), sans échec de contrôle. Les fins de connexion de contrôle dans les journaux correspondent au nettoyage. **Aucun `CONTROL_UNAVAILABLE` ni code client 1005 pendant les écritures.** Cette campagne ne résout donc pas les fermetures serveur de 7a et ne remplace pas la saturation volontaire avec le vrai front.

**Suite recommandée, à autoriser :** profiler le partage des workers et la boucle principale pendant ce scénario, avec temps CPU du worker, attente de file/IPC et attentes PostgreSQL appariées ; présenter la cause avant une correction ciblée. Conserver tous les contrôles et plafonds. Autre possibilité, uniquement sur décision du développeur : revoir explicitement le plafond de ce scénario ; le seul dépassement mesuré ici est de **3,955 ms (7,9 %)**, mais deux séries ne justifient ni une dérogation automatique ni une garantie de marge future. Le plafond WSS conforme ne remplace pas celui du serveur.

## Conditions, conversions et preuves

Avant chaque préparation : Windows **3,958 à 4,440 Gio libres**. Après préparation : Windows **2,614 à 3,144 Gio**, WSL MemAvailable **5,543 à 5,647 Gio**. BatteryStatus=2 à chaque contrôle ; `vmstat si/so` et deltas de compteurs swap nuls pour toutes les séries. Aucun build ni autre test en parallèle. Le test du front inactif s'est terminé avant le lancement de cette campagne.

Chaque série avec conversions prouve le chevauchement des textures uniforme et bruitée 8 192² avec la saisie. Convertisseur final `sha256:a81a1233e3149456572289790c91cc8528553f1ebb90a39f91443746dfd486d6`, concurrence un, 1 CPU, 512 Mio, réseau interdit. Dix-huit conversions terminées au total ; maximum de conversion **16,730 s**, pic cgroup maximal **117,367 Mio**. Les uniformes et bruits synthétiques ne couvrent pas tous les formats d'un studio. Les gros téléversements ne sont pas encore ajoutés à ce palier.

Deux refus précédant la campagne sont conservés : PostgreSQL arrêté (avant mesure), puis Windows 2,642 Gio libres après redémarrage de Docker. PostgreSQL et Caddy ont été redémarrés avec autorisation explicite ; aucun volume supprimé. Après libération confirmée de mémoire, la campagne ci-dessus s'est déroulée jusqu'au plafond. Nettoyage vérifié : aucun processus ni conteneur de ce banc restant actif ; les deux services de développement restent démarrés.

Rapports complets, échantillons, journaux, `vmstat` et empreintes : [manifeste](evidence/session-7-7d-reprise-campagne/manifest.json). Les fichiers volumineux sont compressés sans perte. [Synthèse dérivée](evidence/session-7-7d-reprise-campagne/summary.json) ; les données brutes priment.

Contrôles de ce point : `pnpm check` complet réussi (hooks, lint/format, types, bootstrap Nest, **187 tests réussis et six SQL ignorés**, 40 fichiers de tests réussis). Les intégrations SQL ne sont pas relancées : aucun code applicatif ni SQL modifié. Le test navigateur permanent est exécuté séparément, **un test réussi**. [Journal complet de check](evidence/session-7-7d-reprise-campagne/check.txt.gz). Aucun hook contourné ; le pré-push doit également réussir avant publication.

## Relecture et guide

Lire d'abord cette fiche, [le test du front inactif](session-7-7d-front-inactif.md), puis [le banc](../../apps/collab/src/testing/files-mixed.e2e.ts) et [l'instrumentation](../../apps/collab/src/testing/file-load-trace.ts). Le banc n'a pas été modifié dans ce point.

Pour le parcours manuel, suivre le [guide consolidé](session-7-guide-manuel.md), avec cinq minutes supplémentaires d'inactivité seul sur une page. Le test automatisé `pnpm test:collab:idle:browser` passe sur le vrai front. **Ne pas relancer la campagne de performance avant arbitrage** : l'arrêt est maintenu, sans optimisation ni hausse de seuil.

Ce qui reste ouvert : diagnostic/correction autorisée et trois répétitions historiques complètes, gros transferts et mémoire, charge NAT, saturation CPU volontaire et reprise du vrai front sans perte, comparaison finale avec main, puis consolidation finale des risques et de la PR. Aucun risque accepté ; la session 7 ne peut pas encore être déclarée prête à fusionner.

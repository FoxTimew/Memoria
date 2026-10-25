# Auto-hébergement — capacité locale 3d et qualification dédiée à réaliser

## Secret d'authentification et TOTP — sauvegarde indispensable

**`BETTER_AUTH_SECRET` chiffre les secrets TOTP dans PostgreSQL. Sauvegardez-le hors du serveur**, dans un coffre protégé avec accès restreint, en complément de la sauvegarde de la base. Ne le commitez pas et ne l'inscrivez pas dans les journaux. Une sauvegarde SQL seule ne suffit pas : **la perte de ce secret rend les TOTP enregistrés inutilisables**. Générer une nouvelle valeur ne permet pas de déchiffrer les anciennes données.

Conservez la valeur correspondant à chaque sauvegarde et testez une restauration isolée avec cette même valeur. La remplacer invalide aussi des éléments d'authentification signés ; ne faites pas de rotation improvisée. Les parcours de récupération par code et commande d’administration sont livrés en 4c, décrits ci-dessous. Une passkey de secours préalablement enregistrée reste un autre facteur ; elle ne remplace pas la sauvegarde des secrets d'exploitation.

Après déploiement 4c : appliquer `pnpm db:migrate` (0011–0013 après 0009/0010), reconstruire puis redémarrer API, collab, worker et web ensemble. Le worker doit recevoir la même origine HTTPS, le même BETTER_AUTH_SECRET et la configuration SMTP que l’API. Aucun reset des données n'est nécessaire. Les réglages de connexion forte sont accessibles dans **Sécurité de l’espace** ; voir le [guide de test 4b](reviews/session-4-4b-politique-actions.md).

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

## Quotas d'authentification 4d

Les limites NAT, compte et email actives en 4d sont décrites dans l'[ADR 015](adr/015-authentification-simple-et-workspaces.md#4d--quotas-et-admission-exécutés). Appliquer `pnpm db:migrate` puis reconstruire/redémarrer API et worker ensemble ; le schéma de quotas est nécessaire au handler d'authentification. Le renvoi de vérification passe désormais lui aussi par le worker : une API disponible ne garantit pas qu'un email a été livré.

Valeurs configurables d'envoi : `AUTH_EMAIL_MAX_15M=3`, `AUTH_EMAIL_MAX_DAY=10`, par adresse et type. `AUTH_COUNTER_RETENTION_HOURS=24` purge les compteurs inactifs ; le worker vérifie chaque minute. Configurer les mêmes valeurs et le même `BETTER_AUTH_SECRET` sur toutes les instances. Le secret sert aussi à l'empreinte HMAC des clés de limitation ; le changer remet indirectement les budgets à zéro, sans effacer immédiatement les anciens compteurs. Ne pas le changer pour débloquer une connexion.

Pour surveiller sans afficher email/IP : `SELECT action,count(*) FROM auth_security_events WHERE action='account_throttle_threshold' AND created_at>now()-interval '1 hour' GROUP BY action;` et `SELECT count(*) AS admitted,count(*) FILTER(WHERE started_at IS NOT NULL) AS active FROM auth_attempt_leases WHERE expires_at>now();`. Plafonds : 128 admissions globales, huit vérifications actives, huit admissions par compte/famille. Un 429 de capacité signifie qu'il faut réessayer ; une nouvelle tentative n'a aucune priorité sous saturation. Un délai déjà annoncé/admis ne peut pas être repoussé par de nouveaux échecs. Le worker arrêté laisse les compteurs inactifs en base, mais l'expiration des fenêtres continue à être appliquée par l'API.

Si aucun email n'arrive après plusieurs demandes, utiliser un lien reçu encore valide ou attendre la fenêtre d'envoi ; la réponse publique reste volontairement identique. Une notification limitée n'annule pas un changement de sécurité : consulter l'audit. Pour réémettre un lien opérateur, respecter aussi son budget propre ; un reset de mot de passe invalide les autorisations opérateur précédentes. Le [guide manuel 4d](reviews/session-4-4d-quotas.md) permet de reproduire les scénarios NAT et délais.

## Récupération 4c — procédure opérateur

Le propriétaire d'un workspace ne possède pas ce pouvoir. La commande s'exécute sur l'installation par un exploitant ayant accès à PostgreSQL et au secret. **L'ingénierie sociale envers l'exploitant est le principal risque de cette commande** : un imposteur pourrait faire retirer les facteurs de sa victime.

Avant toute exécution, vérifier l'identité **en personne ou en visioconférence**, par un échange direct avec la personne connue du studio. **Un simple message ou email ne suffit jamais**, même envoyé depuis son adresse habituelle. Quand c'est possible, demander une confirmation indépendante à un second membre du studio qui connaît cette personne. Si l'identité ne peut pas être établie, ne pas exécuter la commande et organiser cette vérification. Confirmer ensuite le compte exact, le facteur perdu et la disponibilité des sauvegardes. Ne demander ni mot de passe ni code de secours.

Le motif opérateur décrit uniquement l'action et le contrôle effectué, **sans donnée personnelle** : par exemple « Facteur perdu ; identité vérifiée en visio ; confirmation indépendante obtenue ». Ne pas y inscrire nom, email, numéro de document, capture de visio ou secret ; le compte est déjà référencé par son UUID dans l'audit. Cette procédure ne protège pas contre un administrateur système malveillant.

1. Confirmer SMTP et le worker : la sonde `/api/health/worker` confirme PostgreSQL/processus, **pas la livraison SMTP**. Vérifier un email de test et surveiller auth_mail_retry/auth_mail_abandoned dans les journaux du worker ; ils ne contiennent que l'UUID du job et le compteur. La file est chiffrée avec BETTER_AUTH_SECRET. Ne pas l'imprimer pour récupérer un lien.
2. Relever l'UUID exact dans la base : `SELECT id,email FROM auth_users WHERE lower(email)=lower('personne@example.org');`. Confirmer l'identité et l'adresse de résultat. Il n'existe pas de recherche approximative par nom dans la commande.
3. Depuis la racine du dépôt avec .env correct, simuler pour voir les identifiants des facteurs (aucune mutation) :

```sh
pnpm admin:reset-factor --user-id UUID --factor all --reason "Perte signalée et identité contrôlée" --operator "identifiant-exploitant"
```

4. Choisir le **facteur précis** : `totp` ou `passkey:UUID-DU-FACTEUR`. Refaire la simulation avec cette cible. Puis appliquer :

```sh
pnpm admin:reset-factor --user-id UUID --factor totp --reason "Application de codes perdue, identité contrôlée" --operator "identifiant-exploitant" --apply --confirm UUID
```

Le script reconstruit l'exécutable avant de le lancer ; Node 24, pnpm et les dépendances de build sont requis dans ce mode. Pour un artefact déjà construit, exécuter `node --env-file=.env apps/worker/dist/reset-factor.mjs` avec les mêmes arguments. Aucun mot de passe/jeton dans la ligne de commande. Le résultat comporte compte/cible/facteurs et mode simulation/applied ; aucune autorisation de connexion n'est affichée. L'UUID après --confirm doit être exactement celui après --user-id. Aucun facteur par défaut : oubli ou mauvaise cible refusé.

5. Le compte reçoit un lien de rétablissement valable trente minutes ; il doit saisir son **propre mot de passe**, puis configurer un nouveau facteur dans la session limitée à quinze minutes. Terminer remplace les codes de secours ; une nouvelle vérification avec ce facteur est encore nécessaire. Toutes les anciennes sessions sont fermées, y compris les sockets en ligne ; les autres facteurs, rôles, pages et politiques sont conservés. Un ancien facteur encore disponible peut aussi servir à se reconnecter fortement.
6. Si tous les facteurs sont perdus, remplacer **explicitement** la cible par `all`, simuler puis appliquer avec confirmation. Un mot de passe simple ne permet pas d'ouvrir les pages ou d'enrôler librement après ce reset. Si l'email a expiré après reset total, répéter all avec un nouveau motif réémet une autorisation (audit operator_recovery_reissued). Avec un facteur survivant, le propriétaire du compte peut se reconnecter avec lui ; pour réémettre en retirant ce facteur, une nouvelle décision de reset ciblé/all est nécessaire. Ne pas effacer le drapeau recoveryRequired manuellement.
7. Si le mot de passe est également perdu, commencer par « Mot de passe ou facteur perdu ? » → reset email, puis lancer la commande : le reset invalide les autorisations opérateur antérieures. Si SMTP est indisponible, réparer SMTP/worker puis réémettre ; aucune connexion forte de secours n'est produite.

Auditer sans secrets : `SELECT created_at,user_id,action,operator,reason,target FROM auth_security_events WHERE user_id='UUID' ORDER BY created_at DESC;`. Rétention cible 90 jours selon ADR 012, job de purge général encore à livrer. L'UUID utilisateur devient NULL à suppression ; motifs/opérateurs sont des champs libres d'exploitation et ne doivent pas contenir de données du titulaire. La revue RGPD de leur conservation/anonymisation accompagne le job général. Les jobs de mail personnels liés au compte sont supprimés par cascade ; les demandes publiques non résolues expirent sous trente minutes au prochain passage du worker.

Le worker délivre au moins une fois : une panne entre SMTP et commit peut produire un doublon. Aucun doublon ne permet de réutiliser un jeton. Six essais, backoff et expiration ; incidents à surveiller. Pas de promesse d'effacement du cache d'un navigateur hors ligne lors d'un reset distant ; reconnexion refusée et nettoyage au retour selon la frontière de cache, renforcée en 4e.

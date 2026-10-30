# Auto-hébergement — capacité locale 3d et qualification dédiée à réaliser

## Avant toute offre SaaS publique

Le MVP auto-hébergé conserve une limite de disponibilité : une attaque soutenue peut occuper les huit réservations de connexion par mot de passe d'un compte. Passkey et récupération restent les recours. Le développeur prévoit d'accepter ce risque pour ce MVP ; il reste explicitement inscrit dans la revue 4f.

Avant toute offre publique, ajouter une file réservée aux appareils reconnus par cookie protégé, selon la [proposition OWASP](https://community.owasp.org/Slow_Down_Online_Guessing_Attacks_with_Device_Cookies), ainsi qu'une protection en amont contre la saturation globale (WAF ou équivalent). Documenter alors les seuils, la conservation de l'adresse client depuis le proxy de confiance, la surveillance et la conduite à tenir en cas d'attaque. Ces protections ne sont pas livrées en 4e et ne remplacent jamais la vérification des facteurs.

## Copies locales — livraison 4e

Appliquer `pnpm db:migrate` avant de démarrer cette version (colonne additive `allow_persistent_cache`, autorisée par défaut). Le navigateur met IndexedDB à niveau à l'ouverture ; un ancien client qui demande la version 1 ne peut plus rouvrir cette base. Si une connexion IndexedDB ancienne bloque la mise à niveau, fermer cet ancien onglet puis réessayer. Aucun reset des données serveur n'est demandé.

Sur un poste commun, cocher « Poste partagé » à la connexion puis confirmer l'effacement des anciennes copies de ce compte. Avant de confirmer, synchroniser ou exporter le travail hors ligne des autres onglets. Le propriétaire peut aussi interdire les copies locales dans « Sécurité de l'espace », après vérification forte récente. Cette règle s'applique aussi à lui. L'éditeur reste utilisable en mémoire, mais fermer un onglet hors ligne perd ses modifications non envoyées. Après réautorisation, rouvrir la page pour réactiver sa copie locale.

Les onglets actifs consultent la politique toutes les quatre secondes ; une décision est partagée entre onglets. Un ordinateur déconnecté ou suspendu ne peut être effacé à distance immédiatement. Les copies sont purgées à réception ; tout nouvel accès après rechargement nécessite un contrôle en ligne. Les marqueurs sans contenu restent pour neutraliser les anciens onglets. Pour nettoyer un poste, terminer par la déconnexion explicite et vérifier son succès. Une erreur de nettoyage ne signifie jamais que le poste est propre.

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

Les capacités CPU/RAM globales, les marges de disque et le nombre de salles conseillé sont **extrapolés**. Le disque proposé ne dimensionne ni les futurs fichiers S3 ni une politique de sauvegarde longue. Prévoir des sauvegardes hors de ce disque et tester leur restauration. Les journaux/reçus/outbox continuent de croître jusqu’à la mise en œuvre de la rétention obligatoire avant le pilote (Liste pré-pilote d’ARCHITECTURE.md) ; une panne de projection peut allonger le journal d'updates. Surveiller espace libre, WAL, plus ancienne projection en retard, retries, réservations, RSS et p95 mesuré sur la machine cible.

PostgreSQL recommande environ 25 % de RAM pour `shared_buffers` sur un serveur **dédié** ; ce pourcentage ne doit pas être appliqué aveuglément à toute la RAM de cet hôte partagé. `work_mem` peut être consommé plusieurs fois par requête/session : laisser une marge pour concurrence et cache système ([documentation PostgreSQL 17](https://www.postgresql.org/docs/17/runtime-config-resource.html)). Les limites de worker V8 ne couvrent pas toute la mémoire externe ni la RSS ([Node 24](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#new-workerfilename-options)).

Avant mise en service, refaire les mesures sur l'hôte prévu, avec authentification forte, deux navigateurs puis la charge attendue, et vérifier que la sauvegarde/restauration couvre snapshot + journal + reçus. Les commandes 3a utilisent des schémas isolés et ne nécessitent pas de réinitialiser les données applicatives :

```powershell
pnpm test:collab:e2e --suite cold
pnpm test:collab:e2e --suite warm
pnpm test:collab:e2e --suite memory
```

Ne pas exécuter les benchmarks simultanément avec un build ou une autre mesure. Ils gardent tous les échantillons après deux chauffes (froid) ou vingt (updates). Un échec du seuil est un résultat à analyser, pas un motif pour filtrer les observations.

## Invitations et membres 5b

Appliquer `pnpm db:migrate` (migration 0018), puis reconstruire et redémarrer API, worker et front. Aucun reset de données. SMTP reste requis en production ; Mailpit sert au développement. Le worker partage `BETTER_AUTH_SECRET` avec l'API pour lire la file chiffrée. La [fiche 5b](reviews/session-5-5b-invitations.md) décrit les tests à deux comptes et les chemins d'interface.

| Variable                            | Défaut | Règle                                                                 |
| ----------------------------------- | ------ | --------------------------------------------------------------------- |
| `INVITATION_VALIDITY_DAYS`          | 7      | entier 1–30 ; appliqué aux nouvelles invitations/renvois              |
| `INVITATION_RETENTION_DAYS`         | 30     | entier positif ; délai après clôture, non prolongé par SMTP           |
| `INVITATION_MAIL_TTL_HOURS`         | 24     | entier 1–24 ; jamais au-delà de l'expiration de l'invitation          |
| `WORKSPACE_MAX_MEMBERS`             | 100    | tous les rôles, guests compris                                        |
| `WORKSPACE_MAX_PENDING_INVITATIONS` | 500    | compte sous verrou, invitations expirées exclues                      |
| `GUEST_MAX_SHARED_ROOTS`            | 100    | plafond de grants pour un guest ; une invitation en décrit au plus 20 |
| `WORKSPACE_MAX_SHARES`              | 5000   | grants actifs par workspace                                           |

Configurer les mêmes valeurs dans API et worker. Les quotas HTTP de l'ADR 018 sont fixes ; les budgets email reprennent `AUTH_EMAIL_MAX_15M=3` et `AUTH_EMAIL_MAX_DAY=10` avec le type séparé `invitation`. Une page de liste contient 50 éléments, au plus 100 via API. Ces bornes ne sont pas une preuve de capacité sous charge.

Dans « Membres et invitations », lire l'état d'envoi. Après « Envoi en attente », actualiser la page pour voir le dernier état ; une invitation déjà affichée n'est pas surveillée par polling. Six essais SMTP au maximum, backoff, puis « Envoi échoué » ; le lien reste copiable jusqu'à son expiration. « Renvoyer » produit un **nouveau** lien et invalide l'ancien, sous les mêmes budgets. La copie seule ne consomme pas d'email. Le lien exige toujours le compte destinataire vérifié ; aucun secret de connexion n'est communiqué à l'admin. Un email reçu après annulation n'accorde pas de droits. Des doublons SMTP restent possibles entre livraison et commit.

Le worker expire et purge les invitations chaque minute ; l'API contrôle l'expiration même si le worker est arrêté. Une purge en retard conserve les données plus longtemps sans réactiver les liens. La FK des intentions de partage garde leur page jusqu'à la purge de l'invitation : la purge définitive des pages, obligatoire avant le pilote, doit respecter cet ordre (annuler/retirer les intentions concernées). Les invitations terminales antérieures à 0018 reçoivent leur ancienne `updated_at` comme date de clôture. La rétention/anonymisation globale reste au programme RGPD R13.

Pour reproduire les preuves : `pnpm test:invitations:atomicity`, `pnpm test:invitations:e2e` (schémas temporaires), puis `pnpm test:invitations:browser` (Caddy HTTPS, certificat approuvé, worker/Mailpit et deux comptes temporaires nettoyés). Le navigateur utilise une passkey virtuelle, pas le matériel du studio. Ne pas utiliser les scripts de fixtures de développement pour gérer des membres en production.

## Quotas d'authentification 4d — configuration

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

## Bases de données — réglages de déploiement

Les [bornes des bases](database-deployment.md) sont configurables par environnement, avec les défauts validés de 10 000 lignes/base et 50 000/workspace. Toute hausse exige une mesure préalable au nouveau volume. Le [suivi 6a](reviews/session-6-6a-optimisation-barrieres.md) lève le premier arrêt de performance des barrières ; la session reste incomplète, à ne pas déployer sur les données de travail avant qualification et procédure coordonnée définitives.

6b ajoute la migration **0027** : compteurs d'objets, reçus de création (24 h), index de recherche des lignes et fenêtres d'événements. Appliquer les migrations puis démarrer les versions correspondantes de l'API, de collab et du worker ; aucune réinitialisation de données. Les compteurs et textes existants sont amorcés, pas les événements historiques. La file d'événements est indépendante de SMTP ; surveiller `database_row_changes.first_dirty_at` et les reprises de projection. Une projection en erreur peut retarder l'événement d'une ligne, sans perdre sa modification. Le worker n'expédie pas encore ces événements à des services externes.

Sur le poste Windows où Turbo est bloqué, `pnpm check` et les hooks utilisent le typage récursif autorisé. Pour construire les serveurs sans Turbo : `node scripts/build-server.mjs api`, `node scripts/build-server.mjs worker`, `node scripts/build-collab.mjs`. L'interface de bases n'est pas livrée avant 6c ; la [fiche 6b](reviews/session-6-6b-services.md) et son guide indiquent les opérations de test disponibles.

## Fichiers — cadrage de session 7, 28 octobre 2026

### Stockage local RustFS — décision du 29 octobre 2026

RustFS **officiel 1.0.4**, digest `sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2`, remplace MinIO dans le démarrage par défaut et devient le fournisseur à qualifier en production. Le [comparatif](reviews/session-7-7a-decision-stockage.md) conserve licences, sources datées et résultats. Le fork SeaweedFS reste une fixture temporaire et **ne sera jamais déployé en production**. Aucun fournisseur n'est encore déclaré qualifié pour les gros volumes, crashs et restaurations.

Pour un poste de développement existant : `pnpm storage:local`, `docker compose stop minio`, `docker compose up -d rustfs caddy`, `pnpm storage:init`, puis recharger Caddy. Pour un nouveau clone : `pnpm env:init`, démarrer l'infrastructure, puis `pnpm storage:init`. Le volume MinIO reste conservé ; il n'est ni copié ni supprimé. RustFS utilise un nouveau volume, donc ce changement n'est **pas une migration de données de production**. Les fixtures de conformité sont séparées des deux volumes. MinIO n'est accessible qu'avec le profil Compose `conformance`, sur les ports locaux 19001/19002.

L'initialisation crée un bucket privé et un CORS exact pour `APP_ORIGIN`. `S3_ENDPOINT` est interne (`http://127.0.0.1:9000` pour les processus locaux), `S3_PUBLIC_ENDPOINT=https://uploads.localhost:9443` signe les URL navigateur. Les clés viennent de `.env`, jamais du front. Le [conteneur officiel](https://docs.rustfs.com/en/installation/container/docker) utilise ici un volume nommé, sans console publique. Caddy accepte seulement POST/PUT/OPTIONS sur l'hôte d'upload ; GET/list/complete/delete sont refusés. Il borne le corps à 32 Mio + 64 Kio et sa durée à 120 s ([option Caddy](https://caddyserver.com/docs/caddyfile/options#timeouts)). Cette borne est liée au délai de collecte : ne pas exposer le port S3 directement en production ni relever le délai sans adapter le GC. Limitation réseau globale supplémentaire et mesure de charge restent à qualifier en 7d.

**Mise à jour du fournisseur :** avant tout changement de tag/digest, exécuter `pnpm test:storage:rustfs` sur l'image candidate en conservant les 23 assertions, puis versionner manifeste/image et rapport complet. Mettre à jour le témoin accepté par `scripts/storage-provider.test.mjs` seulement si **23/23 passent**. Conserver les contrôles MinIO, Garage et SeaweedFS, notamment le témoin rouge officiel. `pnpm check` refuse un digest Compose qui n'a pas cette preuve. Ne pas utiliser `latest`.

**Repli :** en cas d'échec RustFS à la qualification, SeaweedFS officiel après acceptation amont du correctif, ou reçus des parties dans PostgreSQL. La conception par reçus est obligatoire avant toute offre SaaS **ou changement de fournisseur** ; elle ne dispense pas de vérifier les octets finaux. Les plans actuels restent dépendants du listing S3. Le développeur publie lui-même l'issue et la PR amont préparées dans `.local/seaweedfs-upstream/`.

Migration 0032 puis API/worker de la même version : les six routes d'intention sont authentifiées, limitées et réservées à l'éditeur de la page/ligne propriétaire. Le worker finalise en streaming vers une clé immuable et laisse l'état `validating` pour 7b. Aucun fichier n'est encore servi au public. Configurer les mêmes `FILES_*` dans API, collab et worker ; `FILES_COPY_BYTES=21474836480` borne les copies temporaires, en plus du staging et des quotas métier. `ORPHAN_FILE_RETENTION_HOURS=24`, `TRASH_RETENTION_DAYS=30`. Les rejets restent retenus 24 h ; une annulation explicite peut être collectée après expiration des capacités. Le quota reste réservé jusqu'à la suppression confirmée. Après huit erreurs de finalisation, surveiller `attempts`/`last_error` et faire réessayer explicitement la commande `complete` ; ne jamais modifier les compteurs à la main.

### Capacité globale et rapprochement — clôture 7a, 29 octobre 2026

Configurer les mêmes plafonds dans API, worker et collab, **avant** d'admettre des fichiers. Ce sont des réservations logiques, pas une détection de l'espace libre du fournisseur :

| Réglage                | Défaut                    | Ce qu'il réserve                                                                                                                                                                                          |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FILES_STAGING_BYTES`  | 68 719 476 736 (64 Gio)   | Taille déclarée des intentions dont le staging n'est pas confirmé nettoyé, même avant réception des octets. Permet la future campagne de dix fichiers de 5 Gio avec marge ; ce n'est pas un débit mesuré. |
| `FILES_COPY_BYTES`     | 21 474 836 480 (20 Gio)   | Copies temporaires non supprimées, y compris réponses perdues ; la copie finale vérifiée est déjà couverte par la réserve métier.                                                                         |
| `FILES_CAPACITY_BYTES` | 536 870 912 000 (500 Gio) | Somme des réserves métier (originaux et budget de dérivés), du staging et des copies temporaires, pour **tous** les workspaces.                                                                           |

500 Gio laisse de la marge par rapport au quota métier initial de 250 Gio d'un workspace, sans promettre deux workspaces pleins ni un dimensionnement physique de 500 Gio. **Abaisser ce réglage à la capacité réellement allouée**, après déduction des marges fournisseur, PG/WAL et système ; sauvegardes séparées. Surveiller l'espace libre du volume RustFS : le protocole S3 ne fournit pas une réserve disque transactionnelle. Réplication, métadonnées, rejeu d'une URL et opérations déjà acceptées par un fournisseur en panne demandent leur propre marge et leur qualification. Un relèvement exige une mesure.

Une transaction courte sérialise les admissions globales et les corrections de compteurs ; aucun appel S3 sous ce verrou. Une réservation dépassant un plafond renvoie `429 FILE_STAGING_CAPACITY` ou `FILE_STORAGE_CAPACITY`, sans intention créée ; une copie en attente de capacité reste réessayable. Une divergence de compteur du workspace bloque les nouvelles intentions (`503 FILE_ACCOUNTING_DRIFT`). Le worker compare chaque minute les compteurs aux métadonnées autoritatives et émet `file_accounting_drift` avec des totaux uniquement. Il ne corrige pas silencieusement une divergence.

Depuis la racine, `.env` pointant vers l'installation voulue :

```sh
pnpm files:accounting
```

Lecture seule ; code de sortie 1 si divergence, 0 sinon. `reservedBytes`, `stagingBytes`, `copyBytes` sont des chaînes d'octets, sans nom, email, clé S3 ni jeton. `legacyFiles` compte les fichiers actifs sans intention ; `documentsToInspect` compte les registres absents ou décalés. Ce dernier indicateur **n'établit pas une corruption** : une ancienne page sans fichier peut n'avoir aucun registre et être amorcée normalement à son ouverture.

En cas de divergence : conserver le rapport, sauvegarder PostgreSQL et les objets, identifier sa cause et comparer l'inventaire des fichiers/intents au stockage privé. Après avoir confirmé que seules les valeurs agrégées sont erronées, l'exploitant peut lancer explicitement :

```sh
pnpm files:accounting --repair
pnpm files:accounting
```

La première commande recalcule uniquement `file_workspace_usage` sous le verrou d'admission ; la seconde doit sortir à 0. Aucun objet n'est supprimé, aucun fichier n'est publié, aucun droit ou registre Yjs n'est reconstruit. Elle ne vérifie pas les hashes des objets S3 et ne répare pas une métadonnée source corrompue. Le wrapper reconstruit le petit exécutable ; pour un artefact déjà construit : `node --env-file=.env apps/worker/dist/file-accounting.mjs [--repair]`. Test réel de ces deux modes dans `pnpm test:files:recovery`.

### Anciens fichiers sans registre — procédure conservatrice

Ne pas reconstruire `file_usages` depuis la projection asynchrone des blocs, ni rendre un ancien fichier accessible par son seul UUID. Une page Yjs contenant des fichiers avec registre absent/incohérent reste fermée par `FILE_LEDGER_REBUILD_REQUIRED`. Le test de frontière supprime le registre d'une page réellement journalisée et vérifie ce refus sans écriture de secours.

1. Avant la mise à jour coordonnée, sauvegarder PostgreSQL, objets et secrets ; conserver aussi le volume MinIO historique si les données de test y sont encore. Le passage local à RustFS n'a pas copié ces objets.
2. Exécuter le rapprochement en lecture seule, inventorier les pages/fichiers anciens en accès opérateur privé. Une correction de compteur ne corrige pas leur provenance.
3. Pour des **données de test dispensables**, conserver l'ancien workspace en quarantaine (aucun accès invité), créer un workspace neuf et de nouvelles pages. Réimporter les assets par le parcours autorisé quand l'interface 7c sera disponible ; ne pas recopier les anciens IDs. Aucune suppression automatique des anciennes données dans 7a.
4. Si ces données ont de la valeur, conserver la sauvegarde et arrêter leur migration. Une reconstruction auditée depuis le contenu Yjs validé, avec preuve de provenance des fichiers, devra être qualifiée séparément ; elle n'est pas livrée. Le service de lecture reste fermé en 7a.

`pnpm dev:collab reset-legacy` concerne le passage de session 2 à Yjs : **ce n'est pas un outil de réparation du registre de fichiers 7a**. Ne pas l'employer pour ce problème. Aucune commande de suppression globale, aucun passage forcé à `ready` et aucune copie directe des droits ne sont nécessaires à la clôture des tests.

La [fiche de clôture](reviews/session-7-7a-cloture.md) distingue les pannes injectées après opérations S3 réelles, le crash réel du worker et les crashs/restaurations du fournisseur encore à qualifier. Le test navigateur utilise une page de protocole, pas l'interface de fichiers prévue en 7c.

### Validation et lecture des fichiers — 7b, 29 octobre 2026

Construire le convertisseur depuis les sources et le lockfile versionnés. Il contient sharp/libvips, s'exécute hors de l'API et n'a aucun accès réseau ni secret S3. Depuis la racine du clone de développement :

```sh
node scripts/build-file-validator.mjs --configure-local
pnpm db:migrate
pnpm --filter @memoria/files build
pnpm --filter @memoria/worker build
```

`--configure-local` configure le dossier privé du worker et retire son ancienne option Docker. Le digest de construction est affiché pour traçabilité. En local, `docker compose up -d --build file-converter` démarre le service permanent (image locale construite depuis les sources/lockfile) ; redémarrer ensuite le worker. En production, construire/publier cette image et remplacer dans la configuration de déploiement le build local par une référence de registre épinglée par digest. Le worker reçoit seulement `FILES_VALIDATOR_DIRECTORY`, pas un accès Docker. Sans dossier configuré, il avertit et laisse les fichiers privés en validation ; son health mail/PG ne qualifie pas le pipeline image.

`FILES_ORIGIN=https://files.<domaine>` doit être distinct de `APP_ORIGIN` et de l'origine S3 publique d'upload. DNS/TLS et Caddy desservent seulement `/v1/files/*`, le port `FILES_PORT=3005` reste privé. Le Caddyfile local ajoute `files.localhost` ; appliquer sa mise à jour contrôlée lors de l'installation. La livraison 7b n'a pas rechargé le Caddy de développement existant. `FILES_HOST=0.0.0.0` permet au Caddy Docker local de joindre le service ; en production, limiter l'écoute/réseau à Caddy. Les cookies applicatifs restent host-only. Le service utilise `APP_ORIGIN`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `TRUSTED_PROXY_CIDRS` et la configuration S3 ; **`S3_READ_ACCESS_KEY_ID`/`S3_READ_SECRET_ACCESS_KEY` distincts, GetObject seulement sur les objets finaux**, obligatoires en production. Aucune console, clé ou route de lecture directe S3 publique.

Originaux : `attachment` et `application/octet-stream`, jamais inline. Dérivés WebP réencodés : au plus 2 048/512 px, sans EXIF/GPS. Tous : `no-store`, `nosniff`, CSP sandbox, aucun cache CDN. Ticket porteur chiffré valable 60 s pour démarrer une lecture ; un flux commencé continue uniquement tant que ses droits restent valides. Révocation/contrôle indisponible : flux interrompu, pas de redirection de secours vers S3. Depuis 7d, après perte de la connexion PostgreSQL de notification, **files se reconnecte automatiquement**, avec attente progressive de 250 ms à 5 s ; les lectures restent fermées jusqu'au retour vérifié du contrôle. Les anciens flux sont détruits et toute nouvelle requête recontrôle ses droits. Une admission commencée avant la panne doit recommencer. `pnpm test:files:gateway-recovery` prouve ce chemin après destruction réelle de LISTEN et redémarrage de son PostgreSQL isolé ; ne pas redémarrer le développement pour reproduire ce test. Les octets déjà remis au navigateur ne sont pas récupérables.

Conserver le filtre global Caddy supprimant URI et en-têtes dans les journaux, y compris erreurs de proxy ; ne pas ajouter un access log brut, ni tracer les URL dans l'observabilité. Test 502 réel dans `pnpm test:files:browser`. Les diagnostics applicatifs sont des codes fixes, l'audit conserve des IDs, pas des noms de fichier.

#### Ressources du convertisseur

Une conversion à la fois pour l'installation, 1 CPU et 512 Mio sans swap, délai parent 30 s. La texture PNG RGB8 8K bruitée coûte ≈13,6 s au p95 ; le pic RSS observé est 154,2 Mio, pas une promesse pour tous les formats. Voir les trois séries dans la [fiche 7b](reviews/session-7-7b-validation-lecture.md). Ne pas augmenter la concurrence avant mesure de l'impact sur la collaboration en 7d. Les sources trop grandes/multipages restent téléchargeables sans aperçu ; un raster malformé reste rejeté. Aucun antivirus implicite.

`FILES_VALIDATOR_DIRECTORY` désigne le dossier d'échange **privé**, par défaut `.local/file-exchange`, monté uniquement dans le convertisseur et accessible au worker. `FILES_VALIDATOR_PRIVATE_DIRECTORY` (défaut `.local/file-validation-private`) doit rester hors de ce montage. Quota logique `FILES_VALIDATOR_EXCHANGE_BYTES` : 6 Gio par défaut, une seule tâche, source ≤5 Gio, réservation de 24 Mio pour sorties/copie privée, marge disque 128 Mio. Ce n'est pas un quota système contre l'administrateur ; surveiller le volume, éventuellement lui appliquer un quota propre. Sous Linux, UID 1000/mode 0700 ; sous Windows, ACL NTFS réservée au compte du worker et à Docker Desktop. Aucun autre service ne monte ce dossier et aucun processus applicatif Memoria ne pilote Docker ni son socket. Landlock ABI ≥3 est requis ; pas de repli permissif. Voir le [protocole, limites et guide de reprise](reviews/session-7-7d-convertisseur.md) : noms aléatoires, fichiers temporaires et renommage atomique, sondage Windows, expirations, nettoyage exact des seuls fichiers reconnus. Un résidu inconnu bloque l'admission au lieu d'être supprimé récursivement. Surveiller les retries privés, ne jamais forcer ready.

#### Tests Docker isolés et premier exercice de restauration

Tout nouveau banc passe ses commandes de démarrage par `node scripts/test-docker.mjs …` ou par `guardTestDocker`. Projet Compose explicite distinct, volumes/chemins/ports inspectés, pas de réseau host ni de `volumes-from`. `pnpm test:docker:isolation` tente réellement de monter un volume du développement et vérifie que le conteneur n'est pas créé. Ne jamais contourner ce refus en renommant seulement le conteneur. Les fixtures TLS copient uniquement les certificats/clefs **feuilles** précis dans leur stockage jetable, jamais un volume Caddy ni la clé de CA.

`pnpm test:files:reading` réalise un premier aller-retour : vrai dump PG et quatre objets RustFS, chiffrement authentifié, hashes, stockage de restauration indépendant, refus d'un objet manquant/corrompu, invalidation des sessions et replay d'une suppression. Les primitives `@memoria/storage/backup` exigent des métadonnées stables et une destination vide ; aucune CLI opérateur complète ni restauration du volume maximal n'est annoncée. La procédure pré-pilote reste : fermer l'accès, suspendre admissions/écritures/GC, drainer les jobs, exporter PG et manifeste/objets en streaming, chiffrer et vérifier, stocker clé de backup **et BETTER_AUTH_SECRET hors serveur**. Restaurer en réseau fermé, revérifier les hashes et registres, réappliquer les suppressions et invalider les sessions avant réouverture. Tester crash, capacité/RPO/RTO et automatisation sur l'hôte cible ; l’option B est retenue, volume exact à fixer avec le studio. Les secrets temporaires du test ne sont pas une sauvegarde exploitable de vos données.

Les paragraphes ci-dessous conservent le cadrage initial ; les décisions et résultats datés ci-dessus remplacent son choix encore ouvert et l'absence de routage local.

MinIO communautaire local n'est pas un choix de production maintenu. SeaweedFS a été qualifié en premier ; le développeur garde son patch comme **déblocage temporaire**, sans engagement de maintenir un fork. Le [comparatif du 29 octobre](reviews/session-7-7a-decision-stockage.md) donne RustFS 1.0.4 à 23/23 et Garage 2.5.0 à 18/23, sans patch, avec licences, sources et limites. **Choix du développeur avant 7b** ; pas encore de procédure d'installation de production prête à exécuter, ni de remplacement du Compose local.

Valeurs retenues de déploiement : **5 Gio/fichier, 250 Gio/workspace**, réservations et corbeille comprises ; **10 Mio/s d'octets admis par compte, rafale 64 Mio**. Ces valeurs ne garantissent pas un débit réseau strict contre le rejeu des URL : protection globale de l'entrée S3 et supervision requises. Le disque doit couvrir aussi staging, dérivés, rétention et métadonnées du fournisseur, avec sauvegardes hors serveur ; le quota métier n'est pas la capacité physique à provisionner.

Origines dédiées de lecture et d'upload, bucket privé, pas de console/admin S3 public ni de cookie applicatif partagé. Prévoir DNS/TLS et ports privés du service de lecture, capacités réelles du fournisseur vérifiées en 7a/7d. En local, des hôtes différents sont nécessaires pour isoler les cookies, pas seulement des ports différents. Aucun de ces nouveaux routages n'est implémenté maintenant.

Le [protocole de sauvegarde retenu](adr/022-droits-et-cycle-de-vie-des-fichiers.md#sauvegarde-restauration-et-rgpd-avant-pilote) coordonne PostgreSQL, objets immuables, manifeste, secrets hors serveur et journal des suppressions. Tester copie restaurable et reprise fermée avant pilote ; une réplication, un disque RAID ou un snapshot PostgreSQL isolé ne remplace pas ce test. Le choix mono-nœud ne promet pas de haute disponibilité. La qualification dédiée **4 vCPU/8 Gio** et la charge mixte de cinquante comptes doivent inclure stockage, gateway et conversion d'images, pas seulement le serveur collaboratif.

L'[option B de qualification](adr/022-droits-et-cycle-de-vie-des-fichiers.md#qualification-pré-pilote--deux-options-à-choisir) est retenue depuis le 29 octobre : volume pilote représentatif, débit utile et temps de restauration publiés par tranches. Le volume exact reste à fixer avec le studio. Les coûts théoriques et limites d'extrapolation figurent dans l'ADR ; aucune restauration de ce volume n'est déclarée effectuée. Les avertissements avant téléchargement d'exécutables/scripts/archives sont présents depuis 7c. L'[option antivirus locale](reviews/session-7-7d-antivirus.md) distingue coût documenté, limites des gros assets et qualification manquante ; elle n'est pas activée et aucun asset n'est transmis à un service externe.

**Preuve fournisseur 7a corrigée après arbitrage du 28 octobre.** SeaweedFS officiel 4.51 conserve le défaut décrit dans le [diagnostic](reviews/session-7-7a-stockage.md). Une [construction locale corrigée](reviews/session-7-7a-seaweedfs.md) passe les 23 scénarios HTTP, comme MinIO avec une configuration CORS globale exacte sur une fixture isolée. Cette correction demande une maintenance explicite ; aucune installation de production ni clôture de 7a n’est déclarée par ces tests. Le conteneur SeaweedFS du banc est jetable, privé au loopback, sans volume persistant ; ce n'est pas une installation de production.

Le noyau 7a lit les [réglages FILES_* documentés](reviews/session-7-7a-frontieres.md#réglages-de-déploiement-du-noyau). Ils doivent être identiques dans les processus applicatifs ; le démarrage refuse une valeur invalide. Aucun relèvement sans mesure. Ce noyau n’ouvre pas encore de route de fichiers ; réservations, baux et registre demandent leurs jobs de clôture, réconciliation et rétention avant utilisation réelle.

## Décision de qualification des sauvegardes — 29 octobre 2026

Le développeur retient **l'option B** : volume réaliste représentatif du pilote, mesure réelle du débit utile avec vérification des hashes, puis durées de restauration publiées par tranches de volume dans le guide. Le volume exact sera fixé avec le studio ; 25 Gio reste un exemple, pas une taille décidée. Publier coûts fixes, volume/nombre d'objets, temps et disque observés, puis projections 10/25/50/250 Gio avec limites. RPO ≤24 h et RTO ≤4 h restent les cibles à qualifier. Aucune restauration à la borne n'est déduite de l'extrapolation. Cette décision remplace les paragraphes historiques où A/B restaient à choisir.

## Interface fichiers 7c et suite d'exploitation

Appliquer la migration **0035** avant les nouveaux services : une propriété fichiers contenant des usages ne peut pas changer de type. Déployer ensemble API, collab et front, car le bloc `core.file` est nouveau ; fermer les anciens onglets après synchronisation. Le worker et le gateway de 7b restent nécessaires. Construire le front avec `pnpm --filter @memoria/web build` ; ne pas attendre une prévisualisation si le worker/converter ou l'origine `files.<domaine>` ne sont pas démarrés. Le [guide à deux navigateurs](reviews/session-7-7c-interface-fichiers.md#guide-manuel-à-deux-navigateurs) détaille les manipulations, reprise et caches.

Le parcours ne persiste ni octets, ni ticket, ni manifeste local de transfert. Après fermeture, la reprise consulte le serveur et demande le fichier original ; l'expiration 24 h/7 j reste en vigueur. Les téléchargements explicites sur disque et exports ne peuvent pas être retirés à distance. L'interface avertit pour exécutables, scripts, archives, formats actifs ou inconnus ; elle ne déclare aucun original exempt de malware. L'option d'analyse locale sera chiffrée en 7d.

**Suivi 7d — 30 octobre 2026 :** reprise du gateway après LISTEN/PG éprouvée ; convertisseur permanent par dossier privé livré et attaqué, sans Docker dans le worker. La [fiche dédiée](reviews/session-7-7d-convertisseur.md) décrit le montage Windows, la revalidation indépendante et les limites. La charge mixte/CPU, la reprise collaborative et la comparaison finale restent à clôturer dans la [revue 7d](reviews/session-7-7d-revue.md). Aucun risque accepté par cette mise à jour.

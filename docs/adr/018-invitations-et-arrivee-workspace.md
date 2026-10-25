# ADR 018 — Invitations, rôles et arrivée dans un workspace

Statut : **accepté**, 25 octobre 2026. Cadrage complet et valeurs validés par le développeur ; 5a validée et 5b livrée pour relecture. Les sections ci-dessous décrivent la cible, pas des preuves acquises avant exécution.

## Contexte et décisions déjà validées

La session 4 est fusionnée par la [PR #5](https://github.com/FoxTimew/Memoria/pull/5), main `1fc393eb8778dad9a6480620597ef239d322ab22`. Better Auth 1.7.12 gère déjà les comptes et memberships owner/member ; ses routes organization natives sont fermées au HTTP. Les colonnes de rôles et la table d'invitations existent, mais ce n'est pas une implémentation de l'arrivée d'un invité.

Décisions explicites :

1. **Admin** : gérer invitations, partages, comptes member/guest et politique de cache. Seul owner nomme/retire un admin/owner et modifie l'obligation de connexion forte. Pas de transfert de propriété ni suppression du workspace par un admin ; conserver au moins un owner.
2. **Nouvel arrivant** : dans un workspace exigeant la connexion forte, facteur vérifié avant tout contenu, guest compris. La grâce reste réservée aux membres présents lors de l'activation. Le trigger de migration 0010 applique déjà cette distinction ; aucune grâce ne sera recréée par réinvitation.
3. **Guest edit** : modifier contenu et titre, créer des sous-pages sous un parent éditable. Déplacement, archivage et restauration restent réservés aux owner/admin/member. Aucun droit de repartage.
4. **Mutations d'accès** : preuve forte de moins de dix minutes pour inviter, renvoyer/annuler, créer/modifier/retirer un partage, retirer un membre et changer un rôle, même sans obligation forte du workspace. Le contrôle et l'effet appartiennent à la même transaction, après attente des verrous. La consultation et l'acceptation de sa propre invitation n'exigent pas cette réauthentification récente ; elles ne donnent jamais une assurance forte.

Le rôle d'invitation est exactement `admin`, `member` ou `guest` ; pas d'invitation owner, de liste de rôles, de teams ni de rôles dynamiques. Une promotion owner d'un membre existant reste une action explicite d'owner, protégée et auditée. Un admin ne peut ni modifier son propre rôle ni attribuer indirectement admin via une invitation.

## Intégration retenue

Conserver le plugin organization, son schéma et ses API serveur. Les façades Nest possèdent autorisation, quotas, assurance et transaction ; **aucune route native organization n'est ouverte**. Configurer explicitement les quatre rôles, les permissions minimales du guest et `requireEmailVerificationOnInvitation: true`. Ne pas ajouter de dépendance ou mettre à jour Better Auth pour cette session.

Lecture du code installé : `crud-invites.mjs` compare l'adresse de la session au destinataire, vérifie statut/expiration et fait un changement conditionnel pending→accepted. Avec la génération UUID actuelle, l'email vérifié n'est pas exigé par défaut dans ce chemin : notre option explicite et le guard restent indispensables. Le changement de statut précède une partie de la création du membre : la preuve 5b montre le rollback de l'ensemble avec notre adaptateur transactionnel, y compris acteur, sujet, partages, audit et file d'email. Le simple succès du plugin ne prouve pas cette atomicité.

La [documentation officielle organization](https://better-auth.com/docs/plugins/organization#email-verification-requirement) confirme l'option d'email vérifié et décrit les hooks. La politique retenue ci-dessous est applicative, pas une garantie supplémentaire de la bibliothèque.

### Invitation et preuve d'identité

- Une invitation vise un email normalisé comme le compte (minuscule, aucune réécriture des points ou du suffixe `+`). Un compte nouveau s'inscrit et vérifie son adresse ; un compte existant se connecte. L'adresse vérifiée de la session doit correspondre, même si le lien a été copié ou transmis à une autre personne.
- Le lien copiable est construit depuis l'origine configurée : `/invitation#id=<UUID>`. L'UUID sélectionne l'invitation ; **il ne connecte pas, ne vérifie pas l'email et ne donne aucun accès sans la session destinataire**. Fragment retiré au chargement, `no-referrer`, pas d'analytics sur ce parcours. L'identifiant peut être gardé temporairement dans l'onglet pour reprendre après connexion/vérification, puis supprimé après fin, abandon ou déconnexion. Pas d'email dans l'URL.
- Avant authentification, écran générique sans nom de workspace, destinataire, titres de pages ou liste des membres. Après authentification complète du compte et vérification d'email, une façade renvoie uniquement l'invitation de ce destinataire. Mauvais compte : message générique et changement de compte proposé, sans dévoiler l'adresse attendue.
- Invitation guest : sélection d'au moins une page et de son niveau read/edit, au plus vingt racines par invitation. Ces intentions sont liées à l'invitation, sans grant actif avant acceptation. Toutes les pages doivent appartenir au workspace. Une page archivée/inaccessible à l'acceptation fait échouer atomiquement l'opération ; pas d'acceptation partielle silencieuse.
- Une invitation ne change jamais le rôle d'un membre existant. Détecter ce cas et renvoyer vers la gestion explicite des membres. Une seule invitation pending par workspace/email normalisé, vérifiée sous verrou et contrainte SQL ; pas de cumul de rôles ou de partages par courses concurrentes.

### Acceptation, révocation et email

Sous transaction et ordre de verrous commun : relire session/email, invitation/expiration, workspace, autorité actuelle de l'inviteur, rôle prévu et pages partagées. L'inviteur doit encore pouvoir attribuer ce rôle ; s'il est retiré ou rétrogradé, l'ancienne invitation ne contourne pas cette perte de pouvoir. Les mutations de rôle réévaluent/annulent les invitations devenues incompatibles. Deux acceptations concurrentes ne créent qu'un membre/acteur/sujet et un ensemble de grants ; acceptation contre annulation ou expiration ne produit aucun accès partiel.

Le plugin est instancié sur la transaction de la façade, comme le socle existant. Le statut accepted, membership, acteur, sujet, grants, audit et job de notification doivent partager le même commit. Si l'adaptateur installé ne permet pas cette garantie, **arrêt de la preuve 5b et proposition d'adaptation**, sans réécriture parallèle du plugin en silence. Les suppressions de membership restent physiques, après nettoyage des références métier ; les contributions/auteurs historiques suivent l'ADR 012.

**Retenu le 25 octobre :** validité par défaut **sept jours**, renvoi remplaçant l'ancien lien et purge des invitations terminales après **trente jours**, durées configurables. La plage configurable de 1 à 30 jours est retenue. Un renvoi annule l'ancienne invitation et crée un nouvel identifiant et une nouvelle échéance ; l'ancien lien ne redevient jamais valable. Le formulaire peut recopier les choix précédents après revalidation. L'expiration est contrôlée à chaque appel, même si le worker est arrêté. Les emails ne sont pas dupliqués dans l'audit ou les métriques. Ce traitement rejoint la qualification RGPD R13, sans annoncer que la suppression de compte globale est déjà livrée.

Réutiliser la file chiffrée et le worker SMTP/Mailpit ; ne pas appeler SMTP dans la transaction de droits. Un job d'invitation vérifie encore son statut avant envoi ; sa durée de vie retenue est au plus 24 h et jamais au-delà de l'invitation. Reprises bornées et livraison au moins une fois, comme le socle. Une course peut livrer un email après annulation : le lien reste refusé. Les paramètres du reset de mot de passe (30 minutes) sont inchangés. L'interface de gestion indique l'état d'envoi et permet de copier le lien valide en secours, uniquement à owner/admin autorisé ; une panne SMTP ne crée aucun accès et n'annule pas l'invitation.

## Arrivée avec connexion forte

Parcours : lien → inscription/connexion → vérification d'email → vérification d'un facteur déjà présent, si nécessaire → acceptation explicite → configuration guidée si exigée → **preuve forte réelle** → contenu autorisé. Le guard global refuse déjà les sessions restreintes d'un compte équipé ; il n'est pas relâché pour les invitations. Un nouveau compte sans facteur peut accepter son invitation, mais sa membership est immédiatement sans grâce si le workspace impose la force. La réponse contient seulement l'étape suivante, jamais le contenu protégé.

Exemple de message : « Ce studio protège ses documents avec une seconde vérification. Ajoutez une clé d'accès ou utilisez une application d'authentification pour continuer. » Afficher TOTP/QR et passkeys depuis les parcours existants, puis demander la vérification qui établit l'assurance. Un enrôlement, un code de secours, un reset email ou une session de récupération ne suffisent pas. Une reprise doit conserver le choix Poste partagé ; aucune confiance dans `returnTo`, rôle ou `workspaceId` fournis par le client. Seuls des chemins internes validés sont utilisés pour revenir au workspace.

La politique est relue après acceptation, enrôlement et à chaque accès. Si elle change pendant le parcours, afficher la nouvelle exigence. Un guest sans partage actif voit « Aucune page ne vous est partagée pour le moment », sans arbre global ni roster. L'accès à ses autres workspaces reste indépendant.

## Quotas et bornes retenus

Le tableau, les budgets d'email et toutes les bornes de cette section sont **retenus le 25 octobre 2026**. Conserver les règles d'authentification retenues dans l'ADR 015. Ajouter l'admission aux nouvelles façades internes : ne pas supposer qu'elles héritent du limiteur de `/api/auth`. Réutiliser ses fenêtres fixes PostgreSQL, empreintes HMAC, IP résolue par le proxy de confiance, normalisation IPv6 et `429`/`Retry-After`. Les clés de route utilisent le gabarit canonique, jamais l'UUID brut ; changer de page, invitation ou workspace ne contourne pas le budget IP.

| Famille de routes                                                            | Budget IP par gabarit | Budget supplémentaire                                                                      |
| ---------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| Lecture des invitations/membres/partages, résolution de sa propre invitation | 600/min               | 120/min/compte par famille                                                                 |
| Création ou renvoi d'invitation                                              | 100/10 min            | 50/10 min/émetteur/workspace, 200 envois/jour/workspace, partagés entre création et renvoi |
| Acceptation/refus de sa propre invitation                                    | 150/5 min             | 30/5 min/compte, famille commune                                                           |
| Annulation, mutation de partage, rôle ou retrait de membre                   | 60/min                | 30/min/acteur/workspace, famille commune                                                   |
| Consultation du statut d'arrivée (si route distincte nécessaire)             | 600/min               | 120/min/compte                                                                             |

Emails : type séparé `invitation`, **3/15 min et 10/jour/destinataire** comme les autres familles de l'ADR 015, clé HMAC globale au destinataire/type, aucun budget reconsommé par les retries. La copie d'un lien déjà valide n'envoie pas d'email et ne recrée pas l'invitation. Les cinquante arrivants partagent leurs budgets IP mais ont leurs limites de compte séparées ; les envois d'un gestionnaire sont un autre flux. Les quotas doivent admettre cinquante créations puis cinquante acceptations légitimes et ne pas dépendre de l'existence d'un compte. Pas de nouveau délai de mot de passe pour accepter une invitation : la connexion conserve sa protection existante.

**Bornes retenues le 25 octobre**, configurables : **100 memberships** par workspace, guests compris (plafond plugin actuel, à rendre explicite), **500 invitations pending**, **100 racines de partage par guest**, **5 000 grants actifs par workspace**. Bornes secondaires retenues : 20 racines par invitation, listes paginées 50/max 100. Vérifier toutes les bornes sous transaction, pas par comptage suivi d'un insert concurrent non protégé. Aucun chiffre n'est une preuve de capacité ni une extension de la limite des pages ou des futures lignes de base.

## Alternatives et preuve attendue

Laisser les routes natives ouvertes simplifierait le front mais contournerait transactions, assurance et R12. Créer un système de memberships parallèle dupliquerait le plugin. Les deux options sont écartées dans cette décision. Pas de lien public anonyme, de domaine auto-admis ni de création de compte par l'administrateur.

Preuves bloquantes prévues en 5b : bon/mauvais destinataire, email non vérifié, rôle forgé/multiple/owner, acteur révoqué avant acceptation, lien expiré/annulé/renvoyé/rejoué, double acceptation, panne SQL après statut accepted, collision d'invitation, capacité concurrente, cinquante comptes sous NAT, job SMTP doublé/annulé, arrivée MFA sans accès anticipé. Chaque route réelle entre dans la [matrice de session 5](../reviews/session-5-etape-1-cadrage.md) avant d'être déclarée sécurisée. Les résultats exécutés et les absences restantes sont distingués dans la [fiche 5b](../reviews/session-5-5b-invitations.md).

## Précision validée pour 5b

Un owner/admin sans facteur qui tente une mutation d’accès reçoit un parcours guidé de configuration, puis de vérification forte, avec un message simple : « Pour gérer les accès au studio, ajoutez une seconde vérification à votre compte. » Revenir ensuite à son formulaire, sans exécuter automatiquement une ancienne demande ni contourner la revérification transactionnelle. Cela vaut aussi sans obligation forte du workspace ; pas de refus brut dans l’interface.

## Réalisation 5b

La preuve préalable contre Better Auth installé confirme le rollback après son changement de statut, puis après les écritures métier et le job chiffré. Les façades utilisent `AuthService.inTransaction(tx)` ; les headers sont transmis au plugin, mais l'identité et l'autorisation restent celles du guard et de la relecture SQL. Aucun endpoint organization natif n'est ouvert. Migration 0018 : intentions de partage, unicité pending/email normalisé, date terminale immuable, annulation des invitations incompatibles après retrait/rétrogradation de leur émetteur. Les grants n'existent qu'après acceptation, dans le même commit que l'acteur et le sujet.

Les budgets IP/compte sont consommés par le guard indépendamment du résultat métier. Les budgets d'envoi workspace/destinataire sont committés avec l'invitation et le job : un rollback ne produit ni email ni consommation d'envoi. Ils utilisent la même connexion SQL que la mutation, pour éviter une attente circulaire quand le pool est occupé par des transactions en attente de verrous. Une preuve de seize créations simultanées couvre ce cas. Les retries SMTP ne consomment aucun nouveau budget. Un budget destinataire épuisé laisse un lien copiable (`limited`) ; le budget workspace journalier renvoie 429. Les durées de job sont bornées aussi par l'horloge transactionnelle PostgreSQL, pas seulement l'horloge applicative.

Le worker expire les pending et purge les invitations closes chaque minute. La date terminale ne change pas après une mise à jour du statut SMTP. Les intentions conservent une FK vers leurs pages : l'archivage reste possible ; la future purge définitive de pages devra retirer/annuler ces intentions dans son ordre de nettoyage. Pas de conversion ni de reset des données locales.

L'interface `/workspaces/:id/acces` conserve le formulaire dans le stockage de l'onglet, par utilisateur/workspace, pendant la configuration du facteur. Retour autorisé seulement vers des chemins internes explicitement admis ; aucune soumission automatique. Les marqueurs de déconnexion effacent aussi ces formulaires dans les onglets actifs. Le lien d'invitation peut être retrouvé via « Mes invitations » si le stockage de l'onglet est indisponible. Renvoi/annulation/retrait demandent une nouvelle action explicite au retour ; leurs boutons ne rejouent pas une requête ancienne. L'arrivée `/workspaces/:id/arrivee` vérifie à nouveau la politique ; un guest termine son adhésion/MFA mais son éditeur navigateur reste fermé jusqu'à 5c.

La [fiche 5b](../reviews/session-5-5b-invitations.md) contient l'inventaire réel des quatorze routes nouvelles/élargies, leurs quotas, les attaques, les journaux complets et les limites. Les campagnes de fuite/concurrence/cache consolidées et les mesures à mille pages restent en 5d ; cette preuve fonctionnelle NAT ne qualifie pas cinquante rédacteurs simultanés.

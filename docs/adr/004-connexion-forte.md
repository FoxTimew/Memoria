# ADR 004 — Facteurs et preuve de connexion forte

Statut : accepté — 2026-10-22.

État en 4b, le 25 octobre 2026 : TOTP, QR local, passkeys UV, génération/renouvellement des codes communs, assurance de session et politique de workspace sont exécutables. Récupération, nouveaux quotas et choix de cache restent en 4c–4e ; la revue adverse 4f précède l’unique PR et le merge de session 4. Aucun utilisateur réel avant la session 4 complète et les autres prérequis d'[ARCHITECTURE.md](../../ARCHITECTURE.md#sessions-suivantes).

**Décision.** Email vérifié + mot de passe, TOTP et codes de secours ; passkeys multiples nommables/supprimables. Pas de SMS ni OTP email comme second facteur. `session_assurance` enregistre côté serveur la méthode réellement vérifiée et son instant, jamais une déclaration du client. Une passkey avec UV vérifié constitue une connexion forte complète.

**Alternatives.** Déduire la force de `twoFactorEnabled` ; considérer toute session récente comme forte ; exiger TOTP même après une passkey vérifiée.

**Raison.** Posséder un facteur ne prouve pas qu'il a servi pour cette connexion. L'assurance doit aussi distinguer un code de récupération d'une authentification forte fraîche.

**Conséquences.** Owner avec facteur fort vérifié ET session forte récente pour activer l'obligation. En activation, fixer les échéances individuelles des membres existants à maintenant + délai configurable (7 jours par défaut). Les nouvelles adhésions doivent satisfaire la politique avant l'accès au contenu. L'expiration du délai bloque l'accès workspace mais laisse les écrans d'enrôlement/récupération accessibles. Modifier le délai ne prolonge pas silencieusement les échéances existantes.

Création de clé, ajout/modification de webhook, changement de rôle/partage sensible et désactivation/suppression de facteur exigent `verified_at` de moins de 600 secondes par défaut. Un code de secours ouvre une session de récupération limitée à la restauration des facteurs ; il ne permet pas ces actions sensibles. Le dernier facteur ne peut être retiré tant qu'une adhésion impose la connexion forte. Ne pas utiliser « trusted device » pour fabriquer une nouvelle preuve fraîche.

**Point d'intégration vérifié.** Le plugin passkey 1.7.12 expose les hooks `registration.afterVerification` et `authentication.afterVerification`, mais utilise `requireUserVerification: false` dans ses vérificateurs et `preferred` pour les options de connexion. En 4a, les options rendues imposent `userVerification: required`, et les hooks refusent tout résultat cryptographiquement vérifié dont `registrationInfo.userVerified` / `authenticationInfo.userVerified` n'est pas strictement vrai, AVANT création de credential/session. `authenticatorSelection` seul ne suffit pas. [Plugin et hooks](https://better-auth.com/docs/plugins/passkey).

## Session 4, étape 1 — cadrage retenu le 25 octobre 2026

Cette section complète les principes acceptés ci-dessus. **Cadrage validé le 25 octobre 2026.** Les trois arbitrages sur les codes communs, le reset ciblé et les valeurs par défaut du cache ont été validés par le développeur le 25 octobre. L'étape 4a est autorisée ; les autres sous-étapes restent soumises à relecture. Valeurs déjà retenues : grâce de 7 jours et preuve forte récente de moins de 600 secondes. Toutes les valeurs ci-dessous sont retenues et configurables.

### États et transitions de session

| État serveur              | Accès autorisé                                                         | Passage à la suite                                                |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Anonyme / défi en attente | Connexion, email de récupération, vérification du défi                 | Mot de passe vérifié puis facteur requis, ou assertion passkey UV |
| Simple, email vérifié     | Workspaces sans obligation, ou encore en grâce ; compte/enrôlement     | Vérification forte explicite                                      |
| Forte TOTP ou passkey UV  | Contenu des workspaces autorisés pendant la validité de la session     | Réauthentification forte si une action sensible dépasse 600 s     |
| Récupération limitée      | Rétablissement des facteurs et déconnexion uniquement, 15 min retenues | Enrôlement vérifié puis nouvelle authentification forte explicite |

Le délai de 600 s borne les **actions sensibles**, pas la durée d'accès éditorial : ne pas couper l'éditeur toutes les dix minutes. La validité de la session Better Auth, les révocations et la politique workspace restent contrôlées. Une absence de ligne d'assurance vaut session simple, jamais forte. Une session de récupération n'a aucun accès au contenu, même dans un workspace sans obligation. L'enrôlement seul ne promeut pas une session ; exiger ensuite une assertion de connexion/réauthentification (pour TOTP, un pas non déjà consommé).

### Facteurs

- Parcours retenu : dès qu'un facteur est activé, le mot de passe seul ouvre un défi, pas une session de contenu ; le compléter par TOTP ou passkey UV. Une passkey UV peut aussi ouvrir directement la session forte. Révoquer les sessions simples préexistantes à l'activation, en ne laissant à la session d'enrôlement que le droit de terminer la vérification. Les comptes sans facteur gardent la connexion simple, sous réserve des politiques workspace. Tester les comptes avec TOTP seul, passkeys seules et les deux ; aucun mode de connexion alternatif ne doit contourner le facteur actif.
- TOTP : secret chiffré, QR/secret affichés seulement pendant l'enrôlement, activation après code vérifié. Retenu : six chiffres, pas de 30 s, tolérance ±1 pas ; mémoriser atomiquement le dernier pas accepté pour empêcher un double usage concurrent. Ne jamais journaliser secret, OTP ou URI.
- Passkeys : plusieurs, nommables, supprimables ; RP ID dérivé du hostname configuré et origine exacte. UV obligatoire à l'enrôlement **et** à l'authentification, contrôle serveur du résultat cryptographique. Une clé sans PIN/biométrie compatible UV est refusée ; expliquer ce cas dans l'interface. Les passkeys synchronisées sont admises, pas d'exigence d'attestation constructeur.
- Premier facteur : session simple vérifiée + confirmation récente du mot de passe (5 min retenues), puis preuve de possession du nouveau facteur. Facteur supplémentaire ou remplacement : preuve forte récente d'un facteur existant, ou parcours de récupération limité. Ne pas transformer un reset de mot de passe en autorisation de remplacer un facteur existant.
- Pas de SMS, OTP email ni « appareil de confiance » permettant de sauter la preuve ; refuser `trustDevice: true` sur les façades concernées.

### Politique workspace et actions sensibles

Seul le propriétaire active/désactive l'obligation forte ; il possède déjà un facteur vérifié et une preuve forte récente. Grâce retenue configurable de 0 à 30 jours, défaut 7. À l'activation, écrire une échéance par membre existant ; toute nouvelle adhésion doit satisfaire l'obligation avant de lire le contenu. Changer la durée ne repousse pas les échéances déjà fixées. À l'expiration : contenu/recherche/mutations/WS refusés, mais compte, enrôlement et récupération restent accessibles. Les échéances sont évaluées à l'accès et par le contrôle périodique, même si aucun job n'a tourné. Plusieurs workspaces gardent des politiques indépendantes.

Création de clé API, ajout/modification de webhook, changement de rôle, désactivation 2FA et suppression de facteur : preuve forte récente <600 s et autorisation métier, revérifiées côté serveur au moment de l'effet. Inclure aussi changement de politique de sécurité et régénération de codes. Le dernier facteur ne peut être supprimé si une adhésion exige la connexion forte ; autoriser son **remplacement** via récupération vérifiée. Les rôles owner/member restent la surface active ; le rôle admin et les invités arrivent en session 5. Les futurs endpoints clé/webhook utilisent le même service et ses tests de contrat, sans implémenter ces produits en session 4.

L'API et `apps/collab` appliquent la même politique. Révocation, perte d'assurance valide, reset de facteur ou échéance échue ferment les sockets concernées via notification PostgreSQL, avec secours au plus 5 s. L'admission et chaque écriture revérifient les droits ; le HMAC interne authentifie le transport, pas l'autorisation utilisateur. Reconnexion et replay hors ligne ne contournent pas une nouvelle obligation forte.

### Perte de facteur : codes communs (choix validé)

Choix validé : 10 codes indépendants de 128 bits aléatoires minimum, à usage unique, couvrant TOTP et passkeys. Affichés/téléchargeables une seule fois, empreintes protégées au repos, consommation atomique et régénération invalidant tout le jeu précédent. Aucun secret dans URL ou journal. La façade combine mot de passe vérifié et code pour ouvrir une session de récupération limitée ; si le mot de passe est aussi perdu, passer d'abord par le reset email, qui ne remplace jamais le code.

Consommer un code révoque les anciennes sessions, invalide leurs assurances et notifie le compte. La récupération autorise à remplacer les facteurs perdus ; il faut ensuite une nouvelle preuve forte explicite pour ouvrir le contenu. À la fin, proposer un nouveau jeu et invalider le précédent. Test obligatoire : deux utilisations simultanées d'un même code, une seule réussit.

### Secours opérateur en auto-hébergement (reset ciblé validé)

Interface retenue pour 4c, **commande non disponible à cette étape** : `pnpm admin:reset-factor --user-id <uuid> --factor <totp|passkey:id|all> --reason <motif>`. Lecture/simulation par défaut ; exécution avec confirmation explicite de l'UUID, pas de compte implicite ni d'action en masse. Exécution par l'exploitant dans l'environnement serveur, jamais par un administrateur de workspace via HTTP. Vérification de l'identité de la personne selon une procédure d'exploitation documentée, sauvegarde et droits opérateur nécessaires.

Transaction : supprimer seulement le facteur choisi (ou tous avec `all` explicite), invalider les codes et défis concernés, révoquer toutes les sessions/assurances, marquer une récupération opérateur requise, auditer UUID/motif/opérateur/date sans secrets. Conserver rôles, contenu et politiques de workspace. En absence de facteur utilisable, un jeton ponctuel de réenrôlement envoyé à l'email vérifié et le mot de passe donnent seulement la session limitée (15 min) ; aucun accès normal avant nouveau facteur et nouvelle preuve. Un reset de mot de passe reste un parcours distinct. SMTP fonctionnel est requis pour délivrer le réenrôlement : réparer ce canal s'il est indisponible. La commande n'affiche aucun jeton dans les journaux et ne crée pas de session forte de secours.

Tester compte absent, cible ambiguë, absence de confirmation, rollback/audit, effets sur WS et maintien de l'obligation. C'est une capacité de secours de l'exploitant ayant accès au serveur, à documenter comme telle ; elle ne promet pas de résister à un administrateur système malveillant.

### Poste partagé et politique de cache (valeurs par défaut validées)

Choix validé : case décochée par défaut, cache autorisé par défaut au workspace. Le choix « Poste partagé » est stocké **côté serveur dans la session**, conservé pendant les défis, rotations et réauthentifications. Le workspace peut interdire le cache à tous ses membres ; owner aujourd'hui, admin quand ce rôle sera livré. Une interdiction l'emporte toujours sur le choix personnel. L'absence de réponse de politique n'autorise pas le cache.

En mode partagé : document Yjs et updates restent seulement en mémoire ; aucun contenu dans IndexedDB, localStorage ou service worker. Toute page rechargée vérifie identité/droits/politique en ligne avant de lire un cache. La coupure dans une page ouverte permet encore la saisie en mémoire, avec avertissement explicite qu'une fermeture perdra les changements non envoyés. Ne pas annoncer « conservé sur cet appareil » dans ce mode.

Cocher l'option purge les anciens caches de cet utilisateur dans ce navigateur, y compris les autres onglets ; une interdiction workspace purge les documents de ce workspace, sans effacer ceux d'autres comptes/workspaces. Réutiliser les epochs/tombstones de 3c avec une version de politique : transaction de purge, invalidation des tickets d'écriture, diffusion inter-onglets, contrôle au réveil et avant tout nouvel accès IndexedDB. Une réponse HTTP tardive ne doit ni hydrater ni réécrire un cache interdit. Pour un changement volontaire avec des updates non synchronisées, prévenir et proposer synchronisation ou export avant confirmation ; une interdiction distante s'applique dès réception et conserve au plus le travail en mémoire pour le renvoyer si les droits le permettent.

Limite incontournable : un serveur ne peut pas effacer immédiatement un navigateur coupé du réseau, ni des données déjà exportées. Notification en ligne et secours périodique ≤5 s, contrôle au réveil/reconnexion et avant hydratation ; aucune promesse d'effacement distant d'un disque hors ligne. La déconnexion conserve l'effacement complet de tous les caches utilisateur et la neutralisation des onglets retardataires. Les marqueurs sans contenu peuvent persister pour empêcher la résurrection.

## Périmètre effectivement livré en 4a

Les règles de facteurs et d'assurance ci-dessus sont actives. Les valeurs retenues sont fixées dans cette première intégration : mot de passe confirmé moins de 300 s, défi TOTP de 300 s/cinq essais, preuve forte récente de moins de 600 s, dix codes de 128 bits. Leur exposition en configuration d'exploitation reste à raccorder dans la suite de session 4. Une nouvelle demande de défi conserve les tentatives du défi encore vivant ; le pas TOTP est consommé sous verrou de compte, y compris à l'enrôlement. Les vérifications parallèles d'un même TOTP ou d'une même assertion passkey ne réussissent qu'une fois. La rotation conserve le paramètre serveur `sharedComputer`, dont l'option visible n'arrive qu'en 4e.

L'écran `/securite` permet l'enrôlement TOTP par **saisie manuelle de la clé** dans une application de codes (QR ajouté en 4b), la vérification explicite, l'ajout/renommage/suppression de passkeys et le renouvellement des codes communs. Les codes sont affichés/téléchargeables une fois, jamais persistés par l'application dans le navigateur ; PostgreSQL ne conserve que SHA-256(compte:code). L'entropie de 128 bits rend l'attaque exhaustive de ces empreintes impraticable. Les codes natifs de Better Auth restent chiffrés dans sa table, inutilisés et inaccessibles par HTTP. La **consommation** des codes communs et la session limitée de récupération seront livrées en 4c ; aucun parcours ne prétend déjà récupérer un facteur perdu.

Le guard API et le résolveur SQL de collaboration utilisent la même frontière d'assurance. Le refus d'accès d'une session de défi est testé sur les deux ; les tests permanents vérifient aussi les fermetures WS après suppression de session. Le parcours complet « changement de facteur → fermeture du WS » et les échéances de politique sont désormais testés en 4b (voir ci-dessous). Le mode récupération est déjà refusé par la fonction SQL de contenu, mais son parcours complet n'est pas livré.

Les limites IP de session 1 restent actives. Les cinq essais par défi ne bornent pas, à eux seuls, les essais sur plusieurs sessions/défis : la protection progressive par compte, les seuils NAT et la purge des compteurs sont obligatoires en 4d. La liste des manques reste ouverte pour 4f ; aucun n'est implicitement accepté pour le merge. Voir la [fiche 4a](../reviews/session-4-4a-facteurs-assurance.md).

## 4b — règles exécutables et QR d'enrôlement

Grâce : entier de **0 à 30 jours**, défaut sept, modifiable dans « Sécurité de l’espace ». À la première activation, chaque adhésion existante reçoit son échéance. Modifier la durée d'une politique déjà active **ne change aucune échéance**. Désactiver conserve les échéances ; réactiver prend le minimum de l'ancienne échéance et de la nouvelle durée, sans accorder de prolongation. Ce choix empêche un cycle désactivation/réactivation de repousser discrètement la protection. Un trigger fixe une échéance immédiate à toute nouvelle adhésion sous politique active, y compris via l'outil de développement ; une échéance absente refuse l'accès.

Le propriétaire doit vérifier un facteur avant **toute modification** de politique, y compris sa désactivation. La preuve doit dater de moins de dix minutes, être liée à un facteur encore actif et à la génération courante. Une preuve plus ancienne continue à autoriser le contenu, sans autoriser les actions sensibles. Après expiration de grâce, un membre conserve l'accès à la lecture de sa politique et aux écrans de sécurité ; il peut enrôler puis vérifier un facteur pour revenir au contenu. La politique d'un autre workspace reste indépendante.

Le QR est généré dans un canvas par `qrcode@1.5.4`, chargé côté client, à partir de l'URI otpauth rendue par Better Auth. Il complète la clé manuelle ; aucun service externe, URL d'image distante ou stockage navigateur du secret. Le canvas est effacé à son démontage ; l'URI disparaît de l'état de l'écran après validation/déconnexion. Le parcours navigateur décode les pixels avec une bibliothèque indépendante et compare à l'URI réelle, vérifie les requêtes réseau et la disparition du canvas. [API navigateur de node-qrcode](https://github.com/soldair/node-qrcode#browser).

La sauvegarde hors serveur de `BETTER_AUTH_SECRET`, nécessaire au déchiffrement des secrets TOTP, est obligatoire dans le [guide d'auto-hébergement](../self-hosting.md#secret-dauthentification-et-totp--sauvegarde-indispensable). La perte du secret ne peut pas être réparée en générant une nouvelle valeur.

Validation matérielle de 4a rapportée par le développeur : Android, Windows Hello et YubiKey. La preuve automatisée 4b utilise de vraies signatures P-256 et des sockets réseau, puis un navigateur avec authentificateur virtuel ; elle n'est pas présentée comme un nouvel essai matériel. Récupération, quotas et politique de cache restent à livrer en 4c–4e, puis revue adverse 4f avant merge.

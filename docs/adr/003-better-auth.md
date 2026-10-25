# ADR 003 — Better Auth et plugins

Statut : accepté — 2026-10-22.

État après session 1 : email/mot de passe, vérification et plugin organization actifs ; seuls owner/member sont configurés à ce stade. Les autres plugins ci-dessous décrivent la cible, pas des routes déjà ouvertes. Le montage HTTP et la création transactionnelle de workspace sont précisés dans l'ADR 015.

**Décision.** Better Auth 1.7.12 dans NestJS ; plugins `organization`, `twoFactor`, `@better-auth/passkey` et `@better-auth/api-key` à versions exactes. Adaptateur Drizzle, identifiants UUID générés par Better Auth. Le schéma conserve les noms de propriétés attendus par les plugins, avec noms SQL explicites. Le test `schema-contract.test.ts` vérifie les champs des versions installées.

**Alternatives.** Auth, invitations et clés entièrement personnalisées ; fournisseur SaaS obligatoire.

**Raison.** `organization` couvre memberships/invitations/rôles personnalisés. `apiKey` couvre préfixe, hash, scopes, expiration, révocation et compteurs PostgreSQL atomiques dans la version inspectée. Les réécrire n'est pas justifié. Les permissions de pages restent dans notre service métier. [Organization](https://better-auth.com/docs/plugins/organization), [API Key](https://better-auth.com/docs/plugins/api-key/reference).

**Conséquences.** Configurer explicitement les quatre rôles, un rôle par membre, aucun team/dynamic role. Les invités ne créent pas de clés au MVP ; owner/admin/member peuvent créer une clé sous leurs propres droits, après connexion forte récente. `references: organization`, `enableSessionForAPIKeys: false`, hash activé, stockage database ; ne jamais accepter scopes/émetteur/rate limit fournis sans validation. `api_key_policies` conserve émetteur, acteur, révocation et audit ; une clé sans politique complète est inutilisable. `referenceId` est mappé à `workspace_id`, `lastRequest` à `last_used_at`.

Les endpoints Better Auth sont aussi protégés : les guards Nest ne suffisent pas sur le handler monté. Interdire l'accès HTTP direct aux mutations organization/api-key sensibles ; les façades Nest appellent les API serveur après autorisation/assurance. Adapter aussi les hooks de suppression de facteur/compte. Le handler Express est monté avant les parseurs qui consommeraient son flux. Ne pas désactiver CSRF/origin checks. Le client web reste le client Better Auth pour la connexion et les facteurs.

La révocation met `enabled=false` et `revoked_at` ; une expiration peut faire supprimer la credential par le plugin. La politique/audit survivent avec `credential_id=NULL`. Les memberships révoqués sont supprimés physiquement après nettoyage des références : le plugin ne filtre pas nos soft deletes.

## Session 4, étape 1 — cadrage du 25 octobre 2026

Statut de cet ajout : **cadrage à relire ; trois arbitrages validés par le développeur le 25 octobre**. Les décisions déjà acceptées restent applicables ; aucune route ou migration applicative n'est ajoutée à cette étape.

### Intégration proposée

Conserver Better Auth et les versions exactes installées. Activer `twoFactor` et `@better-auth/passkey` progressivement après une preuve ciblée, sans activer le plugin API key ni les webhooks avant leurs sessions. Les façades Nest gardent le contrôle des changements sensibles ; la liste HTTP publique n'expose que les cérémonies nécessaires, avec méthodes exactes, schémas stricts, origine et CSRF. « Public » signifie délégué au protocole d'authentification, pas dispensé des contrôles.

Un service serveur d'assurance est commun aux façades Nest et au résolveur d'accès collaboratif. Une preuve est liée à l'utilisateur, au défi consommable, à son intention (connexion, enrôlement, réauthentification ou récupération), au facteur et à la session **effectivement créée**. Le hook passkey vérifie UV avant création de session ; il ne peut pas encore inscrire l'assurance d'une session inexistante. Corréler sa preuve au résultat serveur, écrire l'assurance avant exposition du succès ; en cas d'échec, supprimer la nouvelle session. Pas de promotion à partir d'un booléen client, de `twoFactorEnabled`, d'un simple 200 HTTP ni de la date de création d'une session.

Une réauthentification passkey peut créer une nouvelle session dans la version installée : transférer les attributs serveur « Poste partagé » et l'identité attendue, refuser une autre identité, puis invalider la session remplacée. Tester les erreurs entre création, assurance et cookie ; aucune session provisoire ne doit accéder aux workspaces exigeant la force. Les changements de facteurs doivent invalider les preuves obsolètes ; prévoir une version de sécurité du compte et une référence de facteur, en plus de `method/verifiedAt`.

### Constats sur la version installée et preuve avant l'interface

Lecture du code Better Auth/passkey **1.7.12**, le 25 octobre : `passkey/dist/index.mjs` utilise `preferred` pour les options et `requireUserVerification: false` dans ses vérificateurs. Les hooks `registration.afterVerification` et `authentication.afterVerification` existent ; celui de connexion précède `createSession`. Imposer `userVerification: required` dans les options serveur **et** rejeter un résultat cryptographique sans `userVerified === true` avant credential/session. Tester UV faux, résultat invalide, défi rejoué, origine/RP ID erronés, changement d'utilisateur et courses entre requêtes. La doc courante ne remplace pas cette vérification de version : [passkey et hooks](https://better-auth.com/docs/plugins/passkey).

Le plugin TOTP a un verrouillage de compte par défaut (10 échecs, 900 s) et une gestion distincte des tentatives de défi. Ne pas laisser un verrouillage partagé contredire la politique de délais de l'ADR 015 : configurer explicitement la protection des facteurs, limiter aussi les tentatives de défis et les vérifications depuis une session déjà ouverte. La preuve doit inclure la concurrence et le rejeu d'un même pas TOTP.

Les codes natifs sont liés à `auth_two_factors` et leur régénération exige `twoFactorEnabled` : ils ne couvrent pas seuls un compte n'ayant que des passkeys. Choix validé : jeu commun de codes de récupération, hors du plugin TOTP, décrit dans l'ADR 004 ; les routes natives de codes restent fermées. Réutiliser la cryptographie des bibliothèques ; ne pas créer un faux secret TOTP pour un compte passkey. [Plugin 2FA](https://better-auth.com/docs/plugins/2fa).

La récupération de mot de passe s'appuie sur `sendResetPassword`, l'expiration configurée et `onPasswordReset` ; la consommation concurrente du jeton, la révocation de toutes les sessions et les effets d'audit seront vérifiés sur le code réel, pas supposés à partir d'une option. Voir [email/mot de passe](https://better-auth.com/docs/authentication/email-password) et ADR 015.

### Évolution du modèle à concevoir, sans migration à cette étape

Conserver les tables de facteurs et d'assurance existantes ; ajouter seulement les données nécessaires : version de sécurité du compte, provenance/expiration des preuves limitées, choix serveur de cache par session, interdiction/version de politique du workspace, compteurs d'essais et éventuel coffre de récupération. Le contrat Drizzle des plugins reste testé ; les données métier supplémentaires sont séparées des champs possédés par Better Auth. Aucun reset des données, upgrade de dépendance ou nouvelle route de test en production n'est décidé ici.

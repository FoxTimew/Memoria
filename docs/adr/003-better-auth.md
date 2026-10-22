# ADR 003 — Better Auth et plugins

Statut : accepté — 2026-10-22.

**Décision.** Better Auth 1.7.12 dans NestJS ; plugins `organization`, `twoFactor`, `@better-auth/passkey` et `@better-auth/api-key` à versions exactes. Adaptateur Drizzle, identifiants UUID générés par Better Auth. Le schéma conserve les noms de propriétés attendus par les plugins, avec noms SQL explicites. Le test `schema-contract.test.ts` vérifie les champs des versions installées.

**Alternatives.** Auth, invitations et clés entièrement personnalisées ; fournisseur SaaS obligatoire.

**Raison.** `organization` couvre memberships/invitations/rôles personnalisés. `apiKey` couvre préfixe, hash, scopes, expiration, révocation et compteurs PostgreSQL atomiques dans la version inspectée. Les réécrire n'est pas justifié. Les permissions de pages restent dans notre service métier. [Organization](https://better-auth.com/docs/plugins/organization), [API Key](https://better-auth.com/docs/plugins/api-key/reference).

**Conséquences.** Configurer explicitement les quatre rôles, un rôle par membre, aucun team/dynamic role. Les invités ne créent pas de clés au MVP ; owner/admin/member peuvent créer une clé sous leurs propres droits, après connexion forte récente. `references: organization`, `enableSessionForAPIKeys: false`, hash activé, stockage database ; ne jamais accepter scopes/émetteur/rate limit fournis sans validation. `api_key_policies` conserve émetteur, acteur, révocation et audit ; une clé sans politique complète est inutilisable. `referenceId` est mappé à `workspace_id`, `lastRequest` à `last_used_at`.

Les endpoints Better Auth sont aussi protégés : les guards Nest ne suffisent pas sur le handler monté. Interdire l'accès HTTP direct aux mutations organization/api-key sensibles ; les façades Nest appellent les API serveur après autorisation/assurance. Adapter aussi les hooks de suppression de facteur/compte. Le handler Express est monté avant les parseurs qui consommeraient son flux. Ne pas désactiver CSRF/origin checks. Le client web reste le client Better Auth pour la connexion et les facteurs.

La révocation met `enabled=false` et `revoked_at` ; une expiration peut faire supprimer la credential par le plugin. La politique/audit survivent avec `credential_id=NULL`. Les memberships révoqués sont supprimés physiquement après nettoyage des références : le plugin ne filtre pas nos soft deletes.

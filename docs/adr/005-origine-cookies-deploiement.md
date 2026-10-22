# ADR 005 — Origine unique et HTTPS local

Statut : accepté — 2026-10-22.

**Décision.** Caddy expose la même origine pour Next.js, `/api/auth`, `/api/internal` et `/v1`. En local : `https://localhost`, `tls internal`, ports Node 3000/3001 ; PostgreSQL, MinIO et Mailpit via Compose. Le certificat public de la CA locale doit être approuvé par l'utilisateur, jamais en désactivant TLS.

**Alternatives.** HTTP local ; front et API sur domaines indépendants ; cookies partagés par défaut sur tout le domaine.

**Raison.** Le comportement Secure/SameSite et les passkeys doivent être exercés dès le développement, sans dépendre des cookies tiers.

**Conséquences.** Configurer Better Auth `baseURL=APP_ORIGIN`, chemin `/api/auth`, `trustedOrigins=[APP_ORIGIN]`, cookies host-only, `HttpOnly`, `Secure` aussi en développement HTTPS, `SameSite=Lax`, `Path=/` pour la session. Aucun `Domain` ni cache de session contenant des droits potentiellement périmés. Le navigateur utilise les URLs relatives et `credentials: include`. Pas de CORS ouvert sur cette origine ; garder les contrôles d'origine/CSRF. RP ID WebAuthn : `localhost`, puis hôte public stable en production, sans port/schéma. Autoriser seulement les proxys connus pour les headers forwarded. [Cookies](https://better-auth.com/docs/concepts/cookies), [Caddy HTTPS](https://caddyserver.com/docs/automatic-https).

**Variante documentée, non implémentée.** `app.example.test` + `api.example.test` : origines distinctes mais même site HTTPS ; `credentials: include`, CORS avec origine exacte, credentials autorisés, jamais `*`, préflight et headers ETag/If-Match/Idempotency-Key explicités. Conserver le cookie host-only côté API si le front est client-side. Si le SSR Next doit partager la session, préférer un proxy same-origin ; un `Domain=example.test` n'est acceptable qu'avec tous les sous-domaines maîtrisés. Des domaines enregistrables indépendants impliqueraient `SameSite=None; Secure` et les restrictions de cookies tiers : hors cible.

SMTP configurable obligatoire en production ; Mailpit en local. Les invitations restent copiables après création, mais leur acceptation exige le compte correspondant à l'email vérifié. Stocker les tokens hachés/chiffrés selon Better Auth ; ne pas journaliser les liens. Les URLs présignées S3 utilisent un endpoint accessible au navigateur, distinct de l'endpoint réseau interne de signature.

# ADR 009 — REST v1, ETag et idempotence

Statut : accepté — 2026-10-22.

**Complément de cadrage session 5, 25 octobre 2026.** Le moteur d'accès proposé dans l'[ADR 019](019-partages-et-acces-collaboratif.md) est commun à l'API de session, la recherche et la collaboration ; l'API publique réutilisera ces prédicats, avec droits actuels de l'émetteur ∩ scopes et restrictions de clé. Aucun credential guest, aucun rôle déclaré par le client, filtrage avant pagination/extraits. `/v1` reste à implémenter en session 8 : R12 exige alors ses propres attaques de bout en bout et quotas, pas une déclaration de sécurité héritée des tests de session 5.

**Décision.** REST `/v1/workspaces/{workspaceId}`, clés liées au workspace, scopes minimaux et mêmes services/autorisations que le front. OpenAPI 3.1 généré depuis Zod ; le futur module Nest le servira à `/openapi.json` avec UI à `/docs`. Le fichier actuel est un contrat de conception, pas une annonce de routes disponibles.

**Alternatives.** GraphQL ; API web distincte en logique métier ; offsets ; nouvelles clés renvoyées en clair à chaque consultation.

**Raison.** REST et objets JSON versionnés sont simples à intégrer dans les moteurs de jeu ; une couche métier commune évite les écarts de permissions et validation.

**Conséquences.** `x-api-key`, préfixe visible et hash conservés, secret retourné à la création seulement. Clé expirée/révoquée ou émetteur retiré = refus. Scopes ET droits courants de l'émetteur, jamais une session utilisateur simulée. Même les relectures d'idempotence revérifient les droits. Rate limit par clé en PostgreSQL ; 429 et Retry-After ; aucun Redis. Les limites d'auth restent séparées.

Curseur opaque signé et lié au workspace, principal, filtre et ordre ; limite 50/max 100. Ordre stable avec UUID final ; les pages illisibles sont exclues avant LIMIT. Pas de promesse d'instantané immuable pendant une pagination ; renvoyer la version et détecter un changement de page pendant l'export de blocs.

`If-Match` protège l'agrégat page (y compris blocs/valeurs de ligne), ETag fort retourné par GET page. 412 en cas de conflit, 428 si absent ; ni wildcard ni ETag faible. Les endpoints documentent explicitement la précondition sur la page parente. Réponses privées `Cache-Control: no-store` au MVP.

Tout POST `/v1` exige `Idempotency-Key`. Unicité `(workspace, acteur, route, hash clé)` ; empreinte méthode+route+corps canonique+préconditions. Réutilisation différente/in-progress : 409. Réserver/enregistrer résultat chiffré et mutation dans la même transaction ; rollback = possibilité de réessayer. Rejouer une réponse validée avant de retester la version devenue obsolète à cause de la première exécution. TTL 24 h configurable. Erreur unique `{error:{code,message,requestId,details?}}`, sans SQL/stack/secrets.

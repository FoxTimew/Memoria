# ADR 002 — Isolation et droits hérités

Statut : accepté — 2026-10-22.

**Complément de session 5, cadrage du 25 octobre 2026.** La frontière retenue est : admin gère member/guest, invitations, partages et cache ; seul owner gère admin/owner et obligation forte. Guest edit peut modifier contenu/titre et créer des sous-pages sous un parent éditable, mais ne peut déplacer, archiver ni restaurer. La condition d'édition source/destination ci-dessous ne suffit donc pas à autoriser un guest à déplacer. Les mutations d'accès exigent une preuve forte de moins de dix minutes. Une promotion guest supprime ses anciens grants explicites avec audit, sans réactivation à une future rétrogradation. Ces arbitrages sont retenus ; le moteur commun, l'aperçu des déplacements, la révocation et le cache sont cadrés dans l'[ADR 019 proposé](019-partages-et-acces-collaboratif.md), sans code applicatif à cette étape. L'[ADR 018](018-invitations-et-arrivee-workspace.md) précise invitations et rôles.

**Décision.** Une base partagée, `workspace_id` et clés étrangères composites pour toutes les données métier. L'identité globale, les sessions et les tables internes de pg-boss sont les exceptions. La table racine `workspaces` porte son propre identifiant. Un compte peut appartenir à plusieurs studios.

`AuthorizationService` calcule les droits sur chaque requête, lecture comme écriture. Owner/admin gèrent les accès ; member lit/modifie tout le contenu. Un guest reçoit des partages `read` ou `edit` sur des pages et leurs descendants. `access_subjects` sépare membres et clés ; `access_grants` porte sujet, type/identifiant de ressource, niveau et héritage. La ressource MVP est une page, y compris une page de base ou une ligne. L'ajout futur de pages privées demandera une règle de visibilité et éventuellement des refus explicites, sans remplacer les tables de partages.

**Alternatives.** Permissions uniquement au workspace ; colonnes de droits sur chaque page ; PostgreSQL RLS comme moteur complet de permissions.

**Raison.** Les prestataires ont besoin d'éditer des sous-arbres précis. Des FK concrètes conservent l'intégrité malgré le vocabulaire générique sujet/ressource.

**Conséquences.** Les droits précèdent pagination, extraits de recherche, relations, fichiers et compteurs. Cumuler les autorisations héritées en prenant le niveau maximal ; aucun « deny » au MVP. Un ancêtre archivé masque ses descendants. Déplacer une page exige l'édition sur la source et la destination et peut changer les bénéficiaires : afficher cet effet avant le déplacement. Les clés utilisent l'intersection de leurs scopes et des droits actuels de leur émetteur ; des partages de clé peuvent les restreindre davantage. Une clé n'accorde jamais plus que son émetteur. Pas de RLS implémentée : un contexte tenant validé est obligatoire dans tous les repositories.

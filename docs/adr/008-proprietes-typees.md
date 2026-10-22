# ADR 008 — Valeurs typées et vue tableau

Statut : accepté — 2026-10-22.

**Décision.** Définitions/choix de propriétés normalisés ; une table scalaire typée et trois tables de liens pour multi-select, personne et relation. Une ligne est une page dans une seule base. JSONB reste réservé aux blocs et aux configurations validées de vues/propriétés.

**Alternatives.** Un JSONB de toutes les valeurs sur la ligne ; une table physique PostgreSQL par base utilisateur ; EAV de chaînes sans types.

**Raison.** JSONB faciliterait les premiers formulaires, mais les tris numériques et de dates exigeraient casts et index d'expression par propriété. Les valeurs typées offrent des index B-tree `(workspace, propriété, valeur, page)` communs à toutes les bases et des FK pour les choix/personnes/relations. Le coût de jointures est acceptable pour une vue tableau de studios de 5–50 personnes.

**Conséquences.** Les FK incluent workspace, base, propriété et type : un nombre ne peut pas être écrit dans une propriété texte. Nombres PostgreSQL `numeric(28,8)` transportés en chaînes pour préserver la précision. Dates civiles séparées des instants avec fuseau ; plages ordonnées. Les choix ont des IDs stables, indépendants des libellés. Absence de valeur = cellule vide ; false reste différent d'une checkbox vide. Personnes = memberships du même workspace. Relations N:N vers les lignes d'une base cible du même workspace ; pas de relation inverse écrite automatiquement.

La suppression de propriété masque ses valeurs et les purge après rétention. Changer le type ou la base cible d'une propriété peuplée est refusé au MVP ; une future conversion explicite sera transactionnelle. Les filtres sont une AST Zod bornée compilée en SQL paramétré, jamais des fragments SQL clients. Tris avec tie-breaker UUID, NULLS LAST ; chaque requête filtre aussi les pages/propriétés archivées et les autorisations. La vue stocke colonnes, filtres, tris et largeurs en JSONB, avec `type=table` ; autres vues exclues.

# ADR 007 — Blocs extensibles et service d'écriture unique

Statut : accepté — 2026-10-22.

**Décision.** Contrat `BlockDefinition` avec type namespacé, version, schéma Zod, migration pure, `toPlainText`, menu et loaders UI. Le registre ne connaît aucun bloc concret ; `blocks/catalog` est la racine de composition explicite. `gamedev.character-card` fournit l'exemple complet, les blocs standard seront intégrés dans la session éditeur.

Un registry est une table qui associe un nom de type à son validateur et ses fonctions. L'ajout d'un bloc modifie le catalogue, pas le cœur ; le serveur n'a besoin ni de React ni du code de rendu pour valider. Les plugins sont des dépendances de confiance déployées avec l'application, jamais du code téléchargé d'un workspace.

**Alternatives.** Switch central sur chaque type ; document HTML opaque ; import automatique de code tiers.

**Raison.** Les moteurs Unity/Unreal/Godot consomment des objets JSON versionnés avec identifiants stables. Les spécificités BlockNote restent dans les adaptateurs.

**Invariant.** Toute écriture de blocs, y compris front, API publique, import, migration de contenu, restauration et purge, passe par `BlockWriteService`. Aucun repository voisin, worker ou script métier n'écrit directement ces tables. Les migrations SQL structurelles et fixtures de test sont les seules exceptions. Le service reçoit la transaction métier ; il valide le batch, les types/versions, l'appartenance des parents, l'absence de cycles et les fichiers liés, puis fait les écritures, incrémente la version, actualise la projection de recherche et ajoute audit/outbox. Le contrat existe, l'implémentation est volontairement absente.

**Yjs ultérieur.** Import initial des blocs dans un document Yjs par page, sauvegarde des mises à jour/checkpoints binaires puis projection SQL pour recherche/API. Les commandes publiques sont traduites en opérations Yjs au même point d'écriture ; aucune seconde autorité JSON concurrente. Autorisations et validation restent côté serveur. La migration des contenus est persistée par le writer, jamais déclenchée silencieusement par un GET. Les modules UI lourds se chargent à la demande ; les specs requises sont chargées avant création du schéma BlockNote, pas ajoutées à un éditeur vivant. [Collaboration](https://www.blocknotejs.org/docs/features/collaboration).

# ADR 006 — Arbres, ordre et conflits

Statut : accepté — 2026-10-22.

**Décision.** Pages/blocs en listes d'adjacence (`parent_id`). Ordre par fractional indexing, collation PostgreSQL `C`, index d'unicité sur les frères vivants y compris à la racine. Une version entière par page protège métadonnées, blocs et valeurs de ligne.

Le fractional indexing affecte une chaîne triable entre deux chaînes existantes : insérer entre `a0` et `a1` ne renumérote pas tout le document. Le serveur calcule ces chaînes ; le client envoie parent et voisin, pas une position arbitraire. Un rééquilibrage des frères est nécessaire avant de dépasser 128 caractères, sous le même verrou et avec des positions temporaires uniques. [Implémentation de référence](https://github.com/rocicorp/fractional-indexing).

**Alternatives.** Index entiers contigus ; arbres matérialisés ; dernier écrivain gagnant.

**Raison.** Déplacements fréquents, petit coût d'écriture et refus explicite des pertes de travail. PostgreSQL récursif suffit au MVP.

**Conséquences.** Pour toute mutation d'arbre, prendre un advisory lock transactionnel par workspace AVANT la lecture puis verrouiller les pages concernées dans l'ordre de leurs UUID. Revalider les droits et les cycles, puis CAS `UPDATE ... WHERE version=expected RETURNING version` dans la transaction. Les triggers rejettent aussi les cycles ; le verrou côté service protège contre les cycles concurrentiels.

Une erreur de version annule tout le batch : erreur de domaine `VERSION_CONFLICT`, 409 pour l'API interne, 412 pour `/v1` avec `If-Match`, 428 si l'en-tête obligatoire manque. Le front vérifie toutes les 15 secondes seulement quand la page est visible, puis au focus et avant sauvegarde ; il avertit sans remplacer le brouillon. Sauvegarde atomique de batches bornés, pas d'écrasement du document complet. Une restauration recalcule une position si l'ancienne est occupée. Déplacer une ligne exige de rester sous sa base ; changer de base est une opération dédiée, hors MVP.

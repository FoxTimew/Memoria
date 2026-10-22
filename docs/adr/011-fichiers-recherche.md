# ADR 011 — Stockage S3 et recherche PostgreSQL

Statut : accepté — 2026-10-22.

**Décision.** Interface `ObjectStorage`, implémentation future AWS SDK S3 compatible, bucket privé, MinIO local. Recherche PostgreSQL plein texte sur une projection par page, construite via `toPlainText` sans HTML.

**Alternatives.** Chemins locaux stockés dans les blocs ; URLs S3 permanentes ; moteur de recherche externe.

**Raison.** Le même protocole fonctionne en SaaS et self-hosted. Les IDs de fichiers restent stables lorsque le fournisseur change. PostgreSQL évite un service supplémentaire.

**Conséquences.** Dans les blocs, conserver `fileId`, jamais une URL présignée. Le service génère une clé objet opaque sous le préfixe workspace, autorise la page, crée une intention d'upload, signe un POST avec limite de taille/type, puis vérifie HEAD avant `ready`. Taille MVP proposée : 50 MiB par fichier, configurable ; images raster autorisées explicitement, pas de SVG/HTML actif affiché inline. Une URL de lecture expire après 60 s ; l'accès est revérifié lors de sa création. `file_references` lie les usages aux pages/blocs pour permissions et garbage collection. Les URLs déjà émises restent valides jusqu'à expiration ; elles ne doivent pas être loguées.

La recherche indexe titre, blocs vivants et valeurs texte autorisées de la page. Configuration `simple` pour identifiants de jeu et textes multilingues, index GIN ; stemming linguistique différé. La projection est actualisée dans la transaction du writer au MVP. Les mutations de valeurs de ligne utilisent le même coordinateur de page pour la recherche. Filtrer workspace/droits/ancêtres archivés AVANT rang, extraits et compteurs ; une projection n'est jamais une preuve d'accès.

MinIO communautaire est archivé depuis avril 2026. Le Compose construit la version corrigée d'octobre 2025 depuis la source pour le local ; un fournisseur S3 maintenu est requis pour la production, sans imposer qu'il soit hébergé par un tiers. [Publication MinIO](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z).

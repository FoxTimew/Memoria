# ADR 011 — Stockage S3 et recherche PostgreSQL

Statut : accepté — 2026-10-22 ; **partie fichiers révisée par le cadrage de session 7 du 28 octobre**, ADR [021](021-transferts-et-service-des-fichiers.md) et [022](022-droits-et-cycle-de-vie-des-fichiers.md) proposés. Les choix explicitement reçus dans ces ADR sont retenus ; aucun service de fichiers n'est livré par cette révision.

**Décision.** Interface `ObjectStorage`, implémentation future AWS SDK S3 compatible, bucket privé, MinIO local. Recherche PostgreSQL plein texte sur une projection par page, construite via `toPlainText` sans HTML.

**Alternatives.** Chemins locaux stockés dans les blocs ; URLs S3 permanentes ; moteur de recherche externe.

**Raison.** Le même protocole fonctionne en SaaS et self-hosted. Les IDs de fichiers restent stables lorsque le fournisseur change. PostgreSQL évite un service supplémentaire.

**Conséquences conservées.** Dans les blocs/cellules, conserver `fileId`, jamais une URL présignée. Clé objet opaque, bucket privé et contrôle des droits de la page/ligne. Le contrat initial POST/HEAD/GET/DELETE reste à implémenter et à étendre au multipart.

**Révision du 28 octobre 2026.** La proposition de 50 MiB est remplacée par les bornes **retenues de 5 Gio/fichier et 250 Gio/workspace**, configurables. HEAD ne valide pas le type réel : quarantaine, inspection serveur et copie finale immuable proposées en ADR 021. Inline uniquement pour images raster réencodées/vignettes ; tous les originaux et formats actifs en téléchargement. Lecture par service dédié retenue, contrôle vivant et fermeture de secours ≤5 s, plutôt que seule expiration d'un GET S3. Les URL courtes ne sont jamais loguées. `file_references` est aujourd'hui une projection : **ne pas l'utiliser seule pour droits ou GC**. Le registre transactionnel minimal et le contrôle de chaque auteur sont proposés dans l'ADR 022 ; la projection complète reste asynchrone.

La recherche indexe titre, blocs vivants et valeurs texte autorisées de la page. Configuration `simple` pour identifiants de jeu et textes multilingues, index GIN ; stemming linguistique différé. Depuis la session 3, les blocs sont projetés de manière asynchrone depuis le journal Yjs (ADR 017) ; le writer hors éditeur attend sa propre projection. Les mutations relationnelles de titre/valeurs de ligne actualisent leur recherche dans leur transaction, indépendamment du corps Yjs. Filtrer workspace/droits/ancêtres archivés AVANT rang, extraits et compteurs ; une projection n'est jamais une preuve d'accès. Pas d'OCR ni d'indexation binaire des fichiers dans la session 7.

MinIO communautaire est archivé depuis le 25 avril 2026 et déclaré non maintenu par son [dépôt officiel](https://github.com/minio/minio). Le Compose construit le tag d'octobre 2025 depuis la source pour le local ; cela ne garantit pas de correctifs actuels. SeaweedFS est le premier fournisseur de production à qualifier, retenu le 28 octobre ; comparaison officielle datée et alternatives en ADR 021. Aucun service tiers hébergé obligatoire.

# Preuve S3 — session 7a

Transport expérimental sans consommateur applicatif. **Ne pas l'utiliser comme service de fichiers autorisé.** Les contrôles de session, droits, intentions, réservations et quotas SQL, référence Yjs par auteur et finalisation concurrente restent à raccorder après passage de la preuve fournisseur.

`pnpm test:storage` construit et lance `src/conformance.ts` contre MinIO local et SeaweedFS 4.51 dans un conteneur jetable. Aucun fichier de production ni bucket existant n'est supprimé ; chaque exécution crée et supprime ses propres buckets aléatoires. Endpoints locaux seulement, aucune URL signée ni clé dans le rapport.

Les constantes de ce transport sont celles de la preuve (120 s, 5 Gio maximum de signature), pas encore une configuration de déploiement exposée. Les fixtures restent petites : 1 Kio POST, parties de 16 + 5 Mio. Les lectures sont consommées en flux ; seules les parties synthétiques du client de test sont en mémoire. Aucun test de débit, de fichier 5 Gio ou de consommation mémoire n'est revendiqué.

Sans option, le test conserve le témoin amont en échec, sans filtrage d'échecs : [diagnostic initial](../../docs/reviews/session-7-7a-stockage.md). Après construction avec `pnpm build:storage:fixture`, **`pnpm test:storage --candidate`** qualifie le correctif SeaweedFS et un MinIO jetable avec CORS global exact : [résultats et limites](../../docs/reviews/session-7-7a-seaweedfs.md). Les deux commandes utilisent la même suite enrichie. La suite S3 exige Docker et n'est pas lancée par `pnpm check` ; les contrôles statiques de ce package le sont.

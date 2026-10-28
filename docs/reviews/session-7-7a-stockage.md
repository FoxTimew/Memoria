# Session 7a — preuve initiale S3 et arrêt sur la reprise

Date : **28 octobre 2026**. Branche **`codex/session-7-files`**. **7a commencée, non terminée : arrêt avant migrations, routes et raccordement applicatif.** Les ADR 021/022 sont acceptés ; leurs ajustements 8K, avertissement de téléchargement et options de sauvegarde sont consignés. L'arrêt applique la règle de conformance de l'ADR 021, sans diminuer les garanties pour faire passer la preuve.

**Suite après arbitrage :** le développeur a choisi de qualifier une correction SeaweedFS. Le [correctif et sa preuve](session-7-7a-seaweedfs.md) lèvent cet arrêt initial sur le protocole fournisseur. Cette fiche conserve le diagnostic historique de `f97b9086` et ses 18 scénarios ; la suite actuelle est enrichie à 23.

## À lire en priorité

1. Cette fiche : résultat réel, explication et choix de reprise.
2. [ADR 021](../adr/021-transferts-et-service-des-fichiers.md) : protocole retenu, coût 8K à mesurer en 7b, analyse locale facultative à chiffrer en 7d. [ADR 022](../adr/022-droits-et-cycle-de-vie-des-fichiers.md#qualification-pré-pilote--deux-options-à-choisir) : options de sauvegarde A/B, coût disque/temps estimé et choix laissé au développeur.
3. [Suite de conformance](../../packages/storage/src/conformance.ts), [transport expérimental](../../packages/storage/src/index.ts) et [lanceur](../../scripts/test-storage.mjs). Aucun import de ce transport dans une application.
4. [Rapport SeaweedFS](evidence/session-7-7a-storage/seaweedfs-4.51.json), [journal complet](evidence/session-7-7a-storage/seaweedfs-4.51.txt) ; [rapport MinIO](evidence/session-7-7a-storage/minio-local.json), [journal complet](evidence/session-7-7a-storage/minio-local.txt).

## Résultat et diagnostic

La suite retourne **exit 1**, sans transformer les défauts en tests ignorés : **MinIO 17/18**, **SeaweedFS 16/18** scénarios fonctionnels réussis, nettoyage compris. Les buckets privés du banc ont été supprimés et le conteneur SeaweedFS jetable arrêté. Aucun volume applicatif réinitialisé. Ce n'est ni un benchmark ni la validation complète de 7a.

### Reprise SeaweedFS : défaut bloquant confirmé

Image testée : `chrislusf/seaweedfs:4.51@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8`, `weed mini`, un conteneur privé, 1 CPU / 768 Mio pour la fixture fonctionnelle. MinIO du Compose existant sert de témoin, pas de recommandation de production.

Reproduction minimale : initier SHA-256, envoyer partie 1 de 16 Mio, **réenvoyer cette même partie avec la même URL encore valide**, puis partie 2 de 5 Mio. Un seul appel SDK `ListParts(MaxParts=1000)` retourne :

```text
MinIO :    IsTruncated=false ; [(1,16777216), (2,5242880)]
SeaweedFS: IsTruncated=false ; [(1,16777216), (1,16777216), (2,5242880)]
```

Le cas isolé n'envoie aucune requête hostile. Ce n'est ni une concaténation incorrecte de pages dans notre adaptateur, ni un dépassement de taille du fichier. La même anomalie apparaît après le scénario de reprise précédé de tentatives de falsification. La [référence S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) prévoit qu'un nouvel envoi du même numéro remplace la partie précédente. Le [code SeaweedFS 4.51 de listing](https://github.com/seaweedfs/seaweedfs/blob/4.51/weed/s3api/filer_multipart.go#L1479) parcourt les entrées physiques suffixées par UUID et retourne chacune ; il ne regroupe pas les versions d'un même numéro. C'est cohérent avec l'observation réelle, sans préjuger du comportement d'une autre version.

Conséquence : notre protocole ne peut pas réconcilier comme prévu une liste unique de parties après retry. Trier et supprimer arbitrairement les doublons masquerait l'écart ; avec deux contenus différents, cela ne prouverait pas quelle version est la dernière, ni la correction de la pagination et des compteurs de stockage. **Aucun contournement n'est appliqué.** Aucun test ne conclut ici à une corruption du fichier final : la suite s'arrête avant finalisation d'une liste ambiguë.

### Finalisation : un défaut du banc corrigé, pas un second blocage fournisseur

La première isolation échouait aussi sans retry (`InvalidRequest HTTP 400`) : [diagnostic intermédiaire](evidence/session-7-7a-storage/seaweedfs-diagnostic-2.json). SeaweedFS ne renvoie pas les checksums de parties dans `ListParts`, contrairement à MinIO. Le banc passait seulement ceux du listing à `CompleteMultipartUpload` ; le checksum SHA-256 requis manquait donc.

Correction du banc : conserver les checksums du **plan signé**, comparer numéros/tailles et tout checksum présent dans le listing, puis transmettre le plan réconcilié. Ce n'est pas faire confiance à des reçus client. La [documentation S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) réserve le listing à la vérification ; le futur service doit persister le plan et rapprocher les reçus au lieu d'utiliser le listing comme unique état métier. Les ETag ne sont jamais assimilés au SHA-256 du fichier. Dans la preuve, les deux corps sont synthétiques et connus du signataire ; aucun service de persistance d'intentions n'est encore livré.

Après correction, **le transfert sans retry passe sur SeaweedFS** : 22 020 096 octets relus en flux, SHA-256 identique à celui des deux parties concaténées. Les deux échecs finaux SeaweedFS concernent exclusivement les listings avec retry. L'absence de checksum dans le listing reste une capacité à traiter explicitement dans le contrat, pas une permission de retirer la vérification d'intégrité.

### CORS MinIO : configuration par bucket indisponible

MinIO local répond **501 NotImplemented à `PutBucketCors`**. Le test ne conclut donc pas sur un preflight correctement configuré pour ce fournisseur. SeaweedFS accepte la configuration et renvoie l'origine exacte attendue. Un client HTTP n'applique pas les règles CORS du navigateur : ce résultat ne remplace pas le futur test navigateur derrière Caddy, ni un test d'origine étrangère.

Piste à qualifier : CORS exact à l'entrée Caddy/configuration globale du stockage selon le fournisseur. Conserver les signatures et buckets privés ; ne pas ouvrir `*` comme solution implicite. Aucun changement des réglages du MinIO existant n'a été effectué. Le 501 est maintenu visible dans le résultat de la suite actuelle.

## Preuves réelles et absences

| Sujet                   | Réellement exécuté                                                                                                                             | Absence / travail restant                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| POST direct             | 1 Kio accepté ; tailles +1 et -1 refusées sur les deux fournisseurs                                                                            | Test navigateur, gros POST à la borne, expiration réelle et réponse ambiguë                                                  |
| Signature de partie     | Longueur, checksum et numéro liés ; corps altéré, longueur excédentaire, transfert chunked sans longueur signée et numéro substitué refusés    | Pas de preuve d'arrêt précoce à l'octet près, ni de débit réseau strict                                                      |
| Multipart               | 16 + 5 Mio, intégrité finale ; retry MinIO passe ; retry SeaweedFS échoue ; abort terminé empêche le rejeu                                     | Pagination multi-réponses, deux versions différentes du même numéro, abort concurrent, crash/reprise 24 h/7 j, fichier 5 Gio |
| Objet final             | Copie vers clé distincte ; modifier staging par un nouveau POST ne modifie pas la copie ; signature d'upload finale interdite par le transport | Course copie/validation, persistance SQL, crash et politique IAM séparée non prouvés                                         |
| Lecture                 | Accès anonyme refusé ; lecture authentifiée en flux ; Range de 100 octets                                                                      | Gateway révocable, tickets 60 s et interruption du flux : 7b                                                                 |
| CORS                    | Configuration et preflight exact SeaweedFS ; 501 explicite MinIO                                                                               | Navigateur, origine hostile, routage Caddy, configuration MinIO                                                              |
| Droits / Yjs / cellules | **Aucun nouveau test** : arrêt avant intégration                                                                                               | Auteur par contribution, références atomiques, mêmes droits source/destination, CAS fichiers et GC                           |
| Quotas / R12 / S5-R11   | Pas de nouvelle route exposée                                                                                                                  | Matrice du cadrage toujours obligatoire avant ouverture, réservations et concurrence SQL non implémentées                    |
| Images / malware        | Décisions enregistrées seulement                                                                                                               | Mesure 8K en 7b ; avertissement interface en 7c ; coût/limites d'analyse locale en 7d                                        |
| Sauvegarde              | Deux options temps/disque documentées, estimations identifiées                                                                                 | Choix développeur puis qualification réelle ; aucun backup 250 Gio exécuté                                                   |
| Performance / mémoire   | **Aucune mesure effectuée**                                                                                                                    | Protocole secteur/Windows/WSL/swap et plafonds inchangés ; collaboration et transferts à mesurer après passage du protocole  |

Les rapports publiés n'incluent ni clés, URL signées, noms personnels ni corps d'erreur S3. Cela ne constitue pas l'audit de fuites de toute la future chaîne API/Caddy/worker/S3, prévu en 7d. Le test utilise des droits administrateur sur des buckets jetables locaux ; il ne qualifie pas les futures permissions IAM minimales.

## Guide de reproduction manuel, environ deux minutes hors installation

1. Se placer à la racine du clone avec Node 24, pnpm et les hooks installés. `pnpm install --frozen-lockfile`, puis `pnpm hooks:check`.
2. Démarrer l'infrastructure locale existante (`pnpm infra:up`) et vérifier MinIO sur le port local 9000. Le fichier `.env` local fournit `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, jamais à copier dans un ticket. Le port 18333 doit être libre.
3. Lancer **`pnpm test:storage`**. Le lanceur construit la preuve, crée uniquement son conteneur SeaweedFS éphémère sur `127.0.0.1:18333`, puis exécute les deux fournisseurs. Le premier lancement peut télécharger l'image épinglée.
4. Constater la fin : MinIO **17/18**, SeaweedFS **16/18**, code de sortie **1**. Lire `.local/storage-proof/minio-local.json` et `seaweedfs-4.51.json` : l'observation `single ListParts response retry=true` isole le doublon. Ces nombres décrivent la version qualifiée ici, pas des échecs à ignorer.
5. Vérifier les lignes `owned fixture cleanup` et l'absence de conteneur `memoria-storage-proof-*` après la commande. En cas d'arrêt forcé, identifier précisément le conteneur/bucket de cette exécution avant tout nettoyage ; ne pas supprimer les buckets applicatifs.
6. `pnpm check` vérifie les hooks, lint/format, typage des packages, bootstrap Nest et tests existants. Il ne lance pas Docker ni la suite S3 ; un check vert ne lève donc pas cet arrêt. **Il n'y a pas encore de parcours de fichiers testable dans l'interface.**

## Ce qui pourrait casser et arbitrage

| Choix                                                                     | Intérêt                                                          | Coût / condition                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recommandé : qualifier un correctif ou une version corrigée SeaweedFS** | Conserver le fournisseur libre retenu et le protocole de reprise | Vérifier versions de parties, pagination, nettoyage, checksums et retries concurrents dans cette même suite ; un correctif local crée une maintenance à assumer. Pas de version corrigée déclarée disponible ici. |
| Qualifier un autre fournisseur maintenu                                   | Éviter de porter un correctif SeaweedFS                          | Rejouer toute la conformance, revoir exploitation/licence/coût selon les options de l'ADR 021. Garage et AIStor ne sont pas déclarés compatibles sans test.                                                       |

Le défaut touche la reprise, qui est une exigence des gros assets ; elle n'est pas retirée du MVP. Après décision, finir cette preuve puis reprendre migrations, limites atomiques, registre de références par auteur, CAS et attaques applicatives, avant mesures collaboratives et clôture 7a. Aucun risque ni fournisseur n'est marqué accepté par cette livraison.

## Contrôles du dépôt

**`pnpm check` réussi** : hooks présents, lint/format, typage récursif des 14 packages et applications, bootstrap Nest, **30 fichiers de tests réussis, 1 ignoré ; 166 tests réussis, 6 ignorés**. [Journal complet](evidence/session-7-7a-storage/check.txt). Les six scénarios SQL opt-in existants n'ont pas été relancés : aucune migration ni mutation SQL dans cette livraison. Les contrôles Git pré-commit/pré-push restent actifs. La commande S3 séparée conserve son échec et le [journal complet du lanceur](evidence/session-7-7a-storage/storage-command.txt), sans masquer les trois scénarios échoués cumulés entre fournisseurs.

Le premier lint a repéré le bundle AWS généré dans `.local` comme du code source ; le lanceur écrit maintenant dans `packages/storage/dist`, comme les autres builds du monorepo. Aucune règle de lint ou de hook n'a été supprimée. Les rapports finaux ont été rejoués avec ce lanceur. Le hash poussé est fourni dans le compte rendu après comparaison avec la référence distante ; les résultats S3 constituent la preuve de l'arrêt, pas une suite verte.

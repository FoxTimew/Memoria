# Session 7b — type réel, images et lecture révocable

29 octobre 2026. Branche `codex/session-7-files`. À relire avant 7c ; aucun parcours produit de fichiers ajouté au front. Les [ADR 021](../adr/021-transferts-et-service-des-fichiers.md) et [022](../adr/022-droits-et-cycle-de-vie-des-fichiers.md) restent acceptés. La source 8K donne deux dérivés WebP, 2 048 et 512 px ; l'original reste uniquement téléchargeable.

## Lire en priorité

1. [Garde-fou Docker](../../scripts/docker-test-isolation.mjs) et son [test sur l'inventaire réel](../../scripts/docker-test-isolation.e2e.mjs) : un volume de développement, même en lecture seule, empêche le démarrage. Projet, bind parent/enfant, ports, réseau host et options non inspectables sont refusés. Les lanceurs existants sont raccordés ; le test S3 témoin utilise désormais aussi un MinIO jetable, sans viser le port du stockage de développement.
2. [Décodeur isolé](../../infra/file-validator/validate.mjs), [orchestration](../../packages/storage/src/validate.ts), [migration 0034](../../packages/db/drizzle/0034_file_validation_reading.sql) : octets réels, disque privé, ressources bornées, variantes immuables, époque du job et recontrôle avant publication.
3. [Droits de lecture](../../packages/db/src/file-reading.ts), [tickets](../../packages/storage/src/read-ticket.ts), [gateway](../../apps/files/src/gateway.ts), [commandes Nest](../../apps/api/src/modules/files/read.controller.ts). Aucun droit depuis la projection ; la référence courante, la session, l'assurance et les politiques restent requis.
4. [Attaques serveur](../../apps/api/src/file-reading.e2e.ts), [navigateur HTTPS](../../apps/api/src/files-browser.e2e.ts), [guide d'exploitation](../self-hosting.md#validation-et-lecture-des-fichiers--7b-29-octobre-2026). Les preuves et leurs limites ci-dessous font partie de la relecture.

## Résultat et points fragiles

Le worker vérifie à nouveau le hash de la copie finale en streaming, lance un convertisseur sans réseau/credentials et publie après contrôle transactionnel. Un nom `.jpg` ou un Content-Type déclaré ne permet jamais de rendre un HTML/SVG inline. JPEG/PNG/WebP statiques sont décodés et réencodés sans EXIF/GPS ; inconnu, format actif, multipage ou dimensions excessives restent sans aperçu. Un raster malformé est rejeté. Une validation de type n'est pas une analyse antivirus.

Le nouveau processus `apps/files` lit RustFS en streaming avec backpressure, limite Range à une plage et applique les en-têtes de sécurité. Ticket chiffré/authentifié de 60 s ; droits relus à chaque GET/HEAD et pendant les flux. La notification et le contrôle périodique coupent l'accès révoqué ; l'indisponibilité PostgreSQL coupe aussi le flux. Une perte de connexion LISTEN demande actuellement un **redémarrage du gateway**. Il refuse les lectures jusque-là.

Ce qui peut casser à l'installation : migration oubliée, image du convertisseur absente/digest invalide, droits du dossier temporaire sous Linux, absence de credentials GetObject distincts en production, DNS/TLS/Caddy non configurés pour `files.<domaine>`. Sans image le worker laisse les fichiers privés et avertit. Le Docker de l'exploitant est privilégié : le worker qui le pilote doit rester de confiance ; le conteneur décodeur n'a pas son socket. Le quota logique et `statfs` ne remplacent pas une réserve physique du disque temporaire.

Une fixture ne partage plus les volumes Caddy. L'[empreinte active et autosave](evidence/session-7-7b/caddy-unchanged.json) est restée identique à celle restaurée en 7a, sans reload/redémarrage. Le Caddyfile proposé a été adapté en lecture seule. Les inspections/démarrages du proxy de test WSS passent dans un processus séparé pour ne pas bloquer le heartbeat du serveur testé.

## Mesures 8K réellement exécutées

Commande `pnpm measure:files:images`. [Échantillons complets](evidence/session-7-7b/images.json), [hygiène et vmstat](evidence/session-7-7b/hygiene), [journal](evidence/session-7-7b/images-measurement.txt). Image `sha256:c1f86b63d0401c9295060c7d9386c966b4f3742e1ebfd9ef572ea4712800abbc`, sharp 0.35.5/libvips 8.18.7. Trois séries, dix échantillons par profil et par série ; le p95 de dix échantillons est ici le maximum. Deux PNG RGB8 8 192 × 8 192 : aplat compressible et bruit déterministe (graine `0x7b8192`). Décodage/réencodage vers fichiers, source jamais entière dans Node hôte. Un seul conteneur à la fois, 1 CPU, 512 Mio sans swap. Aucun build/test en parallèle des séries.

| Mesure                                             |    Série 1 |    Série 2 |    Série 3 | Médiane des p95 |
| -------------------------------------------------- | ---------: | ---------: | ---------: | --------------: |
| Aplat, décodage + réencodage p95 (ms)              |    594,763 |    633,005 |    610,757 |     **610,757** |
| Bruit, décodage + réencodage p95 (ms)              | 13 626,664 | 14 068,707 | 13 597,963 |  **13 626,664** |
| Aplat, traitement total dans le conteneur p95 (ms) |    612,109 |    652,205 |    627,805 |     **627,805** |
| Bruit, traitement total dans le conteneur p95 (ms) | 13 644,407 | 14 085,954 | 13 613,412 |  **13 644,407** |
| Aplat, appel Docker complet p95 (ms)               |  1 239,296 |  1 265,590 |  1 246,045 |   **1 246,045** |
| Bruit, appel Docker complet p95 (ms)               | 14 210,358 | 14 646,703 | 14 194,449 |  **14 210,358** |

| Pic mémoire (Mio), maximum de chaque série | Série 1 | Série 2 | Série 3 |
| ------------------------------------------ | ------: | ------: | ------: |
| Aplat, RSS native comprise                 |  127,47 |  151,77 |  127,54 |
| Bruit, RSS native comprise                 |  153,76 |  154,16 |  154,00 |
| Aplat, charge cgroup                       |   78,48 |  101,62 |   78,25 |
| Bruit, charge cgroup                       |  104,33 |  104,88 |  105,04 |

RSS et charge cgroup ne mesurent pas les mêmes pages partagées ; les publier séparément, sans les additionner. La limite Docker porte sur le cgroup. Toutes les conversions sont sous 30 s et 512 Mio. **Concurrence maintenue à un**, sans réduire la source 8K. Cette preuve ne mesure ni un TIFF/EXR, ni tous les JPEG/WebP/profondeurs de couleur, ni le téléchargement préalable d'un original de 5 Gio. La charge mixte et la latence collaborative avec conversion sont en 7d.

| Avant série (après préparation) | Windows libre, Gio | WSL MemAvailable, Gio | Secteur | Swap |
| ------------------------------- | -----------------: | --------------------: | ------- | ---- |
| Aplat 1                         |              3,374 |                 5,316 | 2       | 0    |
| Bruit 1                         |              3,389 |                 5,234 | 2       | 0    |
| Aplat 2                         |              3,601 |                 5,284 | 2       | 0    |
| Bruit 2                         |              3,541 |                 5,222 | 2       | 0    |
| Aplat 3                         |              3,524 |                 5,301 | 2       | 0    |
| Bruit 3                         |              3,460 |                 5,231 | 2       | 0    |

Les contrôles avant préparation sont aussi versionnés ; 524 intervalles vmstat, si/so nuls pendant les six séries. La tentative précédant la libération de RAM a été refusée à 2,26 Gio Windows avant préparation : elle ne produit aucun résultat de performance. Le parent de production impose 30 s ; le lanceur utilisé pour les mesures avait un timeout d'infrastructure de 35 s, avec refus explicite dès qu'un résultat de traitement atteignait 30 s. Aucun échantillon ne s'approche de ces bornes.

## Matrice R12 / S5-R11

Préfixe des commandes : `/api/internal/workspaces/:workspaceId/files`. Toutes sont des POST, sous guard Nest global, identité injectée, origine/CSRF, admission 4 actives/20 en attente/1 s. Corps ≤64 Kio, lots ≤100. Budgets par minute IP/compte : **L 6 000/120**, **M 1 500/30**. Le gateway exige un ticket et ses contrôles SQL ; il n'emploie pas le guard Nest, qui n'est pas son framework. Son `/health` privé et OPTIONS sont des exceptions explicites sans octet métier.

| Route / frontière                                 | Quota                                                                 | Attaque exécutable et preuve                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/resolve`                                        | L                                                                     | UUID autre tenant/page, champs supplémentaires, session absente/restreinte, MFA imposée : refus ; aucune métadonnée cachée. `file-reading.e2e.ts`                                                                                                                             |
| `/read-tickets`                                   | L                                                                     | ID deviné, clé S3 injectée, mauvais périmètre, dérivé inexistant : aucun ticket ; expiration/altération/rejeu après retrait testés. Même suite                                                                                                                                |
| `/:fileId/archive`                                | M                                                                     | guest refusé, mauvais CAS 409, authentification/CSRF ; effet immédiat sur ticket. Même suite                                                                                                                                                                                  |
| `/:fileId/restore`                                | M                                                                     | guest refusé, CAS et authentification/CSRF ; ticket antérieur toujours invalide. Même suite                                                                                                                                                                                   |
| `GET/HEAD files…/v1/files/:ticket`, Range compris | D : 12 000/IP, 240/compte **et** session ; 4 flux/compte, 32/instance | Ticket forgé/expiré, query pour forcer HTML, méthode interdite, Range multiple/hors borne, faux X-Forwarded-For ; contrôle courant et budgets SQL réels. Même suite                                                                                                           |
| Flux déjà ouvert                                  | contrôle toutes les secondes                                          | Client HTTP réellement mis en pause sur 16 Mio ; retrait de référence, retrait grant guest, déconnexion, session expirée, terminaison des connexions PG. Fermeture <5 s ; flux owner sans rapport conservé. Notification de fichier supprimée volontairement : secours prouvé |
| Validation/publication                            | hors route publique                                                   | JPEG sous nom HTML → deux WebP ; HTML/SVG sous nom image → téléchargement ; EXIF/GPS retirés ; JPEG tronqué rejeté ; 8 193 px sans aperçu. Vrai convertisseur/RustFS                                                                                                          |
| Job tardif et GC                                  | époque + verrou de fichier                                            | Remplacement de l'époque après une vraie écriture de dérivé : aucune publication ; collecte des variantes abandonnées même après nettoyage du staging ; reprise puis GC des variantes retenues, compteurs exacts                                                              |
| Origines et fuites                                | CORS exact, sans credentials                                          | Edge HTTPS/Caddy réel : pas de cookie, origine étrangère bloquée, retrait →404 ; provoquer 502 et vérifier absence du ticket/nom dans les **vrais** journaux stderr/stdout                                                                                                    |
| Isolation des bancs                               | refus avant démarrage                                                 | Montage du vrai volume de développement refusé, conteneur jamais créé ; collisions projet/bind/port testées unitairement                                                                                                                                                      |

Le test navigateur emploie une troisième origine HTTPS dédiée à la lecture, `uploads.localhost` sur un port privé distinct de l'upload, avec le certificat feuille déjà approuvé. L'application est sur `localhost`, donc cookies host-only séparés. Il prouve le protocole cross-origin, pas encore l'installation DNS/TLS finale de `files.<domaine>` ni le composant front de 7c. Aucun contournement de certificat.

Fuites : seules métadonnées autorisées dans `/resolve` et nom échappé dans Content-Disposition ; ticket chiffré sans noms. Erreurs applicatives fixes ; audit IDs/action sans URL, secret ni nom. Le test 502 exige qu'une erreur Caddy ait réellement été enregistrée avant d'en vérifier l'absence de canaris. Aucun journal d'accès brut ajouté. Le téléchargement et l'URL de lecture sont des canaux fonctionnels sensibles, pas des données de télémétrie.

## Contrôles et portée des preuves

Les journaux finaux complets sont dans [evidence/session-7-7b](evidence/session-7-7b). Les totaux `node:test` incluent les tests parents, ils ne doivent pas être additionnés comme des scénarios indépendants.

| Commande                                     | Résultat / portée                                                                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                 | Hooks installés, lint, types, bootstrap Nest ; **176 tests Vitest passent, 6 sautés** (suite de schéma exigeant TEST_DATABASE_URL, exécutée séparément par `test:db`) |
| `pnpm test:files:reading`                    | **14/14**, vrai Nest/PG/RustFS/décodeur/gateway ; sauvegarde locale incluse                                                                                           |
| `pnpm test:files:images`                     | **5/5**, décodeur isolé réel                                                                                                                                          |
| `pnpm test:files:browser`                    | **1/1**, parcours HTTPS Edge, transport multipart/reprise puis lecture/révocation/CORS/502                                                                            |
| `pnpm test:docker:isolation`                 | **1/1**, inventaire Docker réel                                                                                                                                       |
| `pnpm test:storage:rustfs`                   | **23/23**, image officielle inchangée ; la suite rouge SeaweedFS reste conservée                                                                                      |
| `pnpm test:storage`                          | MinIO jetable **23/23**, SeaweedFS officiel **18/23**, témoin rouge attendu et conservé ; pas de changement fournisseur                                               |
| `pnpm test:files:e2e`, `:races`, `:recovery` | **11/11**, **6/6**, **10/10**, régressions transferts, GC et réponses ambiguës                                                                                        |
| `pnpm test:files:boundaries`                 | **16/16**, **7/7**, **3/3** : auteur/Yjs/cellule et WSS/HMAC réels, registre autoritatif                                                                              |
| `pnpm test:db`                               | **6/6** invariants sur un schéma PostgreSQL isolé, migrations jusqu’à 0034                                                                                            |

Le premier exercice backup utilise un vrai dump PG et **quatre objets** chiffrés/restaurés dans un schéma et un RustFS distincts, puis invalidation des sessions/replay d'une suppression. Manquant/corrompu/non-vide sont refusés. Pas de CLI opérateur complète, pas de mesure RPO/RTO ni de qualification 250 Gio. Les primitives demandent de figer l'installation ; les deux options A/B restent à choisir avant pré-pilote.

## Guide de relecture manuelle (15–20 minutes, avant interface 7c)

1. Garder l'infrastructure locale active. Dans un terminal à la racine, lancer `pnpm hooks:check`, puis `pnpm files:validator:build`. Attendre le digest immuable ; cette commande sans option ne modifie pas `.env`. Les tests suivants créent leurs propres schémas et conteneurs, sans effacer vos workspaces.
2. Lancer `pnpm test:docker:isolation`. Résultat attendu : un test vert confirmant le **refus**, aucun conteneur au nom `memoria-isolation-refused-*`. Ne pas monter soi-même un volume de développement pour « essayer ».
3. Lancer `pnpm test:files:images`. Lire les quatre assertions : JPEG réencodé sans métadonnées, HTML et SVG sans aperçu, largeur excessive sans décodage. Les exemples restent sous `.local/image-tests` si vous souhaitez inspecter les sorties WebP ; jamais l'original actif dans l'application.
4. Lancer `pnpm test:files:reading`. Observer les refus de guest/CAS, le job tardif, le flux coupé et le flux owner conservé, puis les deux lignes fixes `Database idle connection failed` **attendues** lors de la panne injectée. Le résultat final doit être 14 tests réussis, aucun échec. Le test restaure seulement ses données synthétiques.
5. Lancer `pnpm test:files:browser`. Edge doit disposer de la confiance TLS locale déjà approuvée. Attendre le résumé vert et ouvrir le `report.json` indiqué : `noCookie`, `untrustedCorsBlocked`, `revokedTicket404`, `proxyErrorWithoutTicket` vrais. Ce banc pilote une page de protocole ; le bouton d'upload, la galerie et l'avertissement avant téléchargement arrivent en 7c.
6. Lire les tableaux 8K et les limites ci-dessous. Il n'est pas nécessaire de relancer les mesures pour la relecture ; si vous le faites avec `pnpm measure:files:images`, secteur obligatoire, aucun autre build/test, protocole mémoire Windows/WSL et swap inchangé. Un échec impose l'arrêt, pas un relèvement de seuil.

Pour activer ensuite ces services sur les données locales, suivre le [guide d'exploitation](../self-hosting.md#validation-et-lecture-des-fichiers--7b-29-octobre-2026) : image/digest, migration 0034, worker, gateway et Caddy coordonnés. Le Caddy actif n'a volontairement pas été rechargé par les tests. Le test manuel à deux personnes via l'interface produit est réservé à 7c.

## Limites et suite, sans acceptation implicite

| Point                                                | Recommandation / étape                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Malware et fichiers actifs téléchargés               | Avertissement obligatoire 7c, option antivirus local et décision en 7d ; ne jamais présenter « validé » comme « sain »                                       |
| CPU et formats 8K non couverts                       | Une conversion à la fois ; mesurer charge mixte et autres textures représentatives en 7d, conserver 8K et arrêts convenus                                    |
| Saturation/control timeout du gateway                | Échec fermé ; tester capacité, saturation CPU, reconnexion client et droits en 7d ; redémarrage nécessaire après perte LISTEN actuellement                   |
| Ticket porteur, octets déjà remis, onglet hors ligne | TTL court et live checks ; impossibilité d'effacer un téléchargement déjà reçu ; tests de rendu/cache/onglet retardataire 7c                                 |
| Routes en lot et contrôle par flux                   | Prouvés fonctionnellement ; pas de capacité 50 comptes déclarée, à intégrer à la charge 7d/S6-R13                                                            |
| Isolement Docker                                     | Protection contre erreur de fixture, pas contre l'opérateur contournant les scripts ni le compromis de l'hôte Docker ; conserver revue des nouveaux lanceurs |
| Sauvegarde et crash fournisseur                      | Premier exercice seulement ; CLI/procédure opérateur, volume A/B, crash/restauration RustFS et RGPD obligatoires pré-pilote                                  |
| Reçu WSS historique et CONTROL_UNAVAILABLE           | Investigations 7d maintenues, contenu <200 ms en charge mixte, historique surveillé et rebasage pré-pilote ; aucun seuil modifié                             |

Arrêt pour relecture de 7b. Aucune PR créée ni fusionnée, aucune acceptation de risque au nom du développeur.

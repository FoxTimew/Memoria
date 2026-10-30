# 7d — convertisseur permanent, échange privé

30 octobre 2026. Décision du développeur : dossier d'échange sans réseau. Cette fiche complète la [revue 7d](session-7-7d-revue.md) ; elle ne clôt pas encore la charge mixte ni la session.

## À lire en priorité

- [Compose](../../compose.yaml) et [image](../../infra/file-validator/Dockerfile) : service permanent, init, utilisateur 1000, réseau `none`, racine en lecture seule, capacités retirées, `no-new-privileges`, 1 CPU, 512 Mio sans swap, 64 PID.
- [Superviseur](../../infra/file-validator/service.mjs) et [confinement Linux](../../infra/file-validator/isolate.c) : un seul décodeur, limite de 30 s, groupe de processus tué à sa sortie, filtre seccomp hérité et Landlock. Le noyau doit fournir Landlock ABI ≥3 ; aucun repli moins sûr.
- [Échange et copie privée](../../packages/storage/src/exchange.ts), [vérification WebP](../../packages/storage/src/derivative.ts), [publication](../../packages/storage/src/validate.ts) : aucun appel Docker dans le worker, époque SQL et droits revérifiés avant publication.

## Protocole et frontières

Le worker détient le verrou de validation global PostgreSQL et refuse une nouvelle tâche si le dossier contient **le moindre résidu**. Chaque tâche possède un UUID aléatoire, un nonce, une expiration et ses sous-dossiers input/output. Le fichier source est recopié en flux avec recalcul SHA-256, sous un nom temporaire ; après fsync, un renommage atomique le rend visible. La demande JSON suit le même protocole. Le convertisseur la réclame par renommage, traite la source et publie les dérivés puis le résultat par renommage atomique. Le sondage toutes les 250 ms fonctionne aussi sur les montages Windows ; aucune dépendance aux notifications de fichiers.

Le dossier est réservé **au worker et au convertisseur**, jamais à Caddy, Nest, collab ou au gateway. Sur Linux, son propriétaire doit correspondre à l'UID 1000 et son mode être 0700 ; sur Windows, le mode POSIX ne remplace pas une ACL NTFS réservée au compte du worker et à Docker Desktop. Le répertoire privé du worker reste **hors de tout montage du convertisseur**. Les fichiers ne portent ni nom utilisateur, ni clé S3, ni ticket ou identifiant de stockage.

`network_mode: none` conserve techniquement une boucle locale ([documentation Docker](https://docs.docker.com/engine/network/drivers/none/)). Le filtre seccomp supplémentaire interdit la création de sockets TCP, UDP et UNIX, y compris cette boucle. Il est hérité par le superviseur et le décodeur ; les commandes Docker de l'opérateur ne font pas partie de cette frontière. Le filtre est empilé sur celui de Docker, jamais un profil `unconfined`.

Le montage Windows ne permet pas de s'appuyer sur une règle Landlock par sous-dossier : le test réel refuse même la lecture autorisée. La règle porte donc sur le **montage d'échange en lecture seule**, avec l'invariant testé d'une seule tâche et d'aucun résidu. Les écritures du décodeur se limitent à un tmpfs de **12 Mio** ; liens, sous-dossiers et écritures dans l'échange sont interdits. Le superviseur copie seulement les deux fichiers attendus, ensemble ≤10 Mio. Landlock est un confinement supplémentaire non privilégié ([documentation du noyau](https://docs.kernel.org/userspace-api/landlock.html)), pas une preuve contre toute vulnérabilité du noyau ou du runtime.

Quota configurable `FILES_VALIDATOR_EXCHANGE_BYTES`, **6 Gio par défaut** : source jusqu'à 5 Gio, réservation de 24 Mio pour les sorties temporaires/copie privée, fichiers déjà retenus comptés, et au moins 128 Mio de marge sur le disque. L'admission unique et le volume de sortie borné empêchent le décodeur de remplir le disque hôte. Ce quota est un contrôle applicatif des écritures du worker, **pas un quota de système de fichiers contre un administrateur** ; réserver le dossier sur un volume dédié à quota reste une protection d'exploitation possible. Aucun original entier dans la mémoire Node ; seules les sorties, ensemble ≤10 Mio, sont lues pour leur vérification.

Le worker copie les sorties dans son répertoire privé avant de les valider. Il vérifie octets, SHA-256, signature et structure RIFF/WebP, dimensions 2048/512, absence de chunks EXIF/XMP/ICC, animation, chunks inconnus et octets après le conteneur. Une signature raster source bornée est revérifiée sans lancer de parseur général d'archives dans le worker. Le décodeur complet reste dans le conteneur. La vérification indépendante n'est pas un second décodage du flux compressé ; cette limite figure dans le tableau des risques. Les originaux restent toujours en téléchargement, quelle que soit leur classification.

Une source en cours de copie expire après dix minutes ; une demande publiée expire après 60 s, avec attente worker limitée à 35 s et décodeur à 30 s. Après crash worker, le superviseur supprime les tâches expirées reconnues. Après crash convertisseur, Compose le relance ; une tâche déjà réclamée est marquée à réessayer, jamais reprise à partir de sorties partielles. Le worker garde les refus/retards en quarantaine et réessaie via le mécanisme SQL existant. Les copies privées abandonnées expirent après une heure. Aucun nettoyage récursif d'un contenu inconnu : résidu inconnu conservé et admission bloquée pour intervention de l'exploitant.

## Preuves et limites

- `pnpm check` final : 187 tests réussis, six SQL ignorés ; le nouveau test analyse les dépendances applicatives de la validation et refuse `child_process` ou un chemin/socket Docker. Le premier refus de formatage de deux preuves JSON est conservé avec le journal complet de la relance réussie ; aucun hook contourné.
- `node --test scripts/test-file-converter.mjs` : cinq sous-scénarios réels, six tests avec le parent. Configuration Docker inspectée, refus TCP externe/boucle/IPv6/UDP/UNIX, écriture hors tmpfs/liens refusés, ENOSPC à 12 Mio, demande temporaire ignorée/nettoyage après expiration, mort réelle du superviseur puis reprise automatique sans publication partielle.
- `exchange.test.ts` : faux nonce, expiration, type, taille, empreinte, dimensions, contenu actif, lien physique, quota, résidu, source partielle et copie privée stable après mutation de l'échange.
- `pnpm test:files:reading` : 15 tests réels réussis avec le nouveau worker, RustFS, HTTP, contrôle courant, job tardif et révocation en cours de lecture.
- `pnpm test:files:images` : les quatre cas JPEG/EXIF/GPS, HTML déguisé, SVG actif et largeur 8193 passent sur le service permanent.

Les [journaux complets et leur manifeste](evidence/session-7-7d-convertisseur/manifest.json) sont versionnés. L'interface finale passe également son test réel : upload depuis cellules/éditeur, aperçu, avertissement, guest et résurrection du cache. Un marqueur interrompu simule la frontière de tâche au moment du crash : pas une campagne exhaustive de crash à chaque instruction. L'exercice de coupure physique, les ACL de l'installation et tous les codecs/profondeurs restent à qualifier avant pilote. Aucun accès applicatif au socket Docker ; les scripts de construction, d'exploitation et les fixtures utilisent naturellement le Docker de l'opérateur, avec contrôle d'isolation pour les fixtures.

## Six séries 8K

Dix conversions par série et profil, même protocole secteur/mémoire/absence de swap. Durée interne du décodeur (détection + décodage/réencodage), en millisecondes :

| Profil PNG RGB8 8192²  | p95 série 1 |    Série 2 |    Série 3 | Médiane des p95 |
| ---------------------- | ----------: | ---------: | ---------: | --------------: |
| Uniforme               |     591,452 |    597,199 |    548,995 |     **591,452** |
| Bruit peu compressible |  13 260,249 | 14 471,093 | 13 434,965 |  **13 434,965** |

Pic cgroup maximal **125,32 Mio**, pic RSS du décodeur **154,02 Mio** (compteurs distincts, pas une somme). Le temps côté worker inclut copie, sondage et validation : médiane des p95 **1 054 ms / 14 332 ms**. Les 60 conversions respectent 30 s/512 Mio ; aucun swap. Concurrence maintenue à un, source inchangée à 8192². Ces textures synthétiques bornent deux compressibilités ; ce ne sont pas tous les formats/profondeurs d'un studio.

Image mesurée `sha256:80558ec2d536de45cae593805fbff8002e1ac2468c2377dee6adb49debdf4f89`. L'image finale des tests de confinement/UI, `sha256:a81a1233e3149456572289790c91cc8528553f1ebb90a39f91443746dfd486d6`, ajoute uniquement le nettoyage d'une création de marqueur interrompue. Aucun changement du décodeur ou des limites ; les six séries ci-dessus ne sont pas présentées comme une nouvelle campagne sur ce second digest.

## Arrêt de la charge mixte

Le premier montage utilisait cinq pages de 1 Mio : refus normal de la cinquième, 1 216 Mio de réservation demandés pour 1 024 Mio configurés. **Choix du développeur le 30 octobre : une page de 1 Mio et quatre pages typiques ≤200 Kio**, dix comptes/deux rédacteurs par page, budget inchangé. Les pages typiques font ici 177 262 octets ; réservation totale au plus 544 Mio. Deux erreurs de fixture ont ensuite été corrigées avant mesure exploitable : identifiants de blocs copiés entre pages, puis UUID remappés non conformes. Ces refus et le refus mémoire initial sont conservés, aucun contrôle applicatif contourné.

Une seule série **sans conversion** passe : 10 vagues d'échauffement puis 100 vagues, 1 000 reçus. Pour la page de 1 Mio : **18,958 ms serveur, 13,974 ms SQL, 44,292 ms reçu auteur, 44,570 ms application chez l'autre client** au p95. Pour les quatre pages typiques, p95 serveur 17,136–17,888 ms ; reçus 40,737–45,013 ms. Convergence finale des deux documents par page vérifiée. Ce résultat isolé ne remplace pas trois séries ni la comparaison avec main.

Les durées auteur/serveur restent mesurées dans chaque processus. Pour l'application distante, dix échanges IPC estiment l'offset des horloges monotones ; le meilleur aller-retour fournit l'incertitude, conservée pour chaque échantillon. Cette estimation n'isole pas le réseau aller ni le navigateur final : clients Hocuspocus synthétiques, sans délai de flush du composant React. La trace historique initiale reste dans sa [fiche WSS](session-7-7d-wss.md).

Le palier avec conversion échoue **à la vague d'échauffement 0** : `DURABLE_RECEIPT_TIMEOUT`, auteur 4 déjà déconnecté, raison vide. Aucune conversion terminée ni p95 de ce palier ; protocole mémoire conforme (1,501 Gio Windows après préparation, 5,143 Gio WSL, secteur, zéro swap). **Campagne arrêtée, pas de nouvelle optimisation ni changement de délai.** Le journal ne contient pas `CONTROL_UNAVAILABLE` : il serait incorrect d'attribuer cette fermeture au contrôle SQL ou de déclarer le scénario CPU demandé reproduit.

Piste de diagnostic : le banc connecte ses clients sans présence avant la préparation des textures. Le provider Hocuspocus applique `messageReconnectTimeout=30000` et peut appeler `webSocket.close()` sans raison après cette inactivité. Les premiers déchargements apparaissent pendant la préparation ; le journal actuel ne donne pas le code et l'heure de fermeture de chaque client. **Hypothèse à confirmer**, pas une cause prouvée. Recommandation : instrumenter ces événements et la dernière réception, puis préparer les textures avant connexion si l'hypothèse est confirmée ; ne changer ni timeout produit, ni contrôle de droits, ni seuil.

**Suivi autorisé du 30 octobre :** cette hypothèse est désormais [prouvée par les piles de fermeture](session-7-7d-banc-mixte.md), puis corrigée dans le banc. La nouvelle campagne complète reste en attente de mémoire suffisante ; la présente fiche conserve l'état et les preuves du premier arrêt.

Gros transferts, NAT, charge mixte complète avec transferts, saturation CPU volontaire/reconnexion du vrai front, historique mixte et comparaison finale restent **non qualifiés**. La description de PR demeure un brouillon non fusionnable ; aucun risque accepté.

## Guide manuel

1. Construire l'image : `node scripts/build-file-validator.mjs --configure-local`. Conserver le digest affiché. Démarrer le service `file-converter` de Compose, puis redémarrer le worker pour charger le dossier configuré.
2. Vérifier avec `docker inspect` réseau none, UID non root, racine read-only, caps, mémoire et **un seul montage d'échange**, sans socket Docker. Ne pas monter le répertoire privé dans le conteneur.
3. Téléverser une texture 8K ; attendre l'aperçu, puis la télécharger. Un SVG doit rester en téléchargement. Rejouer `pnpm test:files:images` pour les cas automatisés.
4. Lancer `node --test scripts/test-file-converter.mjs` : son conteneur est distinct du développement ; il est volontairement attaqué et tué, puis supprimé. Ne pas reproduire une coupure sur les services de développement pendant une mesure.
5. Si la validation reste en attente, contrôler l'espace libre, les permissions et les résidus expirés. Sauvegarder un résidu inconnu avant toute suppression manuelle ; ne pas partager le dossier pour contourner le refus d'admission.

# Session 7a — clôture des preuves de transfert

29 octobre 2026. **7a prête pour relecture ; arrêt avant 7b.** Complète la [fiche de contention](session-7-7a-contention.md#suite-proposée-et-limites) après acceptation de la [requalification](session-7-7a-requalification.md). RustFS officiel 1.0.4, digest inchangé. Aucun service de lecture, décodeur d'image ou interface produit de fichiers ajouté.

## À lire en priorité

1. [Capacité et rapprochement](../../packages/db/src/file-capacity.ts), puis son appel dans [FileBoundary](../../packages/db/src/file-boundary.ts) : admission atomique entre workspaces et refus de divergence.
2. [Reprises réelles](../../apps/api/src/file-recovery.e2e.ts), puis [worker de transfert](../../packages/storage/src/uploads.ts) et [transport fermé définitivement](../../packages/storage/src/index.ts).
3. [Preuve navigateur](../../apps/api/src/files-browser.e2e.ts) : deux origines HTTPS, vrai Nest, RustFS et Edge, données isolées.
4. [Guide opérateur](../self-hosting.md#capacité-globale-et-rapprochement--clôture-7a-29-octobre-2026), [ADR 022](../adr/022-droits-et-cycle-de-vie-des-fichiers.md), exigences 7d dans [ARCHITECTURE](../../ARCHITECTURE.md#session-7--cadrage-et-découpage-retenu).

## Réponses ambiguës, crash et job tardif

[Journal complet : 10 tests réussis](evidence/session-7-7a-cloture/recovery.txt), soit neuf scénarios et leur parent Node. Chaque scénario utilise PostgreSQL migré et RustFS réels, dans une fixture jetable.

| Scénario exécuté                                                     | Assertion observée                                                                                      | Limite de la preuve                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Initiation multipart réussie, réponse perdue                         | Reprise du même multipart par listing, une seule réservation                                            | Erreur injectée après réponse réelle du SDK, pas panne interne RustFS               |
| CompleteMultipartUpload réussi, réponse perdue                       | HEAD réconcilie ; copie finale et octets vérifiés                                                       | Même injection à la frontière du transport                                          |
| CopyObject réussi, réponse perdue                                    | Ancienne copie reste comptée ; nouvelle clé immuable, nettoyage de l'ancienne après échéance            | Pas d'annulation garantie d'une opération déjà acceptée par un fournisseur en panne |
| Acquittement perdu après COMMIT SQL réel                             | Rejeu sans double réserve ni double débit de quota                                                      | Exception après COMMIT via le wrapper transactionnel, pas coupure TCP PostgreSQL    |
| DELETE réussi, réponse perdue                                        | Quota conservé jusqu'à HEAD absent après reprise, libéré une seule fois                                 | Pas destruction du volume objet                                                     |
| Processus worker tué après copie, avant publication SQL              | Nouveau processus/service reprend ; copie non publiée collectée                                         | Arrêt réel du processus, stockage et PostgreSQL restent disponibles                 |
| Ancien job suspendu ; backend PostgreSQL détenteur du verrou terminé | Nouvelle époque gagne ; ancien job ne remplace ni clé, ni état, ni erreur ; sa copie est nettoyée       | Ne couvre pas toutes les interleavings réseau du fournisseur                        |
| Deux comptes de deux tenants disputent la dernière réserve           | Une admission seulement ; refus staging/total sans fuite ; dérive détectée et commande opérateur testée | Petites tailles pour preuve transactionnelle, pas charge de gros volumes            |
| Capacité de copies insuffisante puis disponible                      | Aucune allocation SQL/S3 au refus ; finalisation ultérieure correcte                                    | Le nombre de reprises reste borné ; intervention après huit erreurs                 |

Les expirations de nettoyage sont avancées dans les fixtures pour sélectionner les jobs ; ce ne sont pas des attentes réelles de plusieurs minutes. La conformité S3 teste séparément l'expiration des capacités. Un état `validating` avec hash vérifié n'est **pas** un fichier publiable : type réel et `ready` restent en 7b.

Le garde-fou ajouté au transport interdit une nouvelle opération après `close()`. Le protocole d'époque et les clés distinctes existaient déjà ; les scénarios permanents prouvent maintenant leur comportement après perte réelle du verrou et arrêt du worker.

## Capacité et rapprochement

Nouveaux réglages `FILES_STAGING_BYTES` (**64 Gio**) et `FILES_CAPACITY_BYTES` (**500 Gio**) ; copies temporaires **20 Gio** conservées. 64 Gio couvre les 50 Gio déclarés de la future campagne dix × cinq, avec marge ; 500 Gio est un budget logique initial laissant de la place au temporaire par rapport aux 250 Gio métier. **Ce ne sont ni des résultats de capacité, ni une prescription de disque** : régler ces budgets selon le volume alloué et ses marges avant utilisation. Tous les processus doivent partager les valeurs.

Les additions de réserve sont sérialisées globalement ; la publication ne compte pas deux fois la copie finale vérifiée. Compteurs de workspace vérifiés avant nouvelle admission, contrôle périodique en lecture seule, alerte agrégée sans données personnelles. `pnpm files:accounting` détecte une divergence avec sortie 1 ; `--repair` corrige seulement ces agrégats sous le même verrou. Les deux commandes sont exécutées par la preuve, sur un schéma isolé volontairement altéré. Aucun objet ni droit n'est corrigé implicitement.

Le contrôle global lit les métadonnées autoritatives. Sa charge à la borne de fichiers et la capacité physique sous panne/rejeu restent à mesurer en 7d ; aucun appel S3 sous verrou et aucune modification du chemin de validation/journal Yjs. Le rapprochement ne certifie pas l'inventaire physique ni les hashes S3.

## Navigateur et CORS

[Journal Edge complet](evidence/session-7-7a-cloture/browser.txt), [rapport sans signatures](evidence/session-7-7a-cloture/browser.json). Test de **protocole**, pas interface 7c :

- POST 1 Kio, puis multipart **33 Mio** (16/16/1), interruption réseau après la première partie, rechargement et reprise depuis le listing serveur ; taille et SHA de la copie finale vérifiés.
- Session réelle dans le navigateur, routes Nest gardées ; requête API sans cookie refusée 401.
- Aucun cookie reçu à l'origine d'upload, y compris lors d'un POST volontaire avec `credentials: include` ; réponse avec credentials bloquée par CORS sans autorisation correspondante.
- Origine étrangère : préflight du PUT refusé, aucun PUT reçu ; GET d'objet et listing refusés 403 par Caddy.
- TLS approuvé par le système, aucune option ignorant un certificat. CORS ne rend pas une capacité volée inutilisable hors navigateur ; le risque de rejeu jusqu'à expiration reste documenté.

**Incident de fixture et réparation.** La première version du test partageait par erreur les volumes du Caddy local et a remplacé son seul fichier de reprise `autosave.json`. La configuration active est restée intacte. Après refus initial de la revue automatique et autorisation explicite du développeur, le fichier a été restauré depuis la configuration active, octet pour octet, **sans reload ni redémarrage**. [Diagnostic](evidence/session-7-7a-cloture/caddy-diagnostic.json), [vérification à 15:23:30 UTC](evidence/session-7-7a-cloture/caddy-restored.json). La version finale monte seulement les certificats en lecture seule et dispose de volumes de données/configuration privés ; elle a été rejouée avec succès. [Vérification supplémentaire après le dernier test navigateur](evidence/session-7-7a-cloture/caddy-after-final-browser.json) : empreinte active et sauvegardée inchangée. Aucun secret TLS exporté.

## Anciens fichiers et autres contrôles

Le nouveau test ouvre une salle réellement journalisée après retrait de son registre : `FILE_LEDGER_REBUILD_REQUIRED`, sans écriture de droits ni journal de remplacement. La [procédure](../self-hosting.md#anciens-fichiers-sans-registre--procédure-conservatrice) conserve sauvegardes et anciennes données en quarantaine, puis un workspace neuf pour les tests. Pas de migration automatique MinIO→RustFS ni de reconstruction d'anciens droits depuis la projection ; des données de valeur demandent une migration dédiée avant leur réouverture. Aucun fichier existant du développeur supprimé.

| Commande                     | Résultat de cette clôture                                                                                        | Preuve                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm test:storage:rustfs`   | **23/23** scénarios, fournisseur officiel sans patch                                                             | [journal](evidence/session-7-7a-cloture/rustfs.txt), [rapport](evidence/session-7-7a-cloture/rustfs.json) |
| `pnpm test:files:recovery`   | **10/10**, neuf scénarios ci-dessus                                                                              | [journal](evidence/session-7-7a-cloture/recovery.txt)                                                     |
| `pnpm test:files:e2e`        | **11/11** : six routes, quotas, CSRF, récupération/MFA, capacités, GC ; nouveaux refus de capacité/dérive        | [journal](evidence/session-7-7a-cloture/routes.txt)                                                       |
| `pnpm test:files:races`      | **6/6** : attache/GC, rollback, panne DELETE, révocation au commit                                               | [journal](evidence/session-7-7a-cloture/races.txt)                                                        |
| `pnpm test:files:boundaries` | **16 + 7 + 3**, auteur Yjs, cellules CAS, HMAC/WSS et registre absent                                            | [journal](evidence/session-7-7a-cloture/boundaries.txt)                                                   |
| `pnpm test:files:browser`    | **1/1**, protocole HTTPS réel décrit ci-dessus                                                                   | [journal](evidence/session-7-7a-cloture/browser.txt)                                                      |
| `pnpm check`                 | **169 réussis, 6 ignorés ; 32 fichiers réussis**, hooks, lint/formatage, typage récursif et preuve NestJS inclus | [journal](evidence/session-7-7a-cloture/check.txt)                                                        |

Les comptes Node incluent les tests parents, pas autant de scénarios indépendants. Matrice R12 des six routes dans la [fiche transferts](session-7-7a-transferts.md#matrice-routes-quotas-et-preuves), rejouée ici ; aucune nouvelle route de lecture ou de catalogue déclarée sûre. Les logs d'erreurs injectées n'émettent que des codes fixes. Essais conservés : deux erreurs de montage de fixture (cast UUID/texte, puis acteur absent du second workspace), deux champs optionnels TypeScript dans le test navigateur, puis formatage des rapports JSON. Ils sont corrigés et ne sont pas comptés comme passages réussis ; les journaux `*-failed.txt` restent dans les preuves. [Manifeste et empreintes](evidence/session-7-7a-cloture/manifest.json).

## Performance, limites et prochaine étape

La campagne acceptée reste celle de la [requalification](session-7-7a-requalification.md) : **24 cas WSS, 3 600 reçus**, trois séries ; comparaison main `56c52b4` / candidate `0e4df17`, douze séries, règle max(10 %, 2 ms) respectée. Les modifications présentes portent sur l'admission, la reprise et le rapprochement ; **aucun nouveau benchmark de ces chemins** et aucune remesure de la candidate complète ne sont revendiqués. La charge des gros uploads et la comparaison finale restent en 7d. Les journaux de tests fonctionnels ne servent pas de résultats de performance.

Deux exigences du développeur inscrites dans ARCHITECTURE et l'ADR 021 : décomposer le WSS historique (serveur ~61 ms/reçu ~300 ms), sans modifier les seuils ; plafond mixte **200 ms pour le contenu**, historique surveillé et rebasage obligatoire. Provoquer une saturation CPU contrôlée et vérifier `CONTROL_UNAVAILABLE`, reconnexion réelle et absence de perte ; publier les options sans affaiblir l'échec fermé, puis répéter sur **4 vCPU pré-pilote**. Rien de cela n'est présenté comme déjà mesuré.

Ce qui peut encore casser : copie interne du fournisseur persistant après coupure, épuisement physique du volume, divergence de métadonnées sources non réparable par des agrégats, reprise avec anciens fichiers sans provenance, fermetures sous saturation CPU. Restent 7b (type réel/images 8K/lecture révocable), 7c (interface/cache/avertissements), 7d (gros volumes, charge mixte, audit final, antivirus facultatif) et qualification pré-pilote de crash/restauration/sauvegardes. Aucun de ces risques n'est accepté par cette fiche.

## Guide de relecture et test manuel

1. Vérifier `.env`, PostgreSQL, Docker/RustFS et Caddy actifs ; même `FILES_*` pour les processus. Lire le guide opérateur avant de modifier un budget. Le test navigateur exige les certificats `localhost` et `uploads.localhost` déjà approuvés ; ne pas franchir une alerte TLS automatiquement.
2. Lancer `pnpm test:files:recovery`, lire chaque scénario et le résumé final **10 pass / 0 fail**. Les opérations dangereuses sont limitées au schéma et aux objets de la fixture, jamais au workspace local.
3. Lancer `pnpm test:files:e2e`, puis `pnpm test:files:races` et `pnpm test:files:boundaries`. Vérifier les comptes ci-dessus et les refus attendus. Ne pas interpréter un `file_job_retry` injecté comme une perte de fichier.
4. Lancer `pnpm test:files:browser` ; pour regarder le parcours, consulter son code/rapport. Il automatise deux origines et une coupure, sans interface de sélection d'assets. Le guide produit à deux navigateurs sera livré en 7c.
5. Exécuter uniquement la lecture `pnpm files:accounting` sur l'installation locale. Ne lancer `--repair` qu'après investigation selon le guide ; la preuve de réparation peut être relue dans la fixture, sans altérer les données locales.
6. Vérifier `pnpm test:storage:rustfs` **23/23** et `pnpm check` jusqu'au résumé final. Aucune nécessité de relancer les benchmarks pour cette relecture ; toute nouvelle mesure suit secteur/mémoire/swap, trois séries et absence de build/test concurrent.

Description intermédiaire dans `.local/session-7-7a-pr-description.md`. Aucune PR créée ni fusionnée. **Attente de la relecture avant 7b.**

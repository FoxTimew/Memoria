# Relecture — session 3, étape 2 : première preuve technique

> Document historique : les lanceurs `proof:collab*` ont été retirés en 3a. Voir la [fiche du service réel](session-3-3a-service.md) pour les commandes actuelles.

Branche : `codex/session-3-collaboration-design`. ADR 017 accepté avec les décisions reçues. Cette livraison fournit une preuve exécutable isolée, avant toute interface. Elle ne termine pas la session 3 et ne branche pas le serveur collaboratif sur l'application. Le compte rendu donne le hash poussé après vérification distante ; le commit ne peut pas contenir son propre hash.

## Fichiers à lire en priorité

1. [ADR 017](../adr/017-collaboration-temps-reel.md) : journal durable avant diffusion, projection différée indépendante, fiche par champ, hors-ligne, bornes acceptées et reset sans conversion.
2. [Mesure](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/performance.ts) et [fixture](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/fixture.ts) : véritable schéma BlockNote, 300 blocs, profondeur 3, 33 fiches personnage. Le rendu de la fixture est interdit ; aucune interface n'est créée.
3. [Codec](../../apps/collab/src/codec.ts), [worker isolé](../../apps/collab/src/validator.ts) et [journal](../../apps/collab/src/journal.ts) : lecture stricte du format Yjs, modèles Zod, verrou de page `FOR NO KEY UPDATE`, droits actuels, journal et reçu dans la même transaction. Aucun verrou de workspace ni projection dans ce chemin.
4. [Serveur de preuve](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/server.ts), [scénarios réels](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/transport.ts) et [projecteur de fixture](https://github.com/FoxTimew/Memoria/blob/2e0866eca2574d256d79d7c54beaf080562e9516/apps/collab/src/proof/projection.ts) : à relire en gardant leur périmètre de prototype en tête. Ils utilisent des tables temporaires ; le writer de production reste celui de session 2.

## Mesure bloquante effectuée en premier

Campagne finale du 2026-10-23, 17:47:54 UTC : **p95 total 25,361 ms**, cible strictement inférieure à 50 ms. Le premier passage complet précédant les tests de transport était également sous le seuil (25,587 ms). Les campagnes consignées franchissent le seuil ; les erreurs initiales de montage de fixture ont été corrigées avant de publier un résultat complet. Aucune validation n'a été retirée pour améliorer le résultat.

| Mesure côté serveur                                  | p50       | p95           | p99       | maximum   |
| ---------------------------------------------------- | --------- | ------------- | --------- | --------- |
| Candidat : clonage, application, codec/Zod, encodage | 8,851 ms  | 15,027 ms     | 16,348 ms | 17,212 ms |
| Candidat avec échange du worker isolé                | 10,712 ms | 17,308 ms     | 18,599 ms | 19,903 ms |
| Transaction : page, droits, journal, reçu et commit  | 7,577 ms  | 8,630 ms      | 8,871 ms  | 9,374 ms  |
| Total mesuré pour chaque update                      | 18,337 ms | **25,361 ms** | 26,780 ms | 28,534 ms |

Les percentiles des deux parties ne s'additionnent pas ; le total est calculé sur chaque échantillon. 20 updates d'échauffement, puis **200 échantillons sans filtrage** : texte, suppression seule et attribut de fiche. JSON métier 174 909 octets ; Yjs initial 178 904 octets, final 181 538. Machine Windows 10.0.26300, Ryzen 7 5800H, Node 24.21.0, PostgreSQL Compose 17.11 avec `fsync=on` et `synchronous_commit=on`. Versions exactes dans le lockfile.

Les [200 mesures et l'environnement](session-3-performance.json) et le [journal complet de la preuve](session-3-etape-2-proof.txt) sont versionnés. Les originaux sont dans `.local/session-3-performance.json` et `.local/session-3-etape-2-proof.log`. La mesure inclut les échanges du worker et PostgreSQL ; elle exclut le handshake, l'attente dans une file chargée, le réseau navigateur et la projection. Un seul document reçoit des updates séquentielles. Ce résultat ne prouve pas la capacité de 50 personnes/500 sockets et devra être remesuré avec le leadership, les notifications et le service final.

## Ce que la preuve vérifie

Douze tests Vitest supplémentaires vérifient le format réel des neuf modèles, l'imbrication, les styles/liens, la convergence par champ, le rejet de données invalides et de structures cachées/manquantes, la borne d'update et la frontière serveur sans React/BlockNote. BlockNote n'est chargé que par le générateur de test ; le worker de validation possède aussi une règle de build qui interdit l'UI.

Douze scénarios de transport passent avec deux vrais providers Hocuspocus, des cookies créés par Better Auth et PostgreSQL réel :

- Chargement authentifié d'un document imbriqué, attente du journal avant diffusion et reçu durable.
- Texte concurrent, champs de fiche indépendants préservés et valeur gagnante pour le même champ.
- Saisie pendant coupure, nouvelle authentification, fusion et reconstruction exacte du journal, suppressions incluses.
- Projection asynchrone exacte, audit de deux auteurs et un seul outbox pour la fenêtre. Une erreur SQL après écriture des effets annule toute la projection ; une nouvelle frappe reste durable. Le retry débloque l'attente de la révision demandée sans doubler les événements.
- Snapshot Yjs et suppression d'updates déjà projetées ; reçus conservés séparément pour le réessai idempotent. Un client antérieur au checkpoint continue à fusionner.
- Cookie absent, origine étrangère et salle étrangère refusés sans contenu transmis.
- Lecteur de fixture recevant le document, mais incapable d'écrire par Update ou par SyncStep2 de reconnexion.
- Fiche invalide et panne SQL injectée dans le journal : aucune diffusion, aucun avancement de révision, autres clients préservés.
- Suppression d'une session : fermeture de ses deux onglets par le contrôle périodique, autre session préservée. Retrait de membership et archivage d'un ancêtre : fermeture des salles concernées.

Les erreurs `Read only`, Zod, `Injected SQL journal failure` et l'incident de projection dans le journal sont attendus et suivis d'assertions ; le processus se termine avec code 0. Le transport est en WS loopback : le test ne prétend pas avoir exercé WSS/Caddy.

## Ce qui pourrait casser et ce qui reste à démontrer

- **Ne pas déployer ce prototype.** Il manque l'entrée applicative, les migrations Drizzle définitives avec acteurs/générations/FK multi-workspace, le leadership PostgreSQL, le HMAC interne et le raccordement de `BlockWriteService`. L'attente de sa propre projection est exercée par la preuve ; le service réel ne l'utilise pas encore.
- La file et les quotas de production doivent être appliqués dès réception des octets, avec réservations atomiques d'admission. La file par salle et les vérifications de la preuve ne démontrent pas les bornes mémoire/sockets sous charge ou lors de connexions simultanées. Une seule salle est servie par ce harness.
- La fermeture après retrait/archive est déclenchée par le résolveur de preuve ; seul le cas session teste le polling sans notification. Restent les triggers `LISTEN/NOTIFY`, leurs pertes, les courses SQL entre révocation et écriture, les sessions expirées/emails non vérifiés et les connexions de contrôle en panne. Les écritures relationnelles actuelles ne sont pas encore coordonnées avec ce journal.
- Le regroupement utilise 1 s/5 s et le backoff, mais le scénario exécuté ne mesure pas encore une frappe continue de plus de 5 s ni une reprise après redémarrage du projecteur. Le jitter, les jobs de compaction automatiques, les crashs de processus aux frontières du commit et la concurrence compaction/projection restent à éprouver. Les images de fixture ont un `fileId` vide : références réelles à tester avec le futur branchement.
- Restent les déplacements/suppressions de blocs concurrents dans le vrai éditeur, les aller-retour vers son UI définitive, l'undo/copie de fiche, les documents proches des limites et la charge de 50 comptes. La preuve de performance utilise une fixture représentative, pas une borne maximale.
- Présence sécurisée, cache Yjs IndexedDB, effacement à la déconnexion/onglets retardataires, suppression des anciens brouillons et parcours WSS derrière Caddy sont encore à implémenter et tester. La présence est explicitement désactivée dans la preuve. Aucune conversion/export des brouillons JSON ni procédure de rollback n'est ajoutée.

Ces limites sont la suite technique à traiter avant de présenter une collaboration utilisable. Le seuil initial ne nécessite pas de proposition de validation incrémentale à ce stade.

## Comment tester manuellement

1. Installer les dépendances figées : `pnpm install --frozen-lockfile`. Préparer `.env` et PostgreSQL Compose local ; la preuve refuse une base hors loopback et `NODE_ENV=production`.
2. Exécuter `pnpm proof:collab`. Lire `PERFORMANCE GATE PASSED`, les douze lignes `PASS`, le résumé des douze scénarios et les deux codes 0. En cas de seuil ≥ 50 ms, le lanceur n'exécute pas le transport : conserver le rapport et discuter la validation incrémentale.
3. Le runner crée un schéma `memoria_collab_proof_<UUID>`, y applique les migrations et crée ses comptes/docs. Il le supprime dans `finally`. Il ne touche pas aux données de `public`. Si le processus est tué brutalement, inspecter uniquement le schéma de fixture restant ; ne pas réinitialiser la base entière.
4. Exécuter `pnpm check` pour les types, le lint, la preuve Nest et Vitest. Aucun serveur web n'est nécessaire. Le parcours navigateur reste celui de session 2 ; il ne permet pas encore la collaboration.

## Contrôles de livraison

`pnpm check` terminé avec code **0** : lint/format, **12 packages** typés et preuve Nest réussis ; **64 tests Vitest réussis, 6 tests SQL ignorés** (14 fichiers réussis, 1 ignoré). Les six tests SQL du socle nécessitent la commande distincte `pnpm test:db` ; ils ne sont pas comptés comme réussis ici. Les douze scénarios collaboratifs utilisent leur propre PostgreSQL réel et passent séparément avec `pnpm proof:collab`, code **0**.

Le [journal global complet](session-3-etape-2-check.txt) contient le résumé final de Vitest et le code de sortie ; original dans `.local/session-3-etape-2-check.log`. Le journal de preuve complet est également versionné. Les hooks de commit/push restent actifs ; leur résultat et le hash distant sont vérifiés dans le compte rendu. La description de PR est conservée dans `.local/session-3-pr.md` avec le même périmètre et sans annoncer la session 3 terminée.

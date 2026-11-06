# Session 7d — poursuite sans isolation

6 novembre 2026. **Point préparatoire, 7d non clôturée. Aucun résultat de saturation CPU ni de reconnexion n'est revendiqué par cette fiche.**

## Décision appliquée

Le prototype `proof/7d-isolation` reste un repli hors build applicatif et hors Compose. Sa dépendance aux internes Hocuspocus, les nouveaux modes de panne IPC et son surcoût historique apparent motivent la décision de ne pas l'intégrer. Les résultats antérieurs restent consultables, sans constituer une qualification de la version retenue.

La [dérogation du 6 novembre](../adr/021-transferts-et-service-des-fichiers.md#décision-du-6-novembre-2026--service-sans-isolation-et-dérogation-bornée) autorise uniquement le dépassement de 50 ms serveur des pages typiques voisines d'une page historique synthétique pendant des conversions 8K sur le poste de développement. Le banc exige `MEMORIA_FILES_DEVELOPMENT_WAIVER=2026-11-06`, Windows, aucune isolation, le profil historique et les conversions actives. Il publie les dépassements séparément. Le test `mixed-limits.test.ts` refuse les autres profils/contextes et conserve le plafond WSS. La comparaison avec main n'importe pas cette exception.

Le rebasage automatique pré-pilote devra requalifier ce scénario sans isolation : pages typiques sous 50 ms et page rebasée mesurée. L'ADR, la Liste pré-pilote et le tableau des risques reprennent ce critère.

## Banc CPU préparé, non exécuté

Commande : `pnpm test:collab:cpu:browser`. Le lanceur termine tous les builds avant les trois séries ; `node scripts/test-files-cpu.mjs --built-web` réutilise seulement un build web déjà à jour. Le profil immuable `.local/incremental/history-1M.bin` des campagnes précédentes doit être présent ; son empreinte sera inscrite dans chaque rapport. Le serveur de test lit ces octets, sans importer le générateur BlockNote ni affaiblir la frontière serveur sans UI.

Deux comptes dans le vrai front compilé passent par HTTPS/WSS, le vrai Nest, PostgreSQL et le service collaboratif actuel. Les textures sont préparées avant la connexion. Le diagnostic lance au plus quatre workers CPU bornés et les conversions 8K, puis arme des travaux Yjs synchrones de 250, 750 et 1 800 ms pendant de vraies requêtes de contrôle. C'est une famine de boucle volontaire : **pas une affirmation qu'un client normal peut produire ces rafales**. Aucun délai SQL artificiel, appel direct à `fail()`, modification du lease ou des contrôles applicatifs. Le point d'entrée diagnostic n'est compilé qu'avec `--cpu-front`, absent du démarrage normal et de Compose.

Les observations prévues séparent requêtes de contrôle, CPU, retard de boucle, conversions, fermetures WebSocket et texte reçu par le second compte. Après une fermeture, une fenêtre d'observation de 60 secondes vérifie la reprise automatique ; ce délai décrit le test et ne définit pas un nouvel objectif produit. Les contributions doivent converger puis survivre au rechargement. Les rapports ne stockent ni cookies, tickets, trames ni texte utilisateur ; les données saisies sont synthétiques.

Le test s'arrête sur conversion hors borne, quota, erreur du front ou absence de reprise. Un tel échec exigera un diagnostic et les options au développeur avant correction. Le service actuel marque son indisponibilité dans `fail()` sans réarmement : c'est une raison de vérifier ce parcours, **pas encore une reproduction du symptôme observé en 7a**. Une fermeture locale 1005, le test d'inactivité de cinq minutes ou la mort du worker du prototype ne remplacent pas cette preuve.

## Contrôles et blocage actuel

- `pnpm check` : hooks, lint, types et bootstrap Nest conformes ; **189 tests réussis, 6 ignorés**, 41 fichiers réussis. Les six tests SQL ne sont pas rejoués dans ce point préparatoire.
- Les bundles CPU et API navigateur compilent. Le premier essai CPU a correctement refusé l'import du générateur UI par la règle `no-ui` ; il lit désormais la fixture immuable. La règle reste active.
- Le build web a réussi ; ce résultat ne vaut pas exécution du nouveau scénario dans le navigateur.
- Admission du 6 novembre à 21 h 36 Paris : secteur reconnu (`BatteryStatus=2`), **2,53 Gio libres sous Windows**, **4,90 Gio MemAvailable dans WSL**. Refus avant préparation : minimum Windows de 3 Gio non atteint. **Aucune série ni charge CPU n'a démarré.** Les compteurs swap relevés sont des compteurs cumulés, pas une mesure d'activité pendant une série inexistante.

Journaux et observation : [manifest](evidence/session-7-7d-sans-isolation/manifest.json). Le hook pre-push doit de nouveau exécuter tous les contrôles avant publication.

## Relecture et suite

Lire d'abord l'ADR 021 et `apps/collab/src/testing/mixed-limits.ts`, puis `scripts/test-files-cpu.mjs`, `apps/api/src/testing/collaboration-cpu-front.ts` et `apps/collab/src/testing/cpu-front-server.ts`. Le code applicatif et ses délais ne changent pas dans ce point.

Ce qui peut casser : le nouveau banc n'a pas encore parcouru son orchestration navigateur/conversion ; une compilation réussie ne garantit pas sa préparation, son nettoyage ou sa reproduction du timeout. Les fixtures Docker restent isolées et le garde-fou mémoire reste bloquant. Ne pas lancer la saturation à côté d'un studio actif.

Pour reprendre manuellement, laisser Docker et le secteur actifs, libérer suffisamment de mémoire pour le contrôle avant préparation, puis lancer la commande. Lire le rapport de chaque série et son journal vmstat ; arrêter à tout échec non couvert par la dérogation. Ne pas interpréter l'absence de fermeture observée comme une preuve de reconnexion.

Restent également les gros transferts et la charge mixte/NAT finale, la comparaison alternée avec main, la mesure du coût de l'option antivirus, puis la consolidation finale de la matrice, des risques, du guide et de la description de PR. Leurs anciennes preuves ne sont pas annoncées comme rejouées ici. Aucun risque globalement accepté, aucune PR créée.

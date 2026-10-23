# Relecture — session 3, étape 1 : cadrage de la collaboration

Note ultérieure : les réponses ont été reçues et l'ADR 017 est désormais accepté. Cette fiche conserve le compte rendu historique du commit de cadrage ; voir la [preuve d'étape 2](session-3-etape-2-preuve.md) pour les décisions ajustées et les premiers résultats exécutés.

Branche : `codex/session-3-collaboration-design`, créée après synchronisation de main `ea9afdf` (fusion de session 2). Cette étape modifie uniquement de la documentation. Aucun serveur de collaboration, paquet, migration, conversion de données ni test collaboratif n'est ajouté. Le hash poussé et sa vérification distante figurent dans le compte rendu de livraison ; un commit ne peut pas contenir son propre hash.

## Fichiers à lire en priorité

1. [ADR 017 proposé](../adr/017-collaboration-temps-reel.md) : les dix décisions techniques, les cinq questions finales et les tests qui bloqueraient la suite. Les recommandations attendent les réponses du développeur.
2. [Sessions suivantes](../../ARCHITECTURE.md#sessions-suivantes) : collaboration en session 3 ; connexion forte, quotas NAT/par compte et récupération de mot de passe en session 4 ; invités et lecture seule en session 5 ; bases/fichiers/API/webhooks ensuite. Aucun utilisateur réel avant la fin de la session 4.
3. [ADR 007](../adr/007-blocs-registry-yjs.md) et [ADR 016](../adr/016-pages-editeur-et-sauvegarde.md) : leurs notes distinguent la proposition du code SQL/IndexedDB encore actif. Les ADR 004, 013, 015 et le README reprennent le nouveau calendrier. Les fiches anciennes gardent leurs résultats historiques avec un renvoi vers ce calendrier.

## Ce qui pourrait casser lors de l'implémentation

- Une validation après application Yjs pourrait déjà avoir diffusé un contenu invalide. La première preuve doit démontrer validation et commit avant diffusion, avec deux connexions concurrentes et une panne SQL.
- La fiche personnage actuelle est un seul JSON dans une prop. Sans changement de transport, deux personnes pourraient écraser leurs modifications sur des champs différents. La collaboration par champ et celle caractère par caractère sont deux niveaux distincts à choisir.
- Le codec serveur doit restituer le vrai document BlockNote sans importer le catalogue UI ni perdre des champs. Une incompatibilité impose un arrêt, pas une conversion silencieuse.
- Un signal de révocation manqué pourrait laisser une connexion lire temporairement. Le délai de secours de 5 secondes est une proposition explicite à accepter ou à renforcer.
- Supprimer un cache Yjs sans invalider les anciens onglets permettrait sa recréation. Les garanties de déconnexion doivent être retestées avec onglets suspendus, erreurs IndexedDB et changement d'utilisateur.
- Les projections synchrones et le verrou de workspace peuvent coûter trop cher à 50 personnes. Les seuils mémoire/taille/latence de l'ADR sont des objectifs de preuve, pas des performances mesurées.

## Comment relire et tester manuellement cette étape

1. Lire les cinq questions de l'ADR et répondre avant de lancer l'étape 2. Valider aussi les valeurs de départ proposées pour les limites, la présence et la migration.
2. Vérifier que le diff depuis `main` contient uniquement des fichiers Markdown. Le schéma SQL, le lockfile, Caddy et le code applicatif doivent être identiques à la session 2.
3. Aucun nouveau parcours collaboratif n'est disponible. Les parcours de session 2 restent la référence ; leurs instructions sont dans [la fiche précédente](session-2-pages-editor.md). Ne pas lancer de conversion ni de reset de base pour relire ce cadrage.
4. Après accord, la première preuve devra notamment ouvrir deux clients, modifier simultanément texte imbriqué et fiche, couper/reconnecter le réseau, révoquer une session et injecter un contenu invalide. La matrice de l'ADR précise les résultats attendus avant l'intégration de l'interface.

## Contrôles

`pnpm check` terminé le 2026-10-23 : lint/format réussis, types des 11 packages, preuve Nest compilée et **52 tests réussis, 6 tests SQL ignorés** (13 fichiers réussis, 1 ignoré). Le journal complet, résumé Vitest et code de sortie 0 inclus, est conservé dans `.local/session-3-etape-1-check.log`. Aucun test SQL/e2e supplémentaire n'est nécessaire pour ce changement documentaire ; aucun test de collaboration n'a été exécuté.

Le push conserve ses hooks ; son journal est prévu dans `.local/session-3-etape-1-push.log`. Son résultat effectif et le hash distant sont repris dans le compte rendu. Ces contrôles vérifient le socle existant et ne constituent pas une validation de Yjs ou Hocuspocus.

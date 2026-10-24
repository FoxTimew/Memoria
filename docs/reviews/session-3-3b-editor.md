# Session 3b — éditeur collaboratif

Le corps de page se modifie à plusieurs via Hocuspocus/Yjs. L'ancien autosave JSON est supprimé. « Enregistré sur le serveur » signifie qu'un reçu du journal PostgreSQL couvre les modifications envoyées ; le titre garde son bouton et son conflit 409. La fiche personnage transmet chaque champ séparément. Caddy expose WSS sur l'origine HTTPS de l'application.

La présence et le cache Yjs IndexedDB restent en **3c**. En 3b, une saisie hors ligne survit tant que son onglet reste ouvert ; elle ne survit pas à sa fermeture ou son rechargement. Aucun ancien brouillon JSON n'est restauré ; leur effacement au premier chargement reste en 3c. La capacité mémoire actuelle reste limitée à cinq salles actives avec 1 Gio. **3d est obligatoire avant 4**, avec au moins 30 pages typiques ≤ 200 Kio dans ce budget, un pool de workers et des réservations proportionnelles. Aucune optimisation 3d n'est annoncée comme livrée.

## Fichiers à lire en priorité

1. `apps/web/src/lib/collaboration-client.ts` et `collaboration-state.ts` : connexion, coupure, reprise et reçus. Un simple état « synchronisé » du provider ne vaut pas sauvegarde.
2. `apps/web/src/components/page-editor.tsx` et `page-title.tsx` : montage après réception du document serveur, messages, export du contenu affiché et titre relationnel.
3. `packages/blocks/character-card/src/adapter.ts` et `editor.tsx` : attributs distincts et patch limité aux champs réellement modifiés.
4. `apps/collab/src/service/server.ts` : reçu de resynchronisation déjà durable, sans nouvelle révision. `infra/caddy/Caddyfile` : chemin WSS public et HMAC privé.
5. `scripts/dev-collaboration.mjs` : ajout local du second membre et reset limité aux anciens corps de test. ADR 017 et « Sessions suivantes » d'ARCHITECTURE.md : décisions et frontières 3b/3c/3d.

## Ce qui pourrait casser

- Une évolution du format de messages Hocuspocus ou du schéma BlockNote pourrait casser les reçus ou la validation serveur. Les versions sont figées ; tests du vrai provider et conversion du vrai schéma front vers le codec serveur.
- La recherche peut avoir du retard sur le corps enregistré : elle attend la projection asynchrone. Le titre et l'arbre restent relationnels ; leurs conflits sont toujours possibles et explicitement affichés.
- Fermer un onglet hors ligne perd ses modifications en mémoire. Garder l'onglet ouvert jusqu'à confirmation, ou utiliser « Exporter le contenu affiché ». Il s'agit d'un export de secours du contenu courant, pas des anciens brouillons session 2.
- Une révocation, un changement de génération, une limite ou un contenu refusé arrêtent l'édition ; exporter avant d'abandonner/recharger. La charge de 50 personnes et la mémoire visée ne sont pas prouvées par le test à deux clients.
- Les quotas de connexion/inscription par IP de session 1 s'appliquent encore. Après plusieurs essais rapprochés, attendre la fenêtre indiquée dans l'ADR 015 ; la correction NAT/par compte est en session 4.

## Démarrer cette version

Depuis la racine, avec Node 24, pnpm 11.25 et Docker actifs :

```powershell
pnpm install --frozen-lockfile
docker compose up -d postgres mailpit caddy
pnpm db:migrate
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
pnpm dev
```

Conserver le `.env` existant ; `pnpm env:init` sert seulement à une installation neuve. Il doit contenir le `COLLAB_INTERNAL_SECRET` ajouté en 3a (secret aléatoire d'au moins 32 caractères, identique pour Nest et collab). Les commandes dev/start de collab chargent désormais ce fichier comme les autres serveurs. Ne pas démarrer `pnpm dev` et `pnpm start` ensemble. Pour le build de production local : arrêter dev, puis `pnpm build` et `pnpm start`.

Ouvrir `https://localhost`. Le certificat Caddy doit être approuvé dans chaque navigateur ; procédure dans le README, aucune désactivation de TLS. Les sondes `/api/health`, `/api/health/worker` et `/api/health/collab` doivent répondre. Caddy transmet `/collab` à 3003 ; le port 3004 et `/internal/collaboration` restent privés. En local Docker accède aux processus Node par `host.docker.internal`.

## Anciennes pages de test : reset ciblé si nécessaire

Une page créée après cette livraison est utilisable directement. Une ancienne page contenant des blocs sans document Yjs affiche une demande de réinitialisation. Aucun reset global n'est nécessaire et cette livraison n'efface pas automatiquement vos anciens contenus.

1. Noter l'UUID du workspace dans son URL : `https://localhost/workspaces/UUID`.
2. Fermer les onglets de cet ancien workspace et arrêter `pnpm dev`/`pnpm start` (en particulier `apps/collab`). Laisser PostgreSQL démarré. Le script refuse d'agir tant qu'un leader collab détient le verrou PostgreSQL.
3. Dans PowerShell, remplacer la valeur ci-dessous par l'UUID réel. Lancer d'abord l'aperçu et vérifier les pages listées :

```powershell
$workspaceId = 'UUID-du-workspace-de-test'
pnpm dev:collab reset-legacy --workspace $workspaceId
```

4. Si cette liste contient bien les anciens corps de test à abandonner, appliquer explicitement :

```powershell
pnpm dev:collab reset-legacy --workspace $workspaceId --apply --confirm $workspaceId
pnpm dev
```

Le script supprime les blocs, références de fichiers et projections de recherche/audit/outbox des seules pages listées. Il incrémente leur version et recrée leur recherche par titre lorsqu'elles sont actives. Il conserve comptes, membres, identifiants et titres de pages, arbre, fichiers stockés et tout document déjà Yjs. À la prochaine ouverture, le corps collaboratif démarre vide. Pas de conversion, pas d'export des anciens brouillons, pas de procédure de retour au contenu précédent. Le script refuse une base distante ou `NODE_ENV=production`.

## Test manuel pas à pas à deux navigateurs

Prévoir deux sessions distinctes : **A** dans une fenêtre normale ; **B** dans une fenêtre privée (ou un autre navigateur). Deux onglets normaux du même profil partagent le même compte et ne suffisent pas à ce test.

1. Dans A, se connecter avec le premier compte vérifié, créer un workspace de test ou ouvrir un workspace existant. Copier son URL et son UUID.
2. Dans B, ouvrir `https://localhost/inscription`, créer un **second compte** avec une autre adresse de test et un mot de passe d'au moins 12 caractères. Ouvrir Mailpit sur `http://localhost:8025`, retrouver son email, copier le lien de vérification et le coller dans B. Se connecter dans B.
3. Les invitations ne sont pas encore livrées. Depuis le terminal local de développement, ajouter ce compte vérifié au workspace de A :

```powershell
pnpm dev:collab add-member --workspace $workspaceId --email 'second-compte@example.test'
```

Le script ajoute un rôle member, sans modifier un rôle existant. Il refuse un compte absent ou non vérifié. Réactualiser l'accueil de B : le workspace doit être proposé ; ouvrir aussi l'URL copiée depuis A.

4. Dans A, créer une nouvelle page. Saisir un titre distinct et cliquer **Enregistrer le titre**. Réactualiser B pour voir la page dans l'arbre et l'ouvrir. Attendre **Enregistré sur le serveur** dans les deux fenêtres. Aucun curseur nommé n'est encore attendu (3c).
5. Écrire dans le corps de A puis dans B, sans attendre entre les saisies : chaque fenêtre doit montrer les deux contributions et revenir à **Enregistré sur le serveur**. Faire aussi une liste avec un enfant indenté (Tab) ; modifier l'enfant dans B et vérifier A.
6. Ajouter une fiche depuis `/character`, puis **Character card**. Dans A, changer **Name** ; simultanément dans B, changer **Health**. Les deux valeurs doivent rester présentes dans les deux fenêtres. Modifier ensuite le même champ dans les deux : une seule valeur doit gagner et être identique partout. Les tags sont validés en quittant leur champ.
7. Attendre la confirmation des deux fenêtres. Dans les outils développeur de A, onglet **Network/Réseau**, choisir **Offline/Hors ligne**. Garder la page ouverte. A doit afficher **Hors ligne — modifications conservées dans cet onglet**. Écrire « ajout hors ligne » dans A ; écrire « ajout connecté » dans B. B doit encore enregistrer normalement.
8. Dans A, remettre le réseau sur **No throttling/Aucune limitation**. Attendre la reconnexion et **Enregistré sur le serveur** dans les deux fenêtres. Les deux ajouts doivent être présents, avec la fiche et ses valeurs. Recharger seulement maintenant, rouvrir la page depuis l'arbre et vérifier la conservation du contenu.
9. Contrôle complémentaire du titre : modifier le titre dans A sans enregistrer ; modifier/enregistrer celui de B. Après le polling (15 s), ou une tentative d'enregistrement dans A, A propose le titre du serveur ou de garder son titre pour le réenregistrer. Le corps ne doit pas disparaître.
10. Contrôle de secours : couper à nouveau le réseau de A, écrire, puis cliquer **Exporter le contenu affiché**. Le JSON contient le titre et les blocs affichés. Revenir en ligne avant de fermer pour ne perdre aucune modification. La persistance locale après fermeture sera testée en 3c.

## Contrôles et portée des preuves

Les journaux complets `session-3-3b-*.txt` accompagnent cette fiche. Ils incluent les résumés finaux et codes de sortie ; aucun résultat n'est déduit d'un simple lancement de test. Résultats du 24 octobre 2026 :

- [check](session-3-3b-check.txt) : **88 tests Vitest réussis, 6 SQL génériques ignorés**, lint/format, types des 12 packages et preuve Nest réussis. Le total précédent était 89 : six tests dépendant de l'ancien moteur d'autosave sont retirés avec lui, quatre tests de reçus et un test du schéma front→Yjs→codec sont ajoutés. Les tests de nettoyage du stockage JSON ancien sont conservés jusqu'à 3c.
- [build](session-3-3b-build.txt) : quatre applications compilées, aucune erreur.
- [frontend](session-3-3b-frontend.txt) : 1 scénario composé réussi ; [transport](session-3-3b-transport.txt) : 12 scénarios réussis (13 tests Node avec leur parent).
- [development](session-3-3b-development.txt) : 1 scénario composé de reset/membership réussi ; [pages](session-3-3b-pages.txt) : 7 scénarios API réussis (8 tests avec leur parent).
- [navigateur](session-3-3b-browser.txt) : 1 parcours complet réussi sur le build final ; deux contextes Edge isolés, aucun contournement TLS ni quota, aucune erreur JavaScript navigateur.

| Sujet                   | Preuve réelle                                                                                                                                                                                                   | Limite                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Éditeur / Caddy / fiche | `pnpm test:collab:browser` : deux contextes Edge isolés, comptes Better Auth vérifiés via Mailpit, ajout member, WSS, texte simultané, champs indépendants, offline/reconnexion, titre 409 et rechargement      | Deux contextes du même moteur, pas deux moteurs distincts ni 50 personnes ; fixtures de test conservées localement                              |
| Provider / reçus        | Suite `frontend` avec le vrai client front, Hocuspocus et PostgreSQL : reçu avant état propre, fusion hors ligne, suppression seule, resynchronisation déjà durable, révocation ne coupant que le membre retiré | Réseau loopback ; panne matérielle non simulée                                                                                                  |
| Transport / validation  | Suite `transport` : les douze scénarios permanents 3a, avec reçus de resynchronisation distingués                                                                                                               | Les benchmarks froid/mémoire ne sont pas rejoués en 3b                                                                                          |
| Reset / second membre   | Suite `development` : vrai SQL isolé, aperçu, confirmation, exclusion du leader, conservation Yjs/autre workspace, compte vérifié, idempotence et refus production                                              | Pas de suppression des anciennes pages applicatives de l'utilisateur                                                                            |
| Schéma / UI / build     | `pnpm check` et `pnpm build` : lint, types, preuve Nest, tests du schéma front→Yjs→codec et des reçus ; quatre apps compilées                                                                                   | Les six tests SQL génériques sont ignorés par Vitest sans URL dédiée, comme documenté ; suites PostgreSQL de collaboration exécutées séparément |

Pour rejouer le navigateur, démarrer les quatre apps et Caddy, installer Edge (ou choisir `BROWSER_CHANNEL`) et faire confiance au certificat. `pnpm test:collab:browser` réutilise ses deux comptes de test, enregistrés dans `.local/3b-browser-accounts.json` avec leurs mots de passe : fichier local ignoré, à ne jamais partager. Il ajoute une nouvelle page à chaque essai et conserve une capture dans `.local/3b-browser.png`. Les quotas d'authentification restent appliqués. Il ne lit pas vos comptes personnels ni vos pages de travail.

```powershell
pnpm check
pnpm build
pnpm test:collab:e2e --suite frontend
pnpm test:collab:e2e --suite transport
pnpm test:collab:e2e --suite development
pnpm test:collab:browser
```

La description de PR préparée dans `.local/session-3-pr.md` et le compte rendu final donnent le hash poussé, vérifié sur le dépôt distant. Aucun merge n'est effectué dans cette livraison.

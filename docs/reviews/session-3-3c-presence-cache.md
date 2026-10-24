# Session 3c — présence et copie locale persistante

Les personnes présentes ont maintenant un nom, une couleur stable et un curseur dans le texte. Le corps des pages est conservé dans IndexedDB : une modification hors ligne peut survivre à la fermeture de l'onglet. La déconnexion efface les copies de cet utilisateur dans ce profil de navigateur et ferme ses autres éditeurs, même lorsqu'un onglet reprend après suspension. Les anciens brouillons JSON sont supprimés au premier chargement.

Cette livraison reste sur `codex/session-3-collaboration-design`, après 3b (`3674473d61e5872d4278e9333d0b48d44e398839`). **Le développeur fusionnera après sa relecture. 3d commencera ensuite sur une nouvelle branche**, avec pour cible au moins 30 pages typiques dans 1 Gio. Aucune optimisation mémoire 3d n'est incluse ici. La finition de l'interface est ajoutée aux prérequis avant les premiers utilisateurs, avec la session 4.

Implémentation et tests : commit `231379caae371dee6a0d93fc6dc19cc1f6266d86`. Le commit de documentation qui suit ajoute cette fiche et les journaux complets.

## Fichiers à lire en priorité

1. `apps/web/src/lib/yjs-cache.ts` : transactions IndexedDB, isolation utilisateur/page/génération, effacement et blocage des écritures tardives. `yjs-cache.test.ts` décrit les huit scénarios de stockage.
2. `apps/web/src/lib/collaboration-cache.ts`, `collaboration-client.ts` et `local-sign-out.ts` : raccordement Yjs, reçus, réveil des onglets et déconnexion même si le nettoyage local échoue.
3. `apps/web/src/components/page-editor.tsx`, `workspace-pages.tsx`, `local-data-boundary.tsx`, `local-recovery.tsx` et `app/page.tsx` : copie locale, fermeture sans réseau, purge initiale, copie d'ancienne génération et confirmation de déconnexion.
4. `packages/contracts/src/presence.ts`, `apps/collab/src/service/server.ts`, `protocol.ts` et `admission.ts` : noms/couleurs vérifiés, limites et retrait des curseurs. `apps/api/src/modules/blocks/block-write.service.ts` lie l'ouverture du cache à l'identité fraîche du guard Nest.
5. `apps/collab/src/testing/presence.e2e.ts` et `scripts/test-collab-browser.mjs` : tests réels. Puis la section « Livraison 3c » de l'ADR 017 et « Sessions suivantes » d'ARCHITECTURE.md.

## Ce qui est prouvé et ce qui ne l'est pas

| Sujet                     | Preuve exécutée                                                                                                                                                                                                                                                                   | Limite de cette preuve                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Présence                  | PostgreSQL, Better Auth, Hocuspocus et providers réels : deux identités, couleur stable, reconnexion, nom falsifié neutralisé, retrait étranger refusé, curseur invalide, taille et débit bornés ; aucune révision de contenu créée                                               | Deux personnes ; pas de mesure de 50 présences simultanées. Palette de huit couleurs : collisions possibles                        |
| Curseurs affichés         | Edge via HTTPS/WSS Caddy : noms et curseur distant visible, couleur identique après réouverture                                                                                                                                                                                   | Deux contextes d'un même moteur ; pas Firefox/Safari. Les inputs de fiche n'ont pas de curseur distant                             |
| Fermeture hors ligne      | Edge/IndexedDB réel : texte hors ligne, transaction locale terminée, fermeture, réouverture en ligne, fusion, reçus et disparition des marqueurs en attente ; fiche conservée                                                                                                     | Pas d'ouverture initiale totalement hors ligne, pas de coupure électrique testée. Le titre non enregistré reste en mémoire         |
| Déconnexion multi-onglets | Edge : onglet hors ligne, suspendu par le protocole navigateur, déconnexion dans l'autre onglet, stores de contenu vides, réveil sans résurrection ni envoi du texte privé ; autre compte conservé                                                                                | Dans une même origine et un même profil. Les caches d'un autre navigateur/profil ne peuvent pas être effacés par JavaScript ici    |
| Session et révocation     | Test API Nest : identité renvoyée égale à la session injectée. Test WebSocket : cookie d'un autre compte refusé avant synchronisation. Edge : révocation serveur, éditeur fermé, updates de la page effacées                                                                      | Pas de récupération de mot de passe ni de politique forte, prévues en session 4                                                    |
| Concurrence et stockage   | Huit tests Vitest avec `fake-indexeddb` : isolation, fermeture/réouverture, deux writers/recevabilité des reçus, compaction/suppressions, effacement et tickets tardifs, abandon, marqueur/quota/stockage absent, retrait v1 et échec de nettoyage avec révocation serveur tentée | L'épuisement réel du disque et le bouton de retry après quota ne sont pas simulés dans Edge                                        |
| Ancienne génération       | Tests de stockage : aucune fusion entre générations. Interface de téléchargement binaire `.yjs` et abandon                                                                                                                                                                        | Pas de rebasage automatique ; téléchargement/import de secours non testé de bout en bout dans Edge. Pas d'import automatique livré |
| Ancien format session 2   | Edge : création d'un ancien brouillon puis premier chargement, base v2 vide. Vitest : tentative d'ouverture v1 refusée avec `VersionError`                                                                                                                                        | Un ancien onglet qui garde une connexion IDB ouverte doit être fermé ; l'écran le demande explicitement                            |

Les contrôles de régression couvrent aussi les douze scénarios de transport (durabilité, validation, projection, droits, révocation), le provider front, l'admission avant file et les pages Nest/BlockWriteService avec titre 409. Les journaux complets accompagnent cette fiche ; leurs erreurs intentionnelles de refus ne sont pas masquées. Ils se terminent tous par `EXIT_CODE=0`.

## Ce qui pourrait casser

- **Confondre copie locale et sauvegarde serveur.** « Copie locale à jour » permet de fermer l'onglet, mais le serveur peut encore refuser la fusion (droits retirés, génération changée, contenu ou taille invalides). Attendre « Enregistré sur le serveur » pour une sauvegarde distante. Le cache garde les identités Yjs ; il ne recrée jamais le document depuis le JSON projeté.
- **Suppression par le navigateur.** Effacer les données du site, la pression de stockage ou fermer toute une session privée peut supprimer IndexedDB. Cette copie n'est pas une sauvegarde indépendante. Les tests de fermeture se font dans le profil normal A.
- **Stockage bloqué ou saturé.** Message explicite, nouvelle tentative et export du contenu courant. La déconnexion serveur est toujours tentée ; si l'effacement échoue, l'écran conserve un bouton de nettoyage et demande de rester sur le poste partagé. Des UUID et marqueurs de révocation restent volontairement, sans contenu ni secret, pour empêcher un ancien onglet de réécrire.
- **Perte d'accès en pleine coupure.** Le navigateur ne peut pas savoir qu'une adhésion a été retirée sans réseau. À la reprise, le serveur revérifie les droits ; au rechargement, aucun cache n'est lu/rendu avant cette vérification. Une révocation connue ferme l'éditeur et efface les updates de sa page.
- **Versions des bibliothèques.** Awareness et les reçus dépendent du protocole Hocuspocus figé. Les garde-fous sont testés sur les versions installées ; toute mise à jour doit rejouer ces tests.
- **Capacité actuelle.** Cinq salles actives avec le budget par défaut, aucune amélioration annoncée en 3c. Les quotas d'authentification par IP sont encore ceux de session 1. 3d puis la session 4 sont obligatoires ; la finition des messages, du titre, des tags et de la présentation est aussi planifiée avant les premiers utilisateurs.

## Démarrer pour la relecture

Conserver le `.env` existant. Si les quatre applications tournent déjà sur le build livré, actualiser les onglets. Sinon :

```powershell
pnpm install --frozen-lockfile
docker compose up -d postgres mailpit caddy
pnpm db:migrate
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
pnpm dev
```

Le certificat de `https://localhost` doit être approuvé. Ne pas lancer dev et start simultanément. Il n'y a **aucune nouvelle migration SQL en 3c**. Pour d'anciennes pages qui demandent un reset, suivre la procédure ciblée de la [fiche 3b](session-3-3b-editor.md) ; aucun reset global ou automatique n'a été effectué.

## Test manuel : présence à deux navigateurs

1. Ouvrir A dans une fenêtre **normale**, avec le premier compte vérifié. Ouvrir B dans une fenêtre privée ou un second navigateur, avec un **autre compte** vérifié. Conserver B ouvert pendant les tests. Si nécessaire, créer/vérifier B via Mailpit sur `http://localhost:8025`.
2. Ajouter B au workspace de A par la méthode de développement existante ; l'UUID est dans l'URL du workspace :

```powershell
pnpm dev:collab add-member --workspace 'UUID-du-workspace' --email 'second-compte@example.test'
```

3. Ouvrir la même page dans A et B, attendre **Enregistré sur le serveur** et **Copie locale à jour**. Les deux noms doivent apparaître. Cliquer et déplacer le curseur dans le corps de A : B voit son curseur nommé et coloré. Sélectionner du texte, puis inverser A/B.
4. Écrire à deux et vérifier que les deux contributions restent présentes. Ajouter une fiche personnage ; changer son nom dans A et sa santé dans B. Les deux champs convergent ; aucun curseur dans les inputs de la fiche n'est attendu.
5. Fermer puis rouvrir le document de A. La couleur de A doit rester identique. Ouvrir un deuxième onglet A : son nom n'est pas dupliqué dans la liste, même si deux curseurs sont possibles.

## Test manuel : hors ligne, fermeture et réouverture

1. Dans A, enregistrer le titre avec son bouton. Garder B connecté. Dans les outils développeur de A, **Network/Réseau → Offline/Hors ligne**.
2. Dans le corps de A, saisir une phrase reconnaissable, puis modifier un champ de fiche. Attendre **Copie locale à jour** ; le statut serveur indique toujours **Hors ligne**. B ne doit pas voir ces changements. Ajouter une autre phrase dans B et attendre sa confirmation serveur.
3. Fermer **l'onglet A**, en gardant le profil normal du navigateur. Ne pas effacer les données du site. Rétablir le réseau avant de rouvrir `https://localhost`, puis le workspace et la même page. Si le mode Offline du panneau est resté actif, le retirer avant de recharger.
4. Attendre les deux confirmations : la phrase hors ligne, le changement de fiche et la phrase de B doivent tous être présents dans A et B. La réouverture a d'abord revérifié la session et les droits, puis fusionné le contenu ; un démarrage totalement hors ligne n'est pas proposé.

## Test manuel : déconnexion et effacement

1. Ouvrir la même page dans **deux onglets du profil A**. Sur A2, passer hors ligne, écrire « à effacer à la déconnexion » et attendre la copie locale. Laisser A2 à l'arrière-plan. B reste connecté avec son propre compte.
2. Sur A1, revenir à l'accueil avec le lien **memoria**, cliquer **Se déconnecter**, lire l'avertissement puis **Effacer les copies locales et se déconnecter**. Cela abandonne volontairement le texte hors ligne de A2. A1 revient à la connexion.
3. Revenir sur A2, même encore hors ligne : l'éditeur doit être fermé et l'écran doit indiquer que la session est fermée sur ce poste. Remettre le réseau. Le texte abandonné ne doit jamais apparaître dans B.
4. Facultatif, dans **Application → IndexedDB → memoria-yjs-cache-v1**, actualiser l'affichage : `documents` et `updates` sont vides pour A. `users`/`sessions` contiennent seulement les marqueurs opaques qui empêchent les onglets anciens de recréer le contenu. B, dans son autre profil, conserve sa propre copie.
5. Se reconnecter dans A et rouvrir la page. Seul le contenu confirmé sur le serveur revient. Fermer puis rouvrir l'ancien onglet A2 ne ressuscite rien.
6. Vérifier également `memoria-local-drafts-v1` : version 2, uniquement le store vide `retired`. Les anciens brouillons de session 2 ne sont jamais proposés à la restauration.

## Contrôles et journaux complets

Contrôles du 24 octobre 2026 ; les fichiers `.txt` sont les sorties intégrales, pas des extraits réécrits. Seules les fins de ligne et les espaces de fin de ligne sont normalisés ; aucun message n'est retiré :

- [`pnpm check`](session-3-3c-check.txt) : lint/format, types des 12 packages, preuve de build Nest ; **90 tests Vitest passés, 6 tests SQL génériques ignorés** faute de `TEST_DATABASE_URL`. Huit tests Yjs IndexedDB remplacent les six tests des anciens brouillons JSON retirés.
- [`pnpm build`](session-3-3c-build.txt) : les quatre applications compilent.
- [Transport](session-3-3c-transport.txt) : 12 scénarios, 13 tests Node avec le parent ; [provider front](session-3-3c-frontend.txt), [admission](session-3-3c-admission.txt), [présence](session-3-3c-presence.txt) : un scénario composé chacun, avec service réel.
- [Pages et identité Nest](session-3-3c-pages.txt) : 7 scénarios, 8 tests avec le parent ; PostgreSQL, migrations et writer réel.
- [Navigateur](session-3-3c-browser.txt) : scénario composé Edge via Caddy, incluant présence, fermeture/reprise, onglet hors ligne suspendu/réveillé, effacement, ancien format et révocation serveur. Aucune erreur JavaScript, aucun contournement TLS ni hook.

Les benchmarks de 3a ne sont pas rejoués ni présentés comme améliorés. Les tests SQL/serveur utilisent des schémas temporaires ; le test navigateur laisse sa page de test dans son workspace local. Aucun contenu préexistant de l'utilisateur n'est supprimé par les tests. La description de PR de **toute la session 3 jusqu'à 3c** et le reçu de vérification du commit distant sont préparés dans `.local/` ; les preuves versionnées ci-dessus sont accessibles dans la PR.

# Session 4b — politique de workspace et actions sensibles

Livraison sur `codex/session-4-strong-auth`, après 4a validée par le développeur sur Android, Windows Hello et YubiKey. Le propriétaire peut maintenant imposer un facteur, accorder une grâce aux membres déjà présents et changer les rôles owner/member après une vérification récente. Le QR TOTP est généré localement. **Arrêt pour relecture après 4b** ; récupération et nouveaux quotas ne sont pas livrés ici.

Une seule PR pour la session 4, après la revue adverse 4f. Les descriptions `.local/session-4a-pr.md` et `.local/session-4b-pr.md` sont conservées pour la description finale ; création et merge restent au développeur. Le hash de cette livraison est donné dans le compte rendu et ajouté à la description locale après vérification directe sur le distant.

## Lire en priorité

1. [ADR 004](../adr/004-connexion-forte.md#4b--règles-exécutables-et-qr-denrôlement) : échéances, réactivation, accès bloqué et QR ; [ADR 003](../adr/003-better-auth.md#4b--politique-de-workspace-et-effets-sensibles) : transactions et intégration.
2. [Service de politique](../../apps/api/src/modules/workspaces/workspace-security.service.ts) et [contrôle sensible commun](../../packages/auth/src/workspace-security.ts) : droits, fraîcheur, 409, dernier propriétaire, audit atomique.
3. [Migration SQL](../../packages/db/drizzle/0010_workspace_security_boundary.sql), [accès aux pages](../../apps/api/src/modules/pages/content-access.ts), [résolveur collab](../../apps/collab/src/service/access.ts) et [hooks des facteurs](../../packages/auth/src/security-plugin.ts) : même frontière d'accès, verrous et révocations.
4. [Test réel 4b](../../apps/api/src/workspace-security.e2e.ts) : douze scénarios, avec connexions réseau et signatures P-256 réelles. Les contrôleurs de contrat clé/webhook ne sont inclus que dans cet exécutable de test.
5. [Écran de politique](../../apps/web/src/components/workspace-security.tsx), [QR local](../../apps/web/src/components/totp-qr.tsx) et [parcours navigateur](../../scripts/test-auth-strong-browser.mjs).

## Comportement et risques concrets

- Grâce de 0 à 30 jours, défaut sept. Les adhésions existantes reçoivent une échéance à l'activation ; les nouvelles n'ont pas de grâce. Changer la durée ne modifie pas les échéances fixées. Désactiver puis réactiver ne les repousse pas non plus. Utiliser un nouvel espace de test pour comparer des délais différents.
- Une preuve forte de moins de dix minutes est nécessaire pour modifier la politique, changer un rôle ou retirer un facteur. Une preuve plus ancienne permet encore de travailler sur le contenu. Le dernier facteur ne peut pas être retiré tant qu'un workspace impose la connexion forte.
- Les mutations de politique et de rôle, ainsi que leur audit, sont atomiques. Une version/rôle périmé renvoie 409. L'espace garde au moins un propriétaire. Les routes natives organization ne permettent pas de contourner ces contrôles.
- API de pages, recherche, ouverture WS, chaque écriture collaborative et commandes internes appliquent la politique. Les notifications accélèrent la fermeture ; le contrôle de secours est à quatre secondes pour garder une marge sous la cible de cinq secondes. Cette cible est vérifiée localement sans surcharge, pas garantie par un essai de charge à cinquante comptes.
- Les mutations de facteurs prennent les sessions avant les pages, afin de respecter l'ordre des transactions relationnelles. Une suppression attend les politiques des workspaces puis les pages avant de revérifier fraîcheur et dernier facteur. Un test de concurrence couvre l'activation d'une obligation pendant cette attente.
- Le QR et la clé manuelle sont des secrets visibles à l'écran. L'application ne les persiste pas et ne les transmet à aucun générateur externe. La [sauvegarde hors serveur de BETTER_AUTH_SECRET](../self-hosting.md#secret-dauthentification-et-totp--sauvegarde-indispensable) est indispensable : sa perte rend les TOTP inutilisables.
- Les clés API et webhooks ne sont pas livrés. Leur barrière commune est testée avec un effet SQL témoin ; les futures routes devront l'appeler dans leur propre transaction. Les invités/admins arrivent en session 5.
- Cette étape bloque l'accès serveur, mais n'efface pas le contenu déjà affiché, exporté ou conservé hors ligne. L'interdiction du cache et « Poste partagé » restent en 4e ; la récupération en 4c, les quotas NAT/compte en 4d. Les anciens petits quotas IP restent actifs entre-temps.

## Contrôles et preuves

Les résultats définitifs et codes de sortie sont conservés dans `docs/reviews/evidence/session-4b-*.txt`. Les suites avec PostgreSQL utilisent des schémas isolés ; le navigateur crée/nettoie son compte et son workspace de test. Aucune base métier n'est réinitialisée. Le test de panne SQL écrit volontairement `API request failed: Error` ; ce message générique accompagne un scénario réussi de rollback.

| Commande                                                         | Résultat final                                                                           | Journal                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                     | Lint/format, types de douze packages, bootstrap ; 108 tests réussis, six SQL ignorés ici | [check](evidence/session-4b-check.txt)                                                             |
| `pnpm build` / `pnpm db:migrate`                                 | Build des quatre apps et migrations réussis ; aucun reset                                | [build](evidence/session-4b-build.txt), [migrations](evidence/session-4b-migrate.txt)              |
| `pnpm test:auth:workspace`                                       | Douze scénarios, treize tests avec le parent, tous réussis                               | [workspace](evidence/session-4b-workspace.txt)                                                     |
| `pnpm test:auth:strong`                                          | Quatorze tests réussis                                                                   | [facteurs](evidence/session-4b-strong.txt)                                                         |
| `pnpm test:auth:strong:browser`                                  | Un parcours réussi, aucune erreur de page                                                | [navigateur](evidence/session-4b-browser.txt)                                                      |
| `pnpm test:auth:e2e` / `pnpm test:pages:e2e`                     | Six / huit tests réussis                                                                 | [auth](evidence/session-4b-auth.txt), [pages](evidence/session-4b-pages.txt)                       |
| `pnpm test:db`                                                   | Les six tests SQL réussis                                                                | [SQL](evidence/session-4b-db.txt)                                                                  |
| `pnpm test:collab:e2e --suite transport` / `--suite revocations` | Treize / un tests réussis                                                                | [transport](evidence/session-4b-transport.txt), [révocations](evidence/session-4b-revocations.txt) |

Tous ces journaux se terminent par `EXIT_CODE=0`. Seuls les espaces de fin de ligne sont retirés pour l'archivage ; aucun résultat ou message de test n'est supprimé. Les builds peuvent réutiliser le cache Turbo dont la clé dépend des sources ; les scénarios d'intégration et le navigateur ont été exécutés réellement.

| Sujet                                          | Preuve réelle                                                                                                                                                          | Limite restant à reprendre en 4f                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Politique, grâce et isolation entre workspaces | Activation 7 jours, modification/réactivation sans report, 409, nouvel adhérent sans grâce, échéance nulle refusée                                                     | Pas de simulation d'un déplacement d'adhésion pendant une mutation de facteur                                      |
| Contournement de la politique                  | API/pages/recherche/renommage, BlockWriteService et HMAC direct refusés ; reconnexion WS refusée et révision inchangée                                                 | Pas de rejeu automatisé du contenu d'un véritable cache navigateur après échéance ; à compléter avec 4e/4f         |
| Fermeture des connexions                       | HTTP activation sans grâce ; expiration par le temps seul ; HTTP enrôlement et suppression passkey jusqu'à fermeture effective ≤5 s                                    | Chemin TOTP HTTP→WS non testé séparément ; mêmes effets de génération/session, TOTP cryptographique couvert par 4a |
| Actions sensibles                              | Preuve ancienne refusée, vérification après attente réelle d'un verrou ; owner/member ; dernier owner ; cible d'un autre workspace ; route native fermée               | Clés/webhooks : contrats seulement, produits futurs non testables                                                  |
| Facteur et politique concurrents               | Suppression du dernier facteur attend l'activation en cours puis refuse ; facteur conservé                                                                             | Pas de campagne exhaustive de deadlocks, panne SQL/reconnexion à chaque point d'interruption                       |
| Atomicité                                      | Panne injectée dans l'audit : politique, version et échéances inchangées ; aucun effet sensible avec preuve ancienne                                                   | Charge à cinquante comptes toujours à qualifier sur hôte dédié                                                     |
| QR et interface                                | Vrai navigateur HTTPS/Mailpit ; pixels décodés par jsQR comparés à l'URI ; requêtes locales seulement ; canvas supprimé ; politique persistée et dernier owner protégé | Scan matériel du nouveau QR proposé ci-dessous ; matériel passkey 4a validé par le développeur                     |

La matrice 4f d'ARCHITECTURE.md est mise à jour. Les absences ci-dessus ne constituent pas une acceptation implicite : elles sont corrigées ou acceptées explicitement par le développeur avant le merge de session 4.

## Guide manuel pas à pas

### Préparation

1. Utiliser les données de développement et `https://localhost` derrière Caddy. Sur une installation qui n'a pas encore 4b : arrêter API/collab, lancer `pnpm db:migrate`, `pnpm build`, puis redémarrer API, collab et web. Aucun reset nécessaire. La pile locale de cette livraison est déjà migrée et redémarrée.
2. Navigateur habituel : compte A propriétaire avec un facteur fort déjà vérifié. Fenêtre privée ou autre navigateur : compte B vérifié par email, **sans facteur pour commencer**. Créer deux nouveaux espaces depuis A : « Grâce » et « Immédiat » ; créer une page dans chaque espace.
3. Ajouter B aux deux espaces avec la méthode de développement disponible (remplacer UUID et email) : `pnpm dev:collab add-member --workspace UUID --email compte-b@example.test`. Le UUID est dans l'URL de l'espace. Faire cet ajout **avant** l'activation des politiques. Les invitations depuis l'interface restent en session 5.

### Grâce et politique par espace

4. Dans « Grâce », suivre **Sécurité de l’espace** dans la barre latérale. Cocher **Exiger un facteur fort**, choisir sept jours et enregistrer. Si le bouton est désactivé, aller dans **Sécurité du compte**, vérifier un facteur, puis revenir. Depuis B, le contenu reste accessible ; sa page de sécurité indique son échéance.
5. Depuis A, passer la durée à trente jours. L'échéance de B doit rester identique, même après rechargement. Une désactivation/réactivation conserve aussi cette échéance. Le test automatisé vérifie l'expiration sans attendre sept jours ; il avance uniquement l'horloge de la fixture SQL, sans route de test en production.
6. Dans « Immédiat », B ouvre la page et attend la connexion de l'éditeur. Depuis A, activer l'obligation avec **zéro jour**. Le document de B perd sa connexion sous cinq secondes ; recharger, rechercher ou ouvrir une page ne permet pas de contourner le blocage. « Grâce » reste accessible avec son échéance future. L'écran **Sécurité de l’espace** de B reste accessible pour expliquer le blocage.

### QR TOTP et retour au contenu

7. Depuis B, ouvrir **Sécurité du compte**, confirmer le mot de passe si demandé et configurer une application de codes. Scanner le QR avec une application TOTP sur Android ; la clé manuelle reste disponible. Ne pas capturer cet écran dans un rapport public. Vérifier le premier code et conserver les dix codes de secours hors du navigateur ; leur consommation sera livrée en 4c.
8. L'enrôlement seul ne donne pas accès aux espaces. Après avoir conservé les codes, effectuer la vérification explicite demandée ; attendre le code suivant si le pas utilisé pour l'enrôlement est encore affiché. Retourner dans « Immédiat » : contenu et collaboration doivent fonctionner. Le QR et la clé ne doivent plus être affichés.

### Rôles et preuve récente

9. Depuis A, **Sécurité de l’espace → Rôles des membres** : nommer B propriétaire, actualiser chez B, puis le repasser membre. Le propriétaire doit être récemment vérifié ; un membre n'a pas les boutons de gestion. Essayer de passer A membre quand il est l'unique propriétaire : refus explicite, rôle conservé. Dans deux onglets de politique, enregistrer un changement puis tenter d'enregistrer l'ancien état : 409, demander l'actualisation.
10. Pour contrôler l'expiration sensible manuellement, laisser passer dix minutes après la dernière preuve sans en refaire : lecture/édition toujours possibles, changement de politique/rôle refusé. Revérifier un facteur dans **Sécurité du compte**, revenir/actualiser : action à nouveau possible. Les tests automatisés couvrent ce délai sans attente de dix minutes.

### Changement de facteur et connexion ouverte

11. Sur un compte de test possédant **deux facteurs vérifiés**, ouvrir une page dans un onglet et la sécurité du compte dans un autre. Après une preuve récente et réouverture de la page si la preuve a fait tourner la session, supprimer un facteur dans l'onglet de sécurité. La page perd son WebSocket sous cinq secondes ; l'ancien cookie ne permet plus de charger le contenu. Se reconnecter avec le facteur restant.
12. Dans un workspace exigeant la connexion forte, tenter de supprimer l'unique facteur restant : refus, facteur conservé. Ne pas supprimer les derniers moyens d'accès d'un compte important ; la récupération de 4c n'est pas encore disponible.

Pour reproduire les preuves : `pnpm check`, `pnpm test:auth:workspace`, `pnpm test:auth:strong`, `pnpm test:auth:strong:browser`. Les suites supplémentaires pages/SQL/transport et leurs résultats sont listées dans les journaux. Aucun benchmark de performance n'est exécuté ou revendiqué en 4b.

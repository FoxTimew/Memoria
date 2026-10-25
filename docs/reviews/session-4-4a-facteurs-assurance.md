# Session 4a — facteurs et assurance de session

25 octobre 2026, branche `codex/session-4-strong-auth`. Le cadrage est validé, y compris toutes les valeurs des ADR 004/015. Cette livraison rend les facteurs utilisables ; 4b n'est pas commencée. La création et la fusion de la PR restent au développeur. Description préparée dans `.local/session-4a-pr.md`.

## Fichiers à lire en priorité

1. [ADR 003](../adr/003-better-auth.md#4a--intégration-exécutée-et-vérifiée) et [ADR 004](../adr/004-connexion-forte.md#périmètre-effectivement-livré-en-4a) : séparation entre ajout d'un facteur, preuve forte et récupération. Le mot de passe d'un compte équipé ouvre une session restreinte, sans accès au contenu.
2. [Intégration des facteurs](../../packages/auth/src/security-plugin.ts), [transaction HTTP](../../packages/auth/src/http-handler.ts), [assurance](../../packages/auth/src/assurance.ts) et [fonctions SQL](../../packages/db/drizzle/0008_session_assurance_boundary.sql) : preuve liée à la vraie session, vérification UV, cinq essais, anti-rejeu et révocation.
3. [Test serveur](../../apps/api/src/strong-auth.e2e.ts) et [authentificateur signé de test](../../apps/api/src/testing/webauthn.ts) : vraie crypto et vrai PostgreSQL, pas un vérificateur simulé qui renverrait `true`.
4. [Écran de sécurité](../../apps/web/src/app/securite/page.tsx), [connexion](../../apps/web/src/components/auth-screen.tsx) et [test navigateur](../../scripts/test-auth-strong-browser.mjs).
5. [Étape 4f](../../ARCHITECTURE.md#4f--revue-adverse-de-toute-la-session-4-obligatoire-avant-merge) : matrice adverse obligatoire, aucun manque implicitement accepté.

## Ce qui est livré

TOTP à six chiffres, clé d'enrôlement saisie manuellement dans l'application d'authentification, activation par code puis **nouvelle** vérification pour accéder au contenu. Passkeys avec PIN/biométrie exigés par les options et contrôlés dans le résultat cryptographique serveur ; ajout, connexion directe, réauthentification, renommage et suppression. Les sessions tournent après une preuve forte ; l'ancienne est supprimée. Ajouter un facteur ferme les autres sessions et laisse la session d'enrôlement restreinte ; retirer un facteur les ferme toutes.

Dix codes communs sont générés au premier facteur et peuvent être renouvelés avec une preuve forte récente. Ils ne sont affichés qu'une fois et sont stockés sous forme d'empreintes. **Leur utilisation pour récupérer le compte arrivera en 4c.** Ne pas tester une perte volontaire de tous les facteurs sur un compte à conserver à ce stade.

Les contrôles serveur distinguent la force et sa fraîcheur : après dix minutes, le contenu reste accessible, mais les changements de facteurs/codes exigent une nouvelle preuve. API et accès collaboratif SQL partagent la même frontière. Les cinq nouvelles tables et les deux fonctions SQL sont installées sans réinitialisation de données. Le paramètre serveur « poste partagé » est déjà transféré aux rotations, mais son choix et la politique workspace arrivent en 4e.

## Ce qui pourrait casser

- Déployer API/collab sans migrations 0007/0008 fait échouer les lectures d'assurance. Garder `BETTER_AUTH_SECRET` stable : il protège les secrets TOTP et cookies existants.
- Un upgrade Better Auth/passkey exige de rejouer les preuves cryptographiques et la panne SQL. Le wrapper remplace volontairement le hook de login TOTP natif, dont la surface ne couvre pas les comptes avec passkeys seules. Les deux packages doivent partager leur runtime (ADR 014).
- Un changement de facteur invalide des sessions ouvertes, donc l'éditeur d'un autre onglet peut perdre son accès. Synchroniser ou exporter les changements locaux avant cette action. La déconnexion explicite utilise le nettoyage IndexedDB existant ; la politique de cache sera renforcée en 4e.
- Les anciennes limites IP restent basses : 5 connexions/minute, 3 inscriptions/10 minutes. Attendre la fenêtre si plusieurs tests manuels se succèdent. Les seuils NAT sont retenus, **pas encore appliqués**.
- Les cinq essais sont par défi/session. Les délais progressifs par compte et la purge des compteurs seront livrés en 4d ; plusieurs nouveaux logins peuvent encore créer plusieurs défis. Aucun utilisateur réel avant la session complète.
- Pas encore de QR TOTP, de récupération email/code, ni de commande opérateur. L'interface de test permet de saisir la clé TOTP manuellement. Pas de test physique Windows Hello/clé matérielle réalisé par l'agent.

## Guide de test manuel

### Préparer

1. Sur cette branche : `pnpm install --frozen-lockfile`, `pnpm infra:up`, puis `pnpm db:migrate`. Arrêter les anciens processus Memoria avant de lancer `pnpm dev`, ou `pnpm build` puis `pnpm start`. Ne pas supprimer les données. Ouvrir **https://localhost**, avec la CA Caddy déjà approuvée.
2. Préparer une application de codes TOTP et, si disponible, Windows Hello ou une clé acceptant PIN/biométrie. Créer un compte de test A et vérifier son email dans Mailpit (`http://localhost:8025`). Se connecter dans un navigateur normal et aussi dans une fenêtre privée, avant d'activer un facteur. Les deux doivent accéder à « Mes espaces ».

### TOTP et session restreinte

3. Dans le navigateur normal, ouvrir « Sécurité du compte », saisir le mot de passe puis « Configurer une application de codes ». Ajouter la clé affichée dans l'application TOTP : six chiffres, trente secondes. Aucun QR n'est affiché dans cette version.
4. Entrer un mauvais code, puis le bon. Après succès, conserver les dix codes de secours hors de ce poste, éventuellement via le téléchargement, puis cliquer « J’ai conservé mes codes ». Recharger ne doit pas les réafficher. L'écran demande encore de vérifier l'identité : **l'ajout n'est pas une connexion forte**.
5. Attendre le prochain code de l'application, le saisir. « Vous êtes connecté avec un facteur fort » apparaît et « Mes espaces » est accessible. Réutiliser immédiatement ce code doit être refusé comme déjà utilisé.
6. Dans la fenêtre privée précédemment connectée, recharger « Mes espaces » : sa session doit avoir été révoquée. Refaire la connexion avec le seul mot de passe : redirection vers `/securite`, sans accès au contenu, même en saisissant `/` dans la barre d'adresse. Attendre un nouveau pas TOTP, puis terminer la vérification.
7. Dans une nouvelle session restreinte, faire cinq essais incorrects : une sixième tentative est refusée et réactualiser ne remet pas le compteur à zéro. Attendre l'expiration de cinq minutes avant de redemander le défi. La protection couvrant plusieurs sessions sera livrée en 4d.

### Passkeys, ancienneté et second compte

8. Revenir au navigateur normal, se reconnecter si sa session a été remplacée et refaire une preuve TOTP. Nommer puis ajouter une passkey. Accepter la demande PIN/biométrique du système. L'ajout ferme les autres sessions et réclame une **vérification avec la passkey** avant le retour au contenu.
9. Renommer la passkey et recharger : son nom est conservé. Se déconnecter depuis la sécurité, confirmer l'effacement des copies locales, puis utiliser « Se connecter avec une passkey » sur l'écran de connexion : le contenu est accessible sans demander aussi le TOTP. Si le matériel ne sait pas vérifier l'utilisateur, l'enrôlement doit échouer ; le cas UV faux est couvert automatiquement par les tests serveur.
10. Attendre plus de dix minutes sans refaire de preuve, puis recharger `/securite`. Le contenu reste accessible, mais modifier les facteurs/renouveler les codes demande une nouvelle vérification. La preuve automatique avance la date SQL pour tester ce délai sans attente réelle.
11. Après vérification récente, renouveler les codes et conserver le nouveau jeu ; l'ancien est remplacé. Supprimer une passkey ou désactiver TOTP (mot de passe demandé pour TOTP) ferme toutes les sessions. Faire ces essais seulement avec des comptes de test dont le mot de passe est connu.
12. Dans l'autre navigateur, créer un compte B sans facteur, vérifier l'email puis se connecter : la connexion simple continue à fonctionner. Pour tester le cas « passkey seule », ajouter une passkey à B sans TOTP, vérifier avec elle, se déconnecter puis tester le login par mot de passe : il doit rester restreint jusqu'à la passkey. Ne pas confondre les identités proposées par l'appareil pendant une réauthentification.

### Rejouer les contrôles

`pnpm check` puis `pnpm test:auth:strong` vérifient le socle et la preuve serveur isolée. `pnpm test:auth:strong:browser` traverse les builds démarrés derrière Caddy et Mailpit, dans Edge headless (authentificateur WebAuthn virtuel avec UV). Il crée puis supprime uniquement son propre compte aléatoire. Le quota d'inscription s'applique : attendre dix minutes en cas de répétitions. Aucun contournement de certificat ni de hook Git.

## Preuves réelles et limites

Les journaux complets ci-dessous contiennent le résultat final et `EXIT_CODE=0`. Les originaux restent dans `.local/session-4a-*.log` ; seuls les espaces de fin de ligne du journal de build ont été retirés de sa copie versionnée. Node compte aussi le test parent : **13 scénarios serveur = 14 tests rapportés**, et **12 scénarios transport = 13 tests rapportés**.

| Contrôle                                   | Résultat et journal                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                               | Lint/format, types des 12 packages, bootstrap Nest, Vitest : [journal complet](evidence/session-4a-check.txt)                                 |
| `pnpm build`                               | API, worker, collab et Next dont `/securite` : [build](evidence/session-4a-build.txt)                                                         |
| `pnpm test:auth:strong`                    | 13 scénarios ciblés, 14 réussis au total : [preuve](evidence/session-4a-proof.txt)                                                            |
| `pnpm test:auth:strong:browser`            | 1 parcours HTTPS/Mailpit réel, aucune erreur de page : [navigateur](evidence/session-4a-browser.txt)                                          |
| `pnpm test:auth:e2e`                       | 5 scénarios, 6 réussis : guard fermé par défaut et anciens quotas : [régression auth](evidence/session-4a-auth-regression.txt)                |
| `pnpm test:pages:e2e`                      | 7 scénarios, 8 réussis : writer, pages et autorisations : [pages](evidence/session-4a-pages.txt)                                              |
| `pnpm test:db`                             | 6 contraintes SQL réussies : [PostgreSQL](evidence/session-4a-db.txt)                                                                         |
| `pnpm test:collab:e2e --suite transport`   | 12 scénarios, 13 réussis, dont fermetures de vrais WS après révocation de session/membership : [transport](evidence/session-4a-transport.txt) |
| `pnpm test:collab:e2e --suite revocations` | 1 test du verrou, NOTIFY et contrôle SQL de secours : [révocations](evidence/session-4a-revocations.txt)                                      |

La preuve serveur utilise une application Nest compilée, Better Auth 1.7.12, des schémas PostgreSQL temporaires avec toutes les migrations et des signatures P-256. Elle vérifie TOTP concurrent, code erroné, compteur de cinq essais persistant, défi expiré, UV faux à l'ajout/connexion, mauvaise origine/RP ID, identité différente, défi passkey erroné/expiré/rejoué en concurrence, compte passkey seul, preuve ancienne, génération de compte modifiée et erreur SQL d'assurance sans fuite de cookie. Le navigateur vérifie les composants réellement rendus ; il ne démontre pas la compatibilité de tous les authentificateurs physiques.

Le résumé final de `pnpm check` est **108 tests réussis, 6 ignorés**, dans 21 fichiers réussis et un ignoré. Ces six tests SQL de schéma sont exclus par défaut et ont tous réussi séparément via `pnpm test:db`. Les tests e2e ci-dessus sont aussi distincts du résumé Vitest. Aucun benchmark de performance n'a été exécuté pour 4a ; le protocole secteur/RAM de mesure reste inchangé.

## État de la matrice adverse avant 4f

| Scénario                                                                     | Couverture réelle à cette étape                                                                                                                   | Reste obligatoire                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mot de passe seul malgré facteur actif, enrôlement promouvant la session     | Test serveur + navigateur ; refus API et résolveur collaboratif SQL                                                                               | Politique/grâce par workspace en 4b                                                                                                                           |
| Passkey sans UV, autre compte/origine/RP ID, défi expiré ou rejoué           | Signatures réelles et concurrence dans `strong-auth.e2e.ts`                                                                                       | Matériel physique : guide ci-dessus ; pas testé par l'agent                                                                                                   |
| Rejeu TOTP et remise à zéro d'un défi                                        | Concurrence et cinq essais/re-demande vérifiés                                                                                                    | Essais répartis sur plusieurs sessions/IP, délais et purge 4d : **absence de test actuel**                                                                    |
| Ancienne preuve, facteur supprimé, échec SQL laissant une session forte      | SQL/API : fraîcheur, génération, révocation et rollback/cookies                                                                                   | Changement de facteur déclenché par HTTP jusqu'à fermeture WS : **absence de test de bout en bout**, à ajouter en 4b ; transport de révocation existant passe |
| Reset ou récupération court-circuitant les facteurs, code consommé deux fois | Routes fermées ; code commun généré et régénéré seulement                                                                                         | Parcours reset/codes/opérateur 4c : **absence de test actuel**                                                                                                |
| Quotas contournables et victime maintenue bloquée                            | Régression des anciens quotas IP seulement                                                                                                        | NAT cinquante comptes, multi-IP, progression non prolongeable et emails 4d : **absence de test actuel**                                                       |
| Résurrection du cache après interdiction ou rotation                         | Nettoyage de déconnexion existant réutilisé ; `sharedComputer` conservé en SQL                                                                    | Politiques nouvelles et onglets retardataires 4e : **absence de test actuel**                                                                                 |
| CSRF ou secrets dans réponses/logs                                           | Origines absente/erronée refusées ; pas de backup codes natifs exposés ; empreintes seules en DB ; panne SQL sans détail sensible dans le journal | Revue globale des logs, audit, reset et cache en 4f ; pas de preuve exhaustive d'absence de fuite                                                             |

Cette liste n'est pas la validation finale de session 4. En 4f, chaque absence doit être corrigée ou acceptée explicitement par le développeur avant merge, avec trace datée. Aucune de ces absences n'est considérée comme acceptée ici.

## Suite de la relecture

4a validée par le développeur après son test manuel sur **Android, Windows Hello et YubiKey**. Les limites matérielles ci-dessus décrivent la campagne automatisée de livraison ; ce retour utilisateur les complète. Le QR et le parcours HTTP→fermeture WS sont livrés/testés dans la [fiche 4b](session-4-4b-politique-actions.md). Pas de PR intermédiaire : session 4 fusionnée en une seule fois après 4f ; conserver les descriptions de chaque sous-étape pour la description finale.

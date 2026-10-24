# Relecture — session 1, socle exécutable et connexion simple

Note de calendrier du 2026-10-23 : les résultats ci-dessous décrivent la livraison de session 1. Le nouvel ordre place la collaboration en session 3 et la connexion forte en session 4, avant tout utilisateur réel. Voir [ARCHITECTURE.md](../../ARCHITECTURE.md#sessions-suivantes).

Branche : `codex/session-1-bootstrap-auth`, depuis le cadrage fusionné dans `main`.

## Fichiers à lire en priorité

1. [ADR 014](../adr/014-build-serveur-typescript-source.md) et [preuve de bootstrap](../../apps/api/src/bootstrap-probe.ts) : le risque Nest/décorateurs/packages TypeScript a été testé en premier, puis enregistré dans un premier commit isolé.
2. [Guard global](../../apps/api/src/modules/auth/auth.guard.ts), [enregistrement dans AuthModule](../../apps/api/src/modules/auth/auth.module.ts) et [contrôleur Better Auth](../../apps/api/src/modules/auth/auth.controller.ts) : toute nouvelle route Nest est protégée ; seules les exceptions portent `@Public()`. Les contrôleurs reçoivent l'identité par `@CurrentUser()`.
3. [Configuration Better Auth](../../packages/auth/src/create-auth.ts), [configuration HTTP](../../apps/api/src/app.ts) et [ADR 015](../adr/015-authentification-simple-et-workspaces.md) : vérification d'email, cookies, origine, limites de débit et justification des valeurs. Aucun facteur fort actif.
4. [Service de workspaces](../../apps/api/src/modules/workspaces/workspaces.service.ts) : propriétaire déterminé par le serveur, transaction commune au plugin et à nos tables, collisions de nom et liste filtrée.
5. [Tests du guard et des quotas](../../apps/api/src/auth.e2e.ts), puis [parcours HTTP](../../scripts/test-session1.mjs) : vraie application Nest, vrai PostgreSQL, puis Caddy HTTPS et Mailpit.
6. [Écrans de connexion](../../apps/web/src/components/auth-screen.tsx), [liste des workspaces](../../apps/web/src/app/page.tsx) et [worker](../../apps/worker/src/main.ts).

## Ce qui pourrait casser

- Un certificat Caddy non approuvé bloque le navigateur. Le certificat public `.local-root.crt` doit être installé dans les autorités de confiance du compte local ; ne pas désactiver TLS.
- PostgreSQL doit être démarré et les migrations appliquées. Une mauvaise configuration SMTP empêche l'envoi du lien ; le formulaire permet de le renvoyer. En production, SMTP et proxy de confiance doivent être configurés explicitement.
- Le contrôleur Better Auth doit recevoir le corps brut : ne pas activer le parseur JSON sur `/api/auth`. Ouvrir directement ses routes organization contournerait la façade de workspace.
- Retirer `APP_GUARD` ouvrirait les futures routes ; ajouter `@Public()` doit être un choix explicite. Cette exception ne dispense jamais les endpoints Better Auth de leurs propres vérifications.
- Les quotas sont partagés par les personnes derrière une même IP : connexion 5/minute, inscription 3/10 minutes, renvoi 3/5 minutes. Un mauvais réglage des proxys peut regrouper tous les visiteurs dans un seul quota. Les autres routes Better Auth gardent la règle par défaut de 100/minute par IP et route.
- Retirer la transformation TypeScript du build casse les métadonnées Nest. `pnpm check` et le hook pre-push exécutent maintenant une preuve compilée pour le détecter.
- Les commandes `dev` et `start` utilisent les mêmes ports : en lancer une seule. Les ports Node restent internes ; l'origine utilisateur est celle de Caddy.
- Le worker est connecté à pg-boss, mais ne traite encore aucun job métier. Le front liste les workspaces ; les pages, l'éditeur, les invitations et les facteurs forts ne sont pas encore disponibles. Aucun utilisateur réel avant la fin de la session 3.

## Comment tester manuellement

1. Suivre le [démarrage du README](../../README.md#infrastructure-locale) : Compose, certificat, migrations, `pnpm dev`. Pour tester le build : arrêter dev, puis `pnpm build` et `pnpm start`.
2. Ouvrir `https://localhost`. Créer un compte de test avec un mot de passe d'au moins 12 caractères.
3. Essayer de se connecter avant d'ouvrir le lien : l'interface doit demander de vérifier l'adresse.
4. Ouvrir `http://localhost:8025`, lire l'email et suivre son lien. Revenir à la connexion ; elle doit maintenant réussir. Le lien est valable une heure ; un lien expiré peut être remplacé via « Renvoyer un email de vérification ».
5. Créer un workspace avec un identifiant comme `mon-studio-test`. Il apparaît dans la liste avec le rôle propriétaire. Recharger la page : il reste présent. Réutiliser cet identifiant : un message de conflit apparaît.
6. Se déconnecter : la liste n'est plus accessible. Un autre compte vérifié doit voir uniquement ses propres workspaces.
7. Sans connexion, ouvrir `https://localhost/api/internal/workspaces` : 401. Les sondes `https://localhost/api/health` et `https://localhost/api/health/worker` restent publiques. `pnpm test:auth:e2e` ajoute aussi une route uniquement dans le module de test et prouve qu'elle reste fermée sans aucune annotation.
8. Depuis une IP dont le quota est disponible, saisir six fois un mot de passe incorrect en moins d'une minute : le sixième appel renvoie 429 et l'écran affiche « Trop de tentatives ». Patienter au moins une minute après la dernière tentative admise, puis réessayer. Ne pas multiplier les inscriptions pour tester la limite : le test isolé couvre ce cas sans envoyer d'email.
9. Exécuter `pnpm test:e2e` dans un autre terminal. Les comptes/emails de cette commande sont automatiquement nettoyés ; vos essais manuels sont conservés. Attendre dix minutes entre deux parcours Caddy rapprochés (deux inscriptions par passage). `pnpm test:auth:e2e` utilise ses propres compteurs et peut être relancé immédiatement.

## Contrôles de livraison

- `pnpm check` : lint/format, types des 10 packages, preuve Nest compilée, 33 tests réussis et 6 tests PostgreSQL ignorés comme prévu. Le schéma métier n'a pas changé.
- Complément du 23 octobre : `pnpm test:auth:e2e` vérifie cinq scénarios (six tests avec le groupe), dont la route nouvelle fermée par défaut et le débit de connexion avec reprise après expiration. Le test vérifie aussi les limites et délais d'inscription/renvoi, ainsi que le remplacement du header IP interne fourni par le client. Le front traite les réponses 429 même sans code métier.
- Après ces corrections, `pnpm check`, `pnpm build` et les deux suites de `pnpm test:e2e` passent sur les exécutables compilés. Le message de limitation a aussi été vérifié dans le navigateur en HTTPS, avec un identifiant fictif et sans créer de compte.
- `pnpm build` puis `pnpm start` : les trois applications démarrent ; les 8 scénarios HTTP passent (9 tests en comptant leur groupe).
- `pnpm dev` : démarrage vérifié et mêmes scénarios HTTP réussis. Modifier une source partagée reconstruit et redémarre l'API sans boucle sur les fichiers générés.
- Validation du certificat TLS active dans les tests, y compris lors de l'ouverture des liens email sans header Origin.
- Parcours visuel validé le 23 octobre 2026 dans le navigateur intégré, en HTTPS après import de l'autorité Caddy par l'utilisateur et redémarrage du navigateur : inscription, refus de connexion avant vérification, ouverture du lien Mailpit, connexion, création du workspace avec le rôle propriétaire, persistance après rechargement, message d'identifiant déjà utilisé et déconnexion avec retour obligatoire à la connexion. Aucun problème visuel ni erreur JavaScript observé pendant ce parcours. Les données de cet essai ont été nettoyées.
- Après fermeture complète de Codex, relancer `pnpm dev` si les processus ont été arrêtés : Caddy peut rester disponible alors que les applications ne le sont plus et répondre `502`.

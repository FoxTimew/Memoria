# Relecture — session 1, socle exécutable et connexion simple

Branche : `codex/session-1-bootstrap-auth`, depuis le cadrage fusionné dans `main`.

## Fichiers à lire en priorité

1. [ADR 014](../adr/014-build-serveur-typescript-source.md) et [preuve de bootstrap](../../apps/api/src/bootstrap-probe.ts) : le risque Nest/décorateurs/packages TypeScript a été testé en premier, puis enregistré dans un premier commit isolé.
2. [Configuration Better Auth](../../packages/auth/src/create-auth.ts) et [entrée API](../../apps/api/src/main.ts) : vérification d'email, cookies, origine et routes réellement ouvertes. Aucun facteur fort actif.
3. [Service de workspaces](../../apps/api/src/modules/workspaces/workspaces.service.ts) : propriétaire déterminé par le serveur, transaction commune au plugin et à nos tables, collisions de nom et liste filtrée.
4. [Tests HTTP](../../scripts/test-session1.mjs) : les garanties sont vérifiées sur PostgreSQL et Mailpit réels, à travers Caddy en HTTPS.
5. [Écrans de connexion](../../apps/web/src/components/auth-screen.tsx), [liste des workspaces](../../apps/web/src/app/page.tsx) et [worker](../../apps/worker/src/main.ts).

## Ce qui pourrait casser

- Un certificat Caddy non approuvé bloque le navigateur. Le certificat public `.local-root.crt` doit être installé dans les autorités de confiance du compte local ; ne pas désactiver TLS.
- PostgreSQL doit être démarré et les migrations appliquées. Une mauvaise configuration SMTP empêche l'envoi du lien ; le formulaire permet de le renvoyer. En production, SMTP et proxy de confiance doivent être configurés explicitement.
- Le handler Better Auth doit rester avant le parseur JSON. Ouvrir directement ses routes organization contournerait la façade de workspace.
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
7. Vérifier les sondes `https://localhost/api/health` et `https://localhost/api/health/worker`, puis exécuter `pnpm test:e2e` dans un autre terminal. Les comptes/emails de cette commande sont automatiquement nettoyés ; vos essais manuels sont conservés.

## Contrôles de livraison

- `pnpm check` : lint/format, types des 10 packages, preuve Nest compilée, 31 tests réussis et 6 tests PostgreSQL ignorés comme prévu. Le schéma métier n'a pas changé.
- `pnpm build` puis `pnpm start` : les trois applications démarrent ; les 8 scénarios HTTP passent (9 tests en comptant leur groupe).
- `pnpm dev` : démarrage vérifié et mêmes scénarios HTTP réussis. Modifier une source partagée reconstruit et redémarre l'API sans boucle sur les fichiers générés.
- Validation du certificat TLS active dans les tests, y compris lors de l'ouverture des liens email sans header Origin.
- Parcours visuel navigateur non validé à ce stade : le navigateur intégré signale `ERR_CERT_AUTHORITY_INVALID`. L'approbation du certificat local requiert une intervention humaine ; elle a été demandée. Aucun contournement de l'alerte n'a été effectué.

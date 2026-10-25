# Session 4 — parcours manuel consolidé, environ 30 minutes

Utiliser des comptes de test, jamais un compte contenant du travail irremplaçable. Préparer Android avec une application TOTP, Windows Hello et la YubiKey avec PIN/UV, un navigateur habituel et une fenêtre privée. Ne joindre aucune capture de QR, clé, code ou lien de récupération à un rapport public. Les essais automatiques ne remplacent pas ce parcours matériel.

## Avant le chronomètre

Sur `codex/session-4-strong-auth` : `pnpm install --frozen-lockfile`, `pnpm infra:up`, `pnpm db:migrate`, `pnpm build`, puis les services avec `pnpm start` (arrêter les anciens processus Memoria avant de démarrer les nouveaux). Aucune réinitialisation de données. Ouvrir `https://localhost` avec la CA Caddy approuvée et Mailpit à `http://localhost:8025`. Garder API, collab, web et worker actifs. Les benchmarks, distincts de ce guide, exigent secteur et RAM suffisante.

Préparer un compte B vérifié, sans facteur, dans la fenêtre privée. Le parcours principal utilise un **nouveau compte A**, propriétaire. Pour ajouter B au workspace créé plus bas, la méthode de développement reste : `pnpm dev:collab add-member --workspace UUID --email adresse-de-test-B`. Les invitations visuelles arrivent en session 5 ; ne pas manipuler directement les délais de grâce des comptes réels.

## 0–5 min — inscription et email

1. Inscrire A depuis l'interface avec un mot de passe d'au moins douze caractères. Avant vérification, tenter de revenir aux espaces : accès refusé avec demande de vérifier l'adresse.
2. Ouvrir l'email A dans Mailpit et suivre le lien. Se connecter, créer « Relecture session 4 », puis une page « Essai ». Saisir une phrase et attendre « Enregistré sur le serveur ».
3. Ajouter B avec la commande ci-dessus. Depuis la fenêtre privée B, ouvrir la même page ; vérifier lecture et édition avant l'obligation de facteur.

## 5–10 min — TOTP Android et codes de secours

4. Dans A → **Sécurité du compte**, confirmer le mot de passe et configurer l'application de codes. Scanner le QR sur Android ; la clé manuelle reste disponible en secours. Le QR est produit par le navigateur, aucun service externe ne doit s'ouvrir.
5. Saisir un mauvais code puis le bon. Conserver les dix codes de secours **hors de ce navigateur**, puis confirmer leur conservation. Le QR disparaît. Ajouter le facteur ne suffit pas : l'écran demande encore de vérifier son identité.
6. Attendre le prochain code Android puis le vérifier. Revenir à la page : elle est accessible. Réutiliser immédiatement ce même code doit être refusé comme déjà utilisé si une nouvelle vérification est demandée. Ne pas multiplier les erreurs : les défis et délais sont réels.

## 10–15 min — Windows Hello et YubiKey

7. Avec une preuve récente, ajouter une passkey « Hello relecture » ; choisir Windows Hello et valider PIN/biométrie. Après l'enrôlement, vérifier explicitement avec cette passkey avant de retourner aux pages.
8. Ajouter « YubiKey relecture » et choisir la clé physique. Valider le PIN/contrôle utilisateur demandé. Un simple toucher sans vérification utilisateur ne suffit pas au protocole ; si la clé est incompatible UV, le refus est attendu, ne désactiver aucune option de sécurité.
9. Renommer une passkey, actualiser et vérifier le nom. Se déconnecter puis tester une connexion directe avec Windows Hello, et une seconde connexion avec la YubiKey. Chacune doit ouvrir les espaces après le contrôle utilisateur, sans mot de passe supplémentaire. Au login par mot de passe, le second facteur reste demandé.

## 15–20 min — politique workspace et connexions ouvertes

10. Dans A → **Sécurité de l'espace**, activer l'obligation avec **zéro jour** pour ce workspace de test. B garde sa page ouverte : sa connexion doit être coupée sous cinq secondes sur cette machine disponible. Recharger ou accéder directement à la page ne contourne pas la demande de facteur. A continue à accéder au contenu.
11. Vérifier qu'A ne peut pas se retirer comme dernier propriétaire. Depuis B, les commandes de gestion restent indisponibles/refusées. Ouvrir la politique dans deux onglets A, changer un réglage dans le premier puis enregistrer l'ancien état dans le second : conflit, actualisation nécessaire.
12. Pour contrôler la fraîcheur sans rallonger les trente minutes, **ne pas refaire de preuve depuis l'étape 9** et revenir à l'action sensible après les étapes suivantes : au-delà de dix minutes, elle doit demander une nouvelle vérification, même si la lecture des pages fonctionne encore. Les tests serveur couvrent aussi le délai et l'attente d'un verrou sans attente humaine.

## 20–26 min — récupération sans contourner les facteurs

13. Depuis Connexion → **Mot de passe ou facteur perdu ?**, demander un reset pour A. Comparer avec une adresse inconnue : même message public. Suivre le lien Mailpit : après ouverture, l'URL devient `/recuperation` sans jeton visible. Choisir un nouveau mot de passe. Les anciennes connexions A doivent perdre leur accès ; le nouveau mot de passe **ne dispense pas** de Hello, YubiKey ou TOTP. Le même lien soumis à nouveau est refusé.
14. Tester ensuite **J'ai perdu mon facteur : utiliser un code de secours**, avec A, son nouveau mot de passe et un code conservé. Vérifier que cette session ne peut pas ouvrir les pages, même en saisissant leur URL.
15. Dans ce parcours limité, remplacer seulement le facteur TOTP de test : retirer l'ancienne application, scanner un nouveau QR Android et vérifier le premier code. Garder Hello et YubiKey. **Terminer la récupération**, conserver le nouveau jeu de dix codes, puis effectuer la vérification forte distincte demandée. Les pages redeviennent accessibles. L'ancien code utilisé ne doit plus fonctionner.

## 26–30 min — poste partagé, cache et nettoyage

16. Dans une connexion ordinaire A, ouvrir la page dans deux onglets et attendre « Copie locale à jour ». DevTools → Application → IndexedDB → `memoria-yjs-cache-v1`, version 2 : noter la présence de `documents` et `updates`, sans exporter leur contenu.
17. Depuis la politique workspace, décocher **Autoriser les copies locales…**. Annuler une première fois pour vérifier la confirmation, puis enregistrer. Les onglets actifs affichent la désactivation et le contenu local de cet espace disparaît. Le texte ouvert reste en mémoire ; réautoriser la politique nécessite de rouvrir la page pour refaire une copie. S'il manque une preuve récente, revenir à la sécurité et la vérifier : cela couvre aussi l'étape 12.
18. Se déconnecter, cocher **Poste partagé** au prochain login A et accepter l'effacement après synchronisation. Terminer le second facteur. La page fonctionne mais aucune copie persistante ne doit être créée. Passer brièvement hors ligne et saisir une phrase : avertissement que fermer l'onglet perdrait ce travail ; reconnecter et attendre l'enregistrement.
19. Confirmer la déconnexion, réveiller l'autre onglet : aucun contenu ne doit réapparaître dans IndexedDB. Des tombstones techniques peuvent rester ; ils empêchent un ancien onglet de réécrire. Si un message de nettoyage échoué apparaît, le poste **n'est pas déclaré nettoyé** : fermer les onglets et effacer les données du site avant de le partager.

## Essais facultatifs séparés

La commande opérateur nécessite une vérification d'identité en personne/visio et, si possible, un second membre du studio. Suivre la [procédure d'hébergement](../self-hosting.md#récupération-4c--procédure-opérateur), simulation d'abord, sur un compte jetable. Ne jamais envoyer mot de passe/code/jeton à l'opérateur. Le test de reset ciblé puis total et la vérification de l'audit dépassent les trente minutes de ce parcours.

Pour approfondir les onglets figés, la fermeture hors ligne et les autres comptes, suivre la [fiche 4e](session-4-4e-cache.md). Les scénarios cinquante comptes/NAT et trente secondes d'attente sont automatisés dans `pnpm test:auth:limits` ; ne pas supprimer des compteurs pour accélérer le test manuel. Les décisions de merge sont séparées du succès de ce guide : relire la [matrice des risques](session-4-4f-matrice.md).

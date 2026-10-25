# Session 4c — récupération et commande opérateur

Livraison sur `codex/session-4-strong-auth`, après validation manuelle de 4b. Pas de PR intermédiaire : le développeur créera et fusionnera la PR unique après 4f. Description intermédiaire conservée dans `.local/session-4c-pr.md` avec celles de 4a/4b. 4d n'est pas commencée.

## Ce qui change

« Mot de passe ou facteur perdu ? » mène au reset par email ou aux codes de secours. Changer le mot de passe ferme les anciennes connexions mais garde les facteurs. Un code de secours exige encore le mot de passe et ouvre quinze minutes pour remplacer le facteur perdu ; les pages restent fermées. Terminer remplace les dix codes, puis demande une nouvelle vérification forte. L'exploitant dispose d'une commande ciblée avec simulation, confirmation et audit, sans accès normal de secours.

Le worker traite désormais une file d'emails chiffrée et persistante. Le navigateur ne reçoit jamais de réponse révélant l'existence d'un compte lors d'une demande de reset, et n'attend pas SMTP. Le lien reçu disparaît de la barre d'adresse au chargement ; son jeton n'est pas envoyé dans l'URL HTTP.

Les deux ajouts demandés sont dans ARCHITECTURE.md : comparaison alternée candidate/main sur secteur en 4f, plafonds absolus et marge de 10 % ; en session 5, arrivée d'un membre invité directement vers l'enrôlement quand le workspace l'impose.

## À lire en priorité

1. [ADR 004](../adr/004-connexion-forte.md#4c--récupération-exécutée) : transitions, durée limitée, facteur en attente et absence de contournement par mot de passe.
2. [recovery-plugin.ts](../../packages/auth/src/recovery-plugin.ts), [security-plugin.ts](../../packages/auth/src/security-plugin.ts), [recovery-core.ts](../../packages/auth/src/recovery-core.ts) : consommation atomique, révocation, facteur en attente, fin et commande opérateur.
3. [create-auth.ts](../../packages/auth/src/create-auth.ts), [mail-jobs.ts](../../packages/auth/src/mail-jobs.ts), [worker](../../apps/worker/src/main.ts) : reset natif, jeton haché, file chiffrée, SMTP après réponse publique.
4. [0012](../../packages/db/drizzle/0012_recovery_boundary.sql) et [schéma](../../packages/db/src/schema/auth.ts) : interdiction de contenu pendant récupération et expiration non prolongeable. Migrations 0011/0013 générées par Drizzle.
5. [tests réels](../../apps/api/src/recovery.e2e.ts), [test navigateur](../../scripts/test-auth-recovery-browser.mjs) et [guide opérateur](../self-hosting.md#récupération-4c--procédure-opérateur).

## Preuves et limites

Les journaux complets sont versionnés dans `evidence/session-4c-*.txt`, avec commande/résumé et `EXIT_CODE=0`. Les comptes/schémas des tests serveur sont isolés ; le navigateur utilise un compte aléatoire supprimé ensuite. Les scénarios Nest passent par le handler HTTP réel, PostgreSQL et les primitives cryptographiques installées ; le test opérateur lance aussi le vrai exécutable enfant. Les comptes de test ne contournent aucune limite de production : les scénarios serveur utilisent des IP de fixture distinctes pour isoler les règles métier.

Résultats : `pnpm check`, **108 tests Vitest réussis**, six SQL ignorés dans cette commande puis **six réussis séparément** ; build des quatre applications ; récupération **douze scénarios, treize tests avec le parent** ; régressions facteurs **14**, workspace **13**, auth **6**, pages **8**, transport collaboratif **13**, révocations **1** ; navigateur HTTPS 4c **un parcours complet réussi**, sans erreur de page. Les parcours navigateur complets 4a/4b ne sont pas rejoués dans cette livraison ; leurs suites serveur le sont et la nouvelle UI de récupération réutilise l'enrôlement/vérification passkey.

| Sujet                    | Prouvé                                                                                                                                                                                                                             | Ce qui n'est pas prouvé ici                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reset email              | Réponse identique connu/inconnu/non vérifié ; aucune livraison SMTP dans la requête ; identifiant haché et 30 min ; faible/expiré/rejoué refusés, double consommation unique ; panne audit annule aussi mot de passe/jeton/session | SMTP de production, statistiques de timing sous attaque distribuée ; quotas destinataire et compte en 4d                                          |
| Révocation               | Reset HTTP, code HTTP et commande opérateur ferment chacun une vraie socket en moins de 5 s ; anciennes assurances supprimées, facteurs et politiques conservés selon la cible                                                     | Délai sous saturation ; effacement immédiat d'un navigateur hors ligne impossible                                                                 |
| Codes et session limitée | Mot de passe obligatoire ; concurrence unique ; API et WS refusés même sans politique ; actions sensibles refusées ; durée non prolongeable, expiration et logout ; reset pendant récupération ne rouvre pas le contenu            | Matrice multi-onglets/cache/politique complète en 4e/4f                                                                                           |
| Rétablissement           | Passkey et TOTP réels, facteurs en attente interdits avant fin même en anonyme/après logout ; nouveau jeu, anciens codes invalides, nouvelle preuve obligatoire ; attribut poste partagé transféré                                 | Nouveaux essais matériels par le développeur ; le test serveur WebAuthn utilise des signatures P-256 et le navigateur un authentificateur virtuel |
| Opérateur                | Exécutable simulation et application ciblée, cible absente/UUID/confirmation/motif refusés, facteur restant conservé ; all explicite, audit, rollback, grant expiré/réémis, concurrence unique, mot de passe seul refusé           | Procédure humaine d'identité, permissions du système d'exploitation ; navigateur du parcours opérateur à relire manuellement                      |
| Emails et URL            | Worker réel → SMTP Mailpit → écran ; no-referrer, fragment retiré, jeton absent des URL réseau ; retries/abandon simulant une panne de transport mais vraie file SQL                                                               | Arrêt brutal exactement après livraison SMTP ; la livraison est au moins une fois, donc doublon possible                                          |
| Régressions              | Suites 4a/4b/auth/pages/SQL, transport et révocations, build et pnpm check                                                                                                                                                         | Performance comparative non mesurée ici : campagne alternée obligatoire en 4f sur secteur                                                         |

Pendant les tests, le renouvellement automatique de Better Auth prolongeait la session limitée ; le trigger empêche maintenant toute extension, y compris après rotation TOTP. Le test conserve ce cas. Un facteur ajouté pendant récupération pouvait autrement permettre une connexion anonyme avant la fin : la liste persistante `recoveryPendingFactors` le refuse, même après suppression de la session limitée. Le build du vrai exécutable a également révélé l'absence de `pg` dans les dépendances d'exécution du worker ; il est désormais déclaré à la même version que l'API.

Restent obligatoires avant merge : quotas NAT/compte/destinataire 4d, politique de cache 4e, revue adverse et performance 4f. Les limitations d'email restent provisoirement IP : 3 demandes/300 s, 5 consommations/300 s par route, en plus du global existant. Pas d'acceptation implicite de ces limites pour la production. Audit de sécurité : cible de rétention 90 jours, purge générale ultérieure ; aucun mot de passe, code, jeton ou URI dans l'audit. Ne pas écrire de données personnelles du titulaire dans les motifs opérateur.

## Ce qui pourrait casser

- Oublier de redémarrer le worker laisse les emails dans la file ; la sonde ne garantit pas SMTP. Vérifier aussi ses journaux et un message reçu. Six essais ou expiration suppriment le payload : réparer puis redemander/réémettre.
- Une mauvaise origine ou un secret différent entre API et worker empêche la livraison. Sauvegarder BETTER_AUTH_SECRET hors serveur : il chiffre TOTP et les emails en attente.
- Réinitialiser le mot de passe après une commande opérateur invalide le lien opérateur. Faire le reset de mot de passe d'abord, puis la commande.
- Fermer/recharger la page de reset après retrait du fragment perd le jeton en mémoire : rouvrir le lien d'email. Un lien déjà utilisé ne fonctionne plus.
- Des onglets hors ligne peuvent encore contenir du texte local ; le reset distant ne peut pas nettoyer immédiatement leur disque. La politique de cache de 4e reste à livrer.

## Guide manuel

### Préparation

Depuis la racine, `pnpm install --frozen-lockfile`, `pnpm db:migrate`, `pnpm build`, puis démarrer/redémarrer web, API, collab et worker avec le même `.env`. Les migrations ajoutent les tables/champs sans reset de données. Caddy/Mailpit/PostgreSQL doivent tourner. Le worker peut être lancé séparément avec `node --env-file=.env apps/worker/dist/main.mjs`. Utiliser `https://localhost` avec le certificat déjà approuvé et Mailpit sur `http://localhost:8025`.

Créer un compte de test vérifié, lui configurer un facteur et conserver ses dix codes. Ouvrir une page du même compte dans une seconde fenêtre et vérifier qu'elle est connectée. Ne pas utiliser votre seul compte propriétaire pour les essais destructifs de facteurs.

### Mot de passe oublié

1. Sur Connexion ou Sécurité du compte, choisir « Mot de passe ou facteur perdu ? », saisir l'adresse et envoyer. Faire aussi une demande avec une adresse inexistante : même texte public, aucun email pour cette adresse.
2. Dans Mailpit, ouvrir le lien « Changer votre mot de passe ». L'adresse devient `/recuperation` sans jeton. Choisir un nouveau mot de passe d'au moins douze caractères.
3. La seconde fenêtre perd sa connexion collaborative et ses anciens accès. Se reconnecter avec le nouveau mot de passe : le facteur configuré reste demandé. L'ancien mot de passe ne fonctionne plus.
4. Rouvrir le même lien : il est refusé à la soumission. Le scénario d'expiration de trente minutes est automatisé dans `pnpm test:auth:recovery` (sans attendre réellement trente minutes).

### Facteur perdu

1. Depuis Récupération, choisir « J'ai perdu mon facteur : utiliser un code de secours ». Fournir adresse, mot de passe actuel et un des codes conservés. Un mauvais code ou mot de passe ne doit rien modifier.
2. L'écran explique les quinze minutes. Les pages et les autres connexions restent fermées. Retirer uniquement le facteur perdu via les boutons dédiés.
3. Ajouter une nouvelle passkey ou une nouvelle application de codes (QR local ou clé manuelle, puis premier code). Cliquer « Terminer la récupération » : dix nouveaux codes apparaissent. Les anciens sont tous invalides.
4. Conserver les nouveaux codes, puis vérifier explicitement la nouvelle passkey ou le prochain code TOTP. C'est seulement alors que « Mes espaces » ouvre les pages. Retenter l'ancien code dans une autre fenêtre : refus.
5. Pour vérifier la limite sans manipulation SQL, démarrer une autre récupération, attendre plus de quinze minutes puis tenter une action : reconnexion/récupération nécessaire. Le test automatique couvre l'expiration et les tentatives de prolongation sans attente réelle.

### Commande opérateur

1. Suivre le [guide d'auto-hébergement](../self-hosting.md#récupération-4c--procédure-opérateur) sur ce compte de test, équipé de deux facteurs. Simuler : compte, cible et facteurs affichés, aucune déconnexion.
2. Appliquer avec le bon UUID de confirmation et une cible précise. Vérifier la fermeture de la seconde fenêtre, le maintien de l'autre facteur et l'email « Rétablir vos facteurs ». Ouvrir le lien, saisir adresse et mot de passe : même parcours limité, sans accès immédiat aux pages.
3. Tester séparément `all` explicite ; après le reset, mot de passe seul ne permet ni accès ni enrôlement libre. Utiliser le lien, terminer avec un nouveau facteur, puis vérifier son identité. La politique du workspace demeure active.
4. Consulter l'audit par la requête du guide : compte, cible, opérateur, motif, date ; aucun secret. L'absence de confirmation et une cible absente doivent refuser sans modifier le compte.

Tests reproductibles : `pnpm check`, `pnpm build`, `pnpm test:auth:recovery` (schéma jetable), puis `pnpm test:auth:recovery:browser` (pile locale complète). Les quotas IP de développement restent actifs : espacer les répétitions qui créent des comptes plutôt que supprimer leurs compteurs.

# Session 5a — moteur de droits et preuve des frontières

Livraison du 25 octobre 2026, sur `codex/session-5-guests-sharing`, après le cadrage `b1d3bf2`. **À relire ; 5b non commencée.** ADR 018 et 019 acceptés, valeurs retenues sans modification. Les deux précisions produit sont intégrées : retour guidé vers l’enrôlement pour les mutations d’accès en 5b, et propriétés de lignes modifiables par un guest edit sans modification du schéma en session 6.

## Ce qui fonctionne

L’API et le service collaboratif consultent le même moteur SQL : session, compte vérifié, assurance/récupération, politique du workspace, rôle, page et ancêtres vivants, puis maximum des partages. Owner/admin/member accèdent au contenu du workspace. Un guest ne voit que ses pages et leurs descendants, avec lecture ou édition selon les grants. L’édition permet contenu, titre et sous-pages ; elle ne permet pas de déplacer, archiver ou restaurer.

Les résultats de recherche sont filtrés avant la limite de cent résultats. Les réponses invité masquent les parents illisibles et remplacent les rangs globaux par un ordre de vue ; aucune corbeille n’est exposée. L’ouverture collaborative et les commandes du writer utilisent les mêmes droits. Une signature HMAC valide n’accorde pas le droit d’écrire.

Les révocations se sérialisent avec les écritures. Après attente du verrou, une nouvelle instruction SQL relit les droits : un changement edit→read déjà committé empêche l’écriture. Notification PostgreSQL et contrôle périodique ferment les connexions concernées ; l’essai sans notification reste inférieur à cinq secondes. Une promotion guest retire ses grants avec une entrée d’audit agrégée, pour empêcher leur réactivation à la rétrogradation.

## Fichiers à lire en priorité

1. [Migration 0017](../../packages/db/drizzle/0017_inherited_page_access.sql) : décision unique, héritage, verrous, notifications, nettoyage lors d’une promotion.
2. [Adaptateur partagé](../../packages/db/src/access.ts), [contexte API](../../apps/api/src/modules/pages/content-access.ts) et [pages](../../apps/api/src/modules/pages/pages.service.ts) : application du résultat et absence de métadonnées masquées.
3. [BlockWriteService](../../apps/api/src/modules/blocks/block-write.service.ts) et [serveur collaboratif](../../apps/collab/src/service/server.ts) : précontrôle HTTP, contrôle interne et refus des messages read introduisant du contenu.
4. [Attaques exécutables](../../apps/api/src/sharing.e2e.ts), [matrice de frontières et quotas](session-5-5a-frontieres.md) : lire les assertions sur les effets SQL/Yjs, pas seulement les statuts HTTP.
5. [Admission des pages](../../apps/api/src/modules/pages/content-quota.ts) et [guard global](../../apps/api/src/modules/auth/auth.guard.ts) : quotas IP avant authentification, compte ensuite, gabarits de route canoniques.

## Contrôles et preuves

Les journaux complets sont versionnés, avec commande, résultat final et code de sortie. Les comptes, memberships et grants de la preuve sont des fixtures dans des schémas PostgreSQL temporaires. Les cookies viennent de Better Auth réel ; API Nest, Hocuspocus, HMAC, journal, projection et WebSockets sont réels. Ce n’est pas encore une preuve d’invitation par email.

| Contrôle                                                                                              | Résultat                                                                             | Journal                                                        |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `pnpm test:sharing:e2e`                                                                               | 13 scénarios et leur test parent : 14 réussis, aucun ignoré                          | [Frontières](evidence/session-5a-boundaries.txt)               |
| `pnpm test:db`                                                                                        | 6 tests SQL réussis                                                                  | [SQL](evidence/session-5a-sql.txt)                             |
| Pages, politique/assurance, guard/authentification                                                    | 8 + 13 + 6 tests réussis                                                             | [Régression API](evidence/session-5a-regression-api.txt)       |
| Collaboration : access-security, journal, transport, revocations, HMAC, frontend, admission, présence | 20 + 3 + 13 + 1 + 1 + 1 + 1 + 1 tests réussis                                        | [Régression collab](evidence/session-5a-regression-collab.txt) |
| `pnpm check`                                                                                          | Lint/format, 12 packages typés, bootstrap Nest ; 117 tests Vitest réussis, 6 ignorés | [Contrôle complet](evidence/session-5a-check.txt)              |

Les six tests ignorés par `pnpm check` nécessitent une base dédiée ; ils passent séparément avec `pnpm test:db`. Aucun résultat tronqué n’est utilisé comme preuve.

Les comptes Node ci-dessus incluent les tests parents lorsque la suite en déclare. Les messages `READ_ONLY`/`ACCESS_DENIED` et fermetures de sockets dans le journal sont attendus par les attaques. Le test L01 constate l’absence de trois canaris dans l’état Yjs envoyé au lecteur, dont un contenu supprimé avant la création des grants ; il ne constitue pas une garantie générale sur tout historique Yjs.

## Ce qui pourrait casser et ce qui reste à prouver

- **Migration obligatoire avant redémarrage des applications** : le nouveau code appelle `content_resolve_access`, absent avant 0017. La preuve migre depuis zéro dans un schéma temporaire ; aucun reset des données du développeur n’est effectué.
- **Verrous conservateurs** : les mutations relationnelles/de droits verrouillent toutes les pages du workspace en ordre stable, sous mutex de workspace. Cela simplifie la preuve des descendants et cascades, mais peut augmenter leur attente quand plusieurs pages sont actives. L’append Yjs reste verrouillé par page seulement. Pas de mesure de charge ou de latence déduite de cette preuve ; comparaison alternée et profils guest en 5d.
- **Déplacement suspendu dans un workspace partagé** : `409 SHARING_PREVIEW_REQUIRED` dès qu’un grant actif existe, même si la page déplacée n’est pas concernée. C’est la fermeture provisoire du chemin avant l’aperçu de 5c. La restauration annonce ses effets dans l’interface en 5c ; ses droits hérités sont déjà recalculés côté serveur.
- **Interface invité fermée jusqu’à 5c** : le composant n’ouvre pas l’éditeur guest. Aucun parcours d’invitation, UI read-only, purge du cache liée à une perte de partage, ou test navigateur guest n’est déclaré livré. La gestion admin des membres et du cache reste en 5b/5c ; les anciennes façades demeurent restrictives en attendant.
- **Audit de promotion** : le trigger inscrit un événement technique avec membership et nombre de grants retirés, sans adresse email ni acteur supposé. L’audit de la façade attribuera la mutation à l’acteur authentifié en 5b. Retirer une membership supprime ses grants ; la réinvitation HTTP reste à tester avec 5b.
- **R12 continue** : le tableau des absences de la matrice doit être repris en 5b–5d. Les risques et prérequis de session 4 restent inchangés. Cette livraison ne qualifie ni cinquante comptes ni les plafonds de grants sous charge.

## Guide manuel — environ dix minutes

Cette étape est une preuve serveur avant interface. Ne pas créer de guests à la main dans la base habituelle pour contourner le parcours futur.

1. Ouvrir un terminal à la racine du dépôt, sur cette branche. PostgreSQL doit être accessible avec le `.env` de développement ; si nécessaire, démarrer l’infrastructure avec `pnpm infra:up`.
2. Lancer `pnpm test:sharing:e2e`. Il crée ses comptes et ses serveurs sur ports temporaires, applique les migrations dans son propre schéma, puis supprime ce schéma. Il ne dépend ni des applications de développement déjà lancées ni de Mailpit. C’est un test fonctionnel, pas une mesure de performance.
3. Lire les scénarios A01/A02 : l’invité voit la racine partagée et son enfant, jamais le parent caché ; les 105 résultats interdits ne remplissent pas la première page de recherche.
4. Lire R12 et A01/A04 : douze routes refusent les anonymes ; read ne modifie rien ; edit renomme et crée un enfant, conserve le 409 sur titre périmé et ne gère pas l’arbre.
5. Lire C01/L01 : un lecteur voit la saisie en direct et la fiche personnage ; trois messages Yjs hostiles et une commande HMAC correctement signée ne changent ni journal, ni projection, ni audit/outbox. Les autres connexions restent ouvertes.
6. Lire les deux courses A03 : écriture HTTP puis véritable update WebSocket suspendues pendant une rétrogradation ; après commit, elles sont refusées. C02 retire le partage d’un ancêtre, supprime volontairement sa notification et attend la fermeture sous cinq secondes.
7. Lire Q01 : rotation d’UUID, de route, d’IP et d’en-têtes, puis variante HEAD/query/trailing slash ; les limites reviennent en 429 avec `Retry-After`, un autre compte reste admis. Vérifier le résumé **14 tests, 14 pass, 0 fail**, puis `$LASTEXITCODE` égal à zéro.
8. Relire la matrice et les limites ci-dessus avant de valider 5a. Le test visuel à deux navigateurs et les écrans d’invitation feront partie des guides 5b/5c.

Description intermédiaire conservée dans `.local/session-5a-pr.md` pour la future PR unique. Création et fusion restent au développeur. Le compte rendu joint le hash après push normal et comparaison directe avec la branche distante.

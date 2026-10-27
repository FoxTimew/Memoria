# ADR 008 — Valeurs typées et vue tableau

Statut : accepté — 2026-10-26. Tous les choix du cadrage, y compris les bornes secondaires, quotas, versions, erreurs et le protocole de verrous, sont retenus. La preuve 6a reste bloquante avant toute interface.

**Décision.** Définitions/choix de propriétés normalisés ; une table scalaire typée et trois tables de liens pour multi-select, personne et relation. Une ligne est une page dans une seule base. JSONB reste réservé aux blocs et aux configurations validées de vues/propriétés.

**Alternatives.** Un JSONB de toutes les valeurs sur la ligne ; une table physique PostgreSQL par base utilisateur ; EAV de chaînes sans types.

**Raison.** JSONB faciliterait les premiers formulaires, mais les tris numériques et de dates exigeraient casts et index d'expression par propriété. Les valeurs typées offrent des index B-tree `(workspace, propriété, valeur, page)` communs à toutes les bases et des FK pour les choix/personnes/relations. Le coût de jointures est acceptable pour une vue tableau de studios de 5–50 personnes.

**Conséquences.** Les FK incluent workspace, base, propriété et type : un nombre ne peut pas être écrit dans une propriété texte. Nombres PostgreSQL `numeric(28,8)` transportés en chaînes pour préserver la précision. Dates civiles séparées des instants avec fuseau ; plages ordonnées. Les choix ont des IDs stables, indépendants des libellés. Absence de valeur = cellule vide ; false reste différent d'une checkbox vide. Personnes = memberships du même workspace. Relations N:N vers les lignes d'une base cible du même workspace ; pas de relation inverse écrite automatiquement.

La suppression de propriété masque ses valeurs et les purge après rétention. Changer le type ou la base cible d'une propriété peuplée est refusé au MVP ; une future conversion explicite sera transactionnelle. Les filtres sont une AST Zod bornée compilée en SQL paramétré, jamais des fragments SQL clients. Tris avec tie-breaker UUID, NULLS LAST ; chaque requête filtre aussi les pages/propriétés archivées et les autorisations. La vue stocke colonnes, filtres, tris et largeurs en JSONB, avec `type=table` ; autres vues exclues.

## Session 6 — périmètre et bornes retenus

**Engagements conservés :** texte, nombre, select, multi-select, date, checkbox, personne, relation et URL. Une ligne appartient à une seule base, possède un titre et son propre document Yjs. Une relation cible plusieurs lignes d'une base fixée du même workspace. La page conteneur d'une base compte parmi les 1 000 pages ordinaires ; ses lignes sont exclues de cette borne et de l'arbre latéral. Le tableau est paginé et ne charge aucun document Yjs de ligne : celui-ci est chargé seulement à son ouverture, avec les limites et le budget collaboratifs existants.

**Réponse du 26 octobre :** toutes les lignes héritent des droits de la base ; ni partage individuel de ligne ni sous-pages sous une ligne. Guest edit peut créer une ligne et modifier titre, cellules et corps, sans modifier le schéma ni archiver/restaurer. Les règles de confidentialité et de verrouillage sont détaillées dans l'[ADR 020](020-droits-et-concurrence-des-bases.md). Décision : pas de déplacement de ligne entre bases, conversion page/ligne ou import en session 6. Le conteneur reste déplaçable avec aperçu des effets d'accès.

Bornes **retenues le 26 octobre**, configurables ; augmenter une borne ne vaut pas qualification du nouveau volume :

| Ressource                                              | Borne                          |
| ------------------------------------------------------ | ------------------------------ |
| Bases par workspace                                    | 50, parmi les pages ordinaires |
| Lignes par base / workspace                            | 10 000 / 50 000                |
| Propriétés par base                                    | 50, hors titre obligatoire     |
| Options par propriété select ou multi-select           | 100                            |
| Valeurs par cellule relation / multi-select / personne | 50 / 20 / 20                   |
| Pagination                                             | 50 par défaut, maximum 100     |
| Vue enregistrée / tris / prédicats de filtre           | 1 / 2 / 10                     |

Les éléments en corbeille comptent jusqu'à purge ; l'archivage ne contourne pas les bornes. Bornes complémentaires retenues : texte de cellule limité à 2 000 caractères Unicode, URL à 2 048, nom de propriété/option à 80 ; liste assignable au plus égale aux 100 memberships du workspace. Compteurs contrôlés atomiquement sous transaction, sans COUNT puis INSERT non protégé. Pas de purge définitive nouvelle dans cette session ; l'archivage de propriété masque les valeurs en attendant la rétention générale.

| Type                  | Contrat de valeur retenu                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Texte                 | Texte brut sans HTML, chaîne vide normalisée en absence ; espaces significatifs conservés                                                                              |
| Nombre                | Chaîne décimale exacte `numeric(28,8)`, zéro distinct du vide ; excès de décimales rejeté sans arrondi ; ni NaN ni infini                                              |
| Select / multi-select | IDs stables d'options de cette propriété ; ensemble sans doublons ; pas de création de choix à la volée par guest                                                      |
| Date                  | Mode fixé par propriété : date civile ISO ou instant ISO avec fuseau IANA ; début et fin optionnelle, fin ≥ début ; changement de mode traité comme changement de type |
| Checkbox              | `true`, `false` ou absence, trois états distincts                                                                                                                      |
| Personne              | Ensemble de memberships du workspace, visibilité ADR 020, aucun email                                                                                                  |
| Relation              | Ensemble de lignes de la base cible ; auto-relation et cycles permis sans parcours récursif ni inverse automatique                                                     |
| URL                   | URL absolue HTTP(S) sans identifiants intégrés, rendu échappé ; aucune récupération/prévisualisation serveur, lien avec protections de navigation                      |

Une option archivée disparaît du sélecteur et reste indiquée comme archivée dans une cellule existante, retirable mais non assignable. Renommer conserve l'ID. Une propriété peuplée, y compris par des valeurs archivées, ne change ni type, ni mode de date, ni base cible. Les tables Drizzle présentes ne prouvent pas ces règles métier ; contraintes complémentaires, services et tests restent à construire.

## Concurrence par cellule — décision

Ajouter une version durable par `(workspace, base, ligne, propriété)`, commune aux valeurs scalaires et ensembles de liens. Une cellule jamais écrite vaut version 0. La première mutation crée sa version sous contrainte d'unicité ; un concurrent attend puis relit. Vider la cellule conserve cette version (tombstone) : une ancienne version 0 ne peut pas la ressusciter. Numéros transportés en chaînes décimales, sans arrondi JavaScript.

Chaque mutation porte `expectedCellVersion`, `expectedSchemaVersion` et une opération typée. Sous les barrières d'accès/cycle de vie de l'ADR 020, verrouiller seulement cette cellule, comparer, valider, modifier valeurs/liens et augmenter sa version dans la même transaction. Ancienne version : **409 CELL_VERSION_CONFLICT**, valeur/version courantes seulement si l'acteur reste autorisé ; une perte d'accès prime et ne renvoie aucune valeur. Deux cellules distinctes de la même ligne aboutissent sans conflit de version. Deux écritures de la même cellule, même sur deux éléments différents d'un multi-select, exigent une résolution explicite ; aucun écrasement automatique.

Le schéma a sa version (définitions, options et vue commune), avec CAS et droit owner/admin/member. Version périmée : `409 SCHEMA_VERSION_CONFLICT` avant conversion/effacement. Titre et cycle de vie conservent la version de page et leurs 409 ; le corps garde `contentRevision` Yjs. Modifier une cellule n'incrémente pas la version du titre, n'écrit ni dans Yjs ni dans les blocs. Toute écriture de corps hors éditeur reste dans `BlockWriteService`.

Le client valide une cellule par Entrée, choix ou sortie de focus, pas à chaque touche. Saisie en cours conservée en mémoire, jamais écrasée par rafraîchissement. Un conflit présente la valeur distante accessible et propose une relecture/reprise, sans retry écrasant. Hors ligne, cellules/schéma non enregistrables et avertissement avant fermeture ; seul le corps garde le cache Yjs existant. Pas de cache persistant de propriétés. Réponse perdue : relire version/valeur avant toute nouvelle mutation. Création de ligne idempotente par clé acteur/base, rétention retenue de 24 h.

Rafraîchissement retenu du tableau : toutes les cinq secondes lorsque la vue est visible, au retour du focus et après une mutation confirmée, avec suspension/backoff en cas de quota ou erreur. Comparer les versions sans écraser une cellule en cours de saisie. Les propriétés ne bénéficient pas de fusion Yjs ou de curseurs par cellule ; le corps conserve sa collaboration temps réel. La création initialise atomiquement page/ligne, valeurs initiales, génération/document vide et outbox, via les services communs ; seule la réplique de validation est chargée paresseusement.

## Tableau et requêtes

**Retenu le 26 octobre :** une vue enregistrée par base, deux tris et dix filtres réunis par **ET**, sans OU imbriqué. Tri ascendant/descendant sur titre, texte, nombre, date, checkbox, select et URL ; multi-select/personne/relation filtrables mais non triables. Owner/admin/member modifient la vue commune sous version ; guest ajuste son affichage pour la visite sans l'enregistrer dans la vue commune. Pas de vues privées, formule, rollup, agrégat ou jointure transitive. Le titre reste disponible pour ouvrir la ligne.

Opérateurs **retenus** :

| Type                             | Filtres                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Titre, texte, URL                | égal, contient, commence par ; insensibles à la casse, accents conservés ; `%`, `_` et échappements sont littéraux       |
| Nombre                           | égal, différent, inférieur/supérieur strict ou inclusif, entre bornes inclusives                                         |
| Date                             | début égal, avant, après, début entre bornes ; même mode civil/instant que la propriété ; pas de chevauchement de plages |
| Checkbox                         | vrai, faux ; absence distincte                                                                                           |
| Select                           | parmi au plus 20 options                                                                                                 |
| Multi-select, personne, relation | contient au moins une des valeurs accessibles indiquées, au plus 20                                                      |
| Tous                             | vide/non vide ; pour personne/relation : sans/avec valeur **accessible**, jamais test des valeurs masquées               |

Ordre retenu : texte normalisé en casse avec collation PostgreSQL `C` (accents conservés), valeur numérique exacte, début de date, booléen ou libellé d'option ; NULLS LAST dans les deux sens puis UUID de ligne stable. Option archivée : libellé/clé de tri stables, indication d'archivage. Aucun titre de relation inaccessible n'est résolu pour trier.

Pagination par curseur signé contenant clés de tri et UUID, lié à acteur, base/workspace, filtres, tri, version de schéma et époque d'accès. Revérifier les droits à chaque appel ; ce curseur ne les accorde pas. Retourner `hasMore`, pas de total masqué/global. Les modifications concurrentes peuvent déplacer une ligne entre pages de résultats : dédupliquer par ID et proposer Actualiser, sans promettre un snapshot de navigation. Changement de droits/schéma : recommencer à la première page. L'ordre déterministe et le coût des lignes sautées motivent le curseur plutôt qu'un OFFSET croissant ([PostgreSQL 17](https://www.postgresql.org/docs/17/queries-limit.html)).

AST Zod bornée vers SQL paramétré et identifiants/opérateurs de liste fermée. Autorisation avant LIMIT/extrait. Mesurer `EXPLAIN (ANALYZE, BUFFERS)` avec deux tris, cellules absentes, filtre peu sélectif et « contient » : les index actuels ne prouvent pas ces coûts. Une vue enregistrée avec un filtre personne/relation devenu inaccessible utilise une vue neutre et « Certains réglages ne sont pas disponibles » ; aucune transmission du filtre masqué, aucun résultat dépendant de lui.

## Recherche et événements — décision

La recherche couvre titre et propriétés texte actives des lignes avec les mêmes droits que tableau/API/writer/WSS ; le corps déjà recherchable conserve sa projection. Ne pas indexer les noms de personnes ou titres de relations dans la ligne source. Résultat : titre/extrait autorisés et base accessible, sans parent caché ni ajout à l'arbre. Nombres, options et URLs restent filtrables dans le tableau, sans extension implicite du texte intégral.

Actualiser titre et texte relationnels dans la transaction de mutation pour lecture de ses propres écritures. Séparer ces colonnes du texte projeté Yjs, pour qu'un projecteur en retard n'écrase pas des propriétés récentes. La projection du corps reste asynchrone. Toute recherche relit les droits courants.

La création inscrit `database.row.created` une seule fois dans l'outbox avec ligne/valeurs initiales. Les changements suivants marquent durablement une ligne sale ; regroupement après 1 s d'inactivité, au plus 5 s d'activité continue, en `database.row.updated`. Titre, propriétés et projection du corps alimentent **un même agrégateur par ligne** ; pas de double `page.updated` pour ce corps. Audit de contenu agrégé par auteur/ligne/fenêtre ; schéma et accès gardent leur audit propre immédiat. Ni événement par frappe, ni fenêtre uniquement en mémoire.

Payload retenu : IDs workspace/base/ligne, numéro monotone d'événement, révision des propriétés et `contentRevision` projetée. Aucune valeur, email ou titre lié. Numéro d'événement distinct des versions CAS. Une mutation arrivée pendant le traitement reste sale pour la fenêtre suivante ; insertion outbox et avancement atomiques, reprise idempotente. La révision des propriétés utilise un incrément SQL bref commun à la ligne, sans CAS client : mesurer sa contention. HTTP cellule répond après commit valeur/index/marque durable, sans attendre outbox ; le writer de corps attend sa projection. Livraison externe/webhooks en session 9.

Archivage/restauration de ligne produit un changement d'état dans cet agrégat ; schéma/propriété archivée actualise la recherche sans événement par valeur. Les liens vers une ligne archivée restent conservés et masqués jusqu'à la purge selon rétention. Adapter le retrait d'un membership référencé pour éviter une cascade massive dans sa transaction d'accès (ADR 020).

## Preuves à apporter

Le [cadrage de session 6](../reviews/session-6-etape-1-cadrage.md) décrit routes, quotas, étapes et mesures. Ces contrats ne sont pas des résultats de tests. 6a prouve d'abord cellule 0 concurrente, vide/recréation, cellules indépendantes, Yjs simultané, recontrôle au commit, rollback et bornes concurrentes avant l'interface.

## État de la preuve 6a, 26 octobre

Le noyau `DatabaseCells` applique désormais CAS de cellule et schéma, validation des neuf types, droits/recontrôle, archivage/restauration, références masquées et marque de révision durable dans PostgreSQL. Dix-neuf tests d’intégration couvrent notamment version zéro, tombstones, valeurs/version cohérentes, ensembles, cibles révoquées pendant l’attente, options archivées, définitions peuplées et rollback. Deux comptes éditent aussi réellement le même corps via WSS dans le banc de cellules. La [fiche finale](../reviews/session-6-6a-finale.md) clôt la preuve 6a : version durcie, trois séries conformes, p95 médians scalaire 25,08 ms et ensemble 27,65 ms (<100 ms), reçu WSS 19,08 ms.

Ce noyau n’est pas une livraison des routes CRUD, du compilateur AST, des curseurs signés, de la recherche ou du worker outbox : ils restent en 6b. Après les refus mémoire conservés, le protocole Windows/WSL a été révisé par le développeur le 26 octobre. Le banc SQL du tableau passe huit cas à 10 000 lignes / 50 propriétés, trois séries chacun : pire p95 médian 158,18 ms (<200 ms). Les 27 séries tableau/cellules sont sans swap, avec relevés versionnés. Les futures façades restent à qualifier ; pas de performance HTTP ou de charge à cinquante comptes déduite de cette preuve.

## Mise en œuvre 6b, 27 octobre

Le [dossier 6b](../reviews/session-6-6b-services.md) expose maintenant les routes internes, leurs quotas et attaques. `database_counters` compte les objets physiques, corbeille comprise, via triggers ; le service vérifie les limites de déploiement après l'incrément verrouillé et avant commit. `database_create_receipts` garde pendant 24 h un reçu lié à l'acteur/base/hash de demande ; replay après recontrôle des droits, jamais après perte d'accès. Valeurs initiales, compteur, document Yjs et `database.row.created` forment une transaction unique.

`database_row_search` sépare `relational_text` et `body_text` sous un même vecteur PostgreSQL. Le projecteur et les cellules acquièrent la marque de révision avant l'index pour éviter une inversion de verrous. `database_row_changes` et `database_row_authors` conservent la fenêtre et les auteurs ; le worker poll séparément de SMTP. Une projection du corps encore en attente retarde l'événement jusqu'à reprise ; le journal et les réponses de cellule restent disponibles. La projection déjà regroupée ne rajoute pas une seconde fenêtre. Les événements ne contiennent que les IDs, révisions et l'état archivé. Une panne après insertion outbox ou un processus tué avant commit ne consomme pas la fenêtre : preuve PostgreSQL réelle, puis retry et mutation pendant flush.

Le contrôle bloquant demandé dès l'ouverture de la route `POST …/query` est passé sur les huit cas via compiler/guard/admission/quotas réels. Les plans et résultats sont comparés aux requêtes fermées de 6a, à droits égaux. La [fiche tableau](../reviews/session-6-6b-tableau.md) conserve le premier contrôle ; la [fiche finale de sous-étape](../reviews/session-6-6b-services.md) donne la remesure complète. Il ne s'agit pas encore de la qualification à cinquante comptes ni de la comparaison alternée prévue en 6d.

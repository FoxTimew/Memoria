# ADR 016 — Pages, adaptateurs BlockNote et sauvegarde atomique

Statut : accepté — 2026-10-23. Session 2 ; précise les ADR 006, 007 et 011.

## Risque vérifié en premier

Les tests `packages/blocks/catalog/src/roundtrip.test.ts` instancient **BlockNote 0.56.0 et son vrai document ProseMirror**, sans simuler leur sérialisation. Les huit modèles standard et character-card passent modèle → éditeur → modèle → rechargement. UUID, parents, ordre des frères, liens, styles, Unicode, sauts de ligne, code, image et blocs vides sont contrôlés, y compris tous les types comme enfants imbriqués. Un second scénario change le type d'un bloc et déplace un bloc en conservant son identité. Aucun problème de fond n'a été constaté sur ce périmètre.

ProseMirror regroupe les segments adjacents de même style et retire les segments vides : le modèle normalise cette représentation. Cette normalisation préserve le texte et son style, et évite les fausses modifications. Les positions restent des rangs serveur ; l'adaptateur reconstruit `parentId/afterId`, pas des rangs arbitraires. Les tests portent sur l'ordre et les identités, pas sur une numérotation inventée par le client. Voir [structure du document BlockNote](https://www.blocknotejs.org/docs/foundations/document-structure) et [schémas personnalisés](https://www.blocknotejs.org/docs/features/custom-schemas).

Le package `block-standard` regroupe huit modèles, exporte `/model` et `/ui` et conserve la séparation serveur/client. `BlockEditorModule` garde le transport des props et ajoute les fonctions optionnelles `toEditorContent/fromEditorContent` pour le texte riche ou brut. Le catalogue client construit un schéma concret avant de créer l'éditeur. Une adaptation de type locale contourne le typage optionnel `isToggleable` de BlockNote avec `exactOptionalPropertyTypes` ; aucune option toggle n'est activée. Le contrôle du graphe serveur et le build Nest refusent toujours React et BlockNote.

Les styles proposés sont bold, italic, underline, strike et code ; titres 1–3 ; liens HTTP(S). La liste numérotée conserve son départ explicite (`start`) ; null laisse le moteur poursuivre la numérotation. Le test inclut un départ à 7. Les couleurs, alignements et types non pris en charge ne sont pas supprimés silencieusement lors de la conversion inverse. Une page contenant un type inconnu ou une version future reste consultable sous forme de données préservées, avec l'édition désactivée. L'image stocke `fileId`, alt, caption et width ; sa représentation actuelle est un emplacement éditable. Upload, URL de lecture et affichage du fichier restent en session 6. Une référence non nulle doit déjà désigner un fichier prêt du même workspace.

## Écriture et autorisations

Routes de session : `/api/internal/workspaces/:workspaceId/pages`, lecture de document et de version, `PUT` du batch, `POST` move/archive/restore, puis recherche. Toutes sont protégées par le guard global. Le service reconstruit le contexte depuis le membership et l'acteur ; seuls **owner et member** sont autorisés. Invités, admins et partages ne deviennent pas actifs implicitement. Une absence d'accès est rendue comme 404, sans révéler de contenu.

Le verrou advisory de workspace est pris avant de lire les droits ou l'arbre : exclusif en écriture, partagé en lecture. Ce choix simple sérialise les écritures d'un même workspace ; il faudra mesurer sa contention avant de spécialiser les verrous. Les lecteurs attendent la fin d'un batch et lisent une version cohérente. Les futurs changements de droits devront suivre le même protocole.

`BlockWriteService` est l'unique propriétaire des INSERT/UPDATE/DELETE de blocs, y compris son entrée de purge réservée au futur worker. Le service prépare et valide le batch en mémoire : types/versions, parents, cycles, profondeur, ordre et fichiers. Puis un CAS de page arbitre la version attendue. Blocs, titre, références de fichiers, recherche, audit et outbox sont écrits dans la même transaction. Un échec annule tout. Les événements enregistrés ne sont pas encore livrés : relais et webhooks restent en session 8. Les rangs des lignes modifiées sont libérés temporairement dans la transaction avant réécriture dans l'ordre des parents ; cela autorise les permutations et inversions de parent sans collision SQL transitoire.

Les opérations restent des changements ciblés ; le serveur ne remplace pas le document entier. `update.type` permet la conversion paragraphe/titre sous le même UUID. `restore.withDescendants` vaut implicitement vrai ; l'undo du navigateur utilise faux et restaure explicitement les blocs concernés, sans faire réapparaître d'autres tombstones. Une restauration récursive conserve les suppressions plus anciennes. Un batch sans changement effectif ne crée pas de version ni d'événement.

Archiver une page masque ses descendants, sans écraser leurs dates de suppression propres. La version de chaque page affectée est incrémentée ; leurs projections disparaissent de la recherche. La restauration vérifie le parent, recalcule un rang libre et réindexe les pages visibles. Une page ne se déplace jamais sous son descendant. Les bases et leurs règles spécifiques ne sont pas encore exposées.

## Sauvegarde et limites

Le front attend 900 ms après la dernière modification, n'envoie qu'une sauvegarde à la fois et capture le brouillon envoyé. Une saisie survenue pendant l'envoi reste en attente après l'accusé de réception. La version est vérifiée toutes les 15 secondes lorsque l'onglet est visible, au focus/retour de visibilité et avant sauvegarde ; le CAS serveur demeure indispensable contre la course entre vérification et écriture. Un conflit 409 suspend les sauvegardes, conserve le brouillon et propose son export JSON ou un rechargement explicitement destructif pour ce brouillon. Aucune fusion automatique.

Le brouillon est **en mémoire**, avec protection de sortie et confirmation de navigation entre pages lorsqu'il n'est pas enregistré. Il ne survit pas à un crash de navigateur ; l'export contient aussi le document éditeur brut si la conversion échoue. Le mode hors ligne persistant et la restauration depuis un export ne sont pas livrés dans cette session.

Bornes de cette tranche : 1 000 pages par workspace, corbeille incluse ; 500 blocs vivants par page ; 50 niveaux d'imbrication ; 1 500 opérations par sauvegarde interne (jusqu'à insertion/restauration, modification et placement par bloc) ; corps JSON métier de 1 Mo, dans Caddy et Express. Le contrat de batch public reste borné à 500 opérations. Authentification : limite Caddy de 64 Ko conservée. Les limites de taille ne remplacent pas les validateurs de chaque modèle. Les tombstones de blocs seront purgés avec la rétention en session 8.

Recherche PostgreSQL synchrone via `plainto_tsquery('simple')`, index GIN et extraits en texte brut, limités à 100 résultats. Les mêmes règles owner/member et de visibilité s'appliquent à l'arbre, au document, à la version et à la recherche. Pas de recherche floue ni de streaming de l'arbre au MVP de cette tranche.

## Vérification

`pnpm check` couvre les conversions réelles, la frontière UI, les bornes de rang/profondeur, la restauration ciblée et les courses de sauvegarde. `pnpm test:pages:e2e` démarre Nest compilé sur un port loopback éphémère avec PostgreSQL réel : comptes/sessions, droits, version concurrente, rollback, cycles, changement de type, restauration, recherche et révocation. Les adresses documentaires des compteurs sont isolées, les fixtures exactes nettoyées, sans reset de base. `pnpm test:e2e` inclut cette suite, les tests d'authentification et le parcours Caddy/Mailpit de session 1. Le parcours navigateur HTTPS vérifie le comportement de l'éditeur monté, distinct du test moteur sans DOM.

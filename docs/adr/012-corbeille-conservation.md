# ADR 012 — Corbeille, purge et suppression de compte

Statut : accepté — 2026-10-22.

**Décision.** `created_by`, `updated_by`, dates et `deleted_at` sur le contenu métier mutable. Acteurs stables par workspace. Exceptions : authentification et memberships gérés par Better Auth, acteurs d'audit, projections dérivées, outbox/livraisons/audit/idempotence et tables pg-boss ont un cycle propre, sans soft delete artificiel.

**Alternatives.** Suppression définitive immédiate ; soft delete sur absolument toutes les tables ; conservation illimitée.

**Raison.** Restaurer un document ne doit pas restaurer un token révoqué. Les logs et secrets doivent avoir une fin de vie explicite.

**Conséquences.** Archiver une page masque tout son sous-arbre sans modifier les dates de suppression précédentes des descendants ; restauration des seuls éléments encore présents et non précédemment supprimés. Purge physique après 30 jours configurables, avec traitement récursif et ordre des FK. Avant suppression d'une ligne cible, nettoyer les relations entrantes ; appeler le writer pour les blocs, supprimer les projections, puis pages. Les suppressions S3 sont reprises sur erreur ; ne pas effacer la ligne de fichier avant confirmation de suppression objet. Orphelins/pending expirés : 24 h par défaut. Suppression workspace suit le même orchestrateur, pas un simple DELETE CASCADE qui oublierait S3.

Suppression de compte : bloquer si dernier owner sans transfert ; révoquer sessions et clés émises, vider leurs références membership, supprimer invitations liées et facteurs/credentials/profil. Effacer les liens de personne vers ce membre. Anonymiser les acteurs (`user_id=NULL`, kind anonymized), retirer `actor_id` des journaux concernés et les identifiants de compte dans toute métadonnée autorisée. Les contributions communes restent propriété du workspace, sans nom/email d'auteur. Ne pas copier de PII dans les logs ; les contenus libres signalés comme contenant des données personnelles nécessitent une suppression ciblée dans le contenu partagé. La procédure n'est pas implémentée dans cette session.

Rétentions configurables : corbeille 30 j ; événements publiés et matérialisés 30 j ; livraisons et tentatives terminales 30 j ; audit 90 j ; idempotence 24 h ; jobs terminés 7 j ; IP/user-agent de sessions jusqu'à expiration/révocation. Purger tentatives → livraisons → événements ; jamais un événement non publié, non matérialisé ou encore référencé par une livraison active. Alertes si accumulation. Sauvegardes chiffrées, rotation 30 j par défaut ; en restauration, rejouer les suppressions intervenues depuis le snapshot avant remise en ligne. Les délais effectifs et exceptions opérationnelles sont affichés à l'exploitant.

## Précision de calendrier et proposition fichiers — 28 octobre 2026

La session 7 précède la **Liste pré-pilote**, puis le studio pilote ; API publique et webhooks sont reportés après ses retours. Les obligations de purge, anonymisation et sauvegarde de cet ADR restent **avant tout utilisateur réel**, pilote compris. Le report des webhooks ne reporte pas les jobs de rétention du contenu, des audits, des événements ou du journal Yjs.

L'[ADR 022](022-droits-et-cycle-de-vie-des-fichiers.md) propose de distinguer le fichier jamais attaché/abandonné (nettoyage à 24 h après expiration) du dernier usage retiré d'un fichier déjà attaché (corbeille 30 j). Une référence dans une page/ligne/propriété archivée retient l'objet pour restauration sans l'autoriser à la lecture. Compteurs, état deleting et recontrôle sous verrou empêchent GC/attache concurrents ; libération du quota après suppression S3 confirmée, dérivés et multipart inclus. Les objectifs de sauvegarde proposés RPO ≤24 h/RTO ≤4 h restent à valider et mesurer, avec manifeste commun PostgreSQL/objets, restauration isolée et suppressions rejouées avant ouverture. Aucun de ces mécanismes n'est livré par le cadrage.

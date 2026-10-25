# Session 5 — guide consolidé à deux navigateurs

Environ trente minutes. Utiliser uniquement les comptes/données de test. Ce parcours complète les attaques automatisées ; il ne qualifie pas une mise en production.

## Préparer — 3 minutes

1. Mettre à jour la branche, appliquer les migrations jusqu'à **0020**, compiler/redémarrer la pile derrière Caddy. Synchroniser/exporter les travaux de test puis fermer les anciens onglets avant la mise à jour. Aucun reset de base nécessaire.
2. Navigateur A : connecter un owner et vérifier son identité depuis Sécurité avec le facteur de son choix. Navigateur B, ou fenêtre privée distincte : utiliser une autre adresse pour le futur invité. Mailpit est disponible en développement ; le lien reste copiable dans la gestion des invitations.
3. Dans A, créer `Interne`, sa sous-page `Projet partagé`, une sous-page `Tâches` sous le projet, et deux racines `Autre dossier` et `Travail indépendant`. Ajouter texte et fiche personnage à `Tâches`. Le parent `Interne` ne sera pas partagé.

## Invitation et arrivée forte — 6 minutes

4. Si souhaité, activer l'obligation de connexion forte dans les paramètres du workspace. Inviter B comme **Invité**, avec `Projet partagé` en **Lecture**. Vérifier la pagination/liste et le lien copiable. Avec un owner/admin de test sans facteur, la même action doit guider vers l'enrôlement puis la preuve et revenir au formulaire ; elle ne doit pas envoyer l'invitation automatiquement.
5. Dans B, créer le compte, vérifier son email, se connecter et accepter le lien. Si le workspace exige une connexion forte : message explicatif, configuration puis vérification du facteur avant tout document. L'enrôlement seul ne doit pas ouvrir le contenu. Tester un lien avec le mauvais compte : refus sans affichage du studio.
6. Pour un autre lien de test, utiliser Renvoyer dans A : l'ancien lien devient inutilisable. Annuler le nouveau : aucun accès ne doit apparaître. Un GET ou une prévisualisation du lien ne vaut pas acceptation.

## Lecture, édition et frontières — 6 minutes

7. Dans B, seuls le projet et ses descendants apparaissent. Le parent `Interne` n'apparaît ni dans l'arbre ni dans le fil d'Ariane. Chercher `Interne` et `Autre dossier` : aucun résultat.
8. Ouvrir `Tâches` : explication de lecture seule ; essayer titre, texte, fiche et sous-page, tous non modifiables. Dans A, modifier texte et fiche : B reçoit les changements et voit la présence.
9. Passer le partage du projet en **Édition**. B doit rouvrir une copie fraîche ; changer titre, texte, fiche et créer une sous-page. Le déplacement, l'archivage et la gestion des accès restent absents. Ajouter un direct Lecture sur `Tâches` : l'Édition héritée reste prioritaire ; supprimer ce direct ne réduit pas l'accès.

## Invalidation ciblée et déplacement — 6 minutes

10. Garder `Travail indépendant` ouvert dans un second onglet A. Dans B, garder `Tâches` ouverte. Attendre « Copie locale à jour ». Dans A, archiver une nouvelle page sans rapport : les deux documents restent ouverts. Pour observer le cache, outils développeur → Application → IndexedDB `memoria-yjs-cache-v1`, store `updates` : les enregistrements des pages inchangées ne disparaissent pas.
11. Déplacer `Projet partagé` sous `Autre dossier`. Son grant direct suit la page ; l'aperçu ne doit annoncer aucune perte pour B. Confirmer : B reste connecté et son éditeur/cache restent en place. Le parent non partagé demeure invisible.
12. Déplacer `Tâches` hors du projet, sans grant direct sur Tâches : l'aperçu annonce la perte héritée pour B et ses descendants. Annuler une fois, puis refaire/confirmer. B est arrêté et la branche disparaît ; `Travail indépendant` dans A reste ouvert. Remettre la page sous le projet : l'aperçu annonce le gain et B peut la rouvrir.
13. Ouvrir un aperçu, modifier un partage dans un autre onglet A, puis confirmer l'ancien aperçu : refus, nouvelle vérification nécessaire. Après un déplacement effectué ailleurs, une ancienne version relationnelle peut aussi provoquer ce refus : relire la page puis demander un nouvel aperçu. Le contenu collaboratif reste ouvert. Archiver/restaurer une page partagée : seuls ses accès/descendants sont affectés, restauration avec aperçu.

## Cache hors ligne et retrait — 6 minutes

14. B ouvre `Tâches` en édition et attend la copie locale. Dans les outils développeur Réseau, passer hors ligne ; vérifier le statut avant d'écrire `BROUILLON HORS LIGNE`. Mettre l'onglet en arrière-plan. Dans A, réduire le projet à Lecture, puis réaccorder Édition.
15. Revenir dans B et rétablir le réseau : le vieux document ne doit pas se renvoyer automatiquement. Exporter le travail local proposé, retrouver la phrase dans le JSON, puis rouvrir la page fraîche : la phrase ne doit pas avoir été enregistrée sur le serveur. Les tests automatisés ajoutent un gel réel avec et sans autre onglet invité éveillé ; un simple arrière-plan manuel n'en est pas la preuve.
16. Retirer le partage dans A : la page disparaît de B ; ses copies affectées sont supprimées. Pour vérifier le ciblage entre deux pages du même invité, partager aussi une seconde racine, l'ouvrir dans un autre onglet B et attendre la copie locale avant retrait de la première : la seconde reste ouverte et son cache conservé.
17. Déconnecter B : toutes ses copies disparaissent, les anciens onglets restent fermés. Reconnexion avec **Poste partagé** : aucune persistance du contenu Yjs. Tester aussi l'interdiction du cache dans le workspace : la saisie peut rester en mémoire, sans nouveau cache persistant. Les marqueurs sans contenu empêchant les onglets retardataires ne sont pas supprimés.

## Relire — 3 minutes

18. Gestion des membres : vérifier qu'un admin gère member/guest et le cache, mais ne nomme pas un admin/owner et ne change pas l'obligation MFA. Une promotion guest→member efface les anciens grants ; revenir à guest demande des racines explicites. Retirer puis réinviter ne réactive pas les anciens partages. Le dernier owner ne peut pas être retiré.
19. Lire les chiffres de performance, la matrice d'attaques et les recommandations de risques dans la [fiche 5d](session-5-5d-revue-adverse.md). Consigner les observations d'interface et les décisions de risque avant création/fusion de la PR unique.

Le travail exporté n'est pas contrôlable à distance. Un appareil entièrement déconnecté ne peut recevoir une révocation ; la barrière est la vérification en ligne avant reprise. La qualification R09/R11/R13/R14 et la finition de l'interface restent des étapes distinctes avant les premiers utilisateurs réels.

# Session 6 — guide consolidé à deux navigateurs

Environ 30 minutes, après migrations et démarrage de la pile locale. Utiliser des données de test. Ouvrir un navigateur avec un owner et une fenêtre privée avec un second compte. L'owner doit pouvoir vérifier son identité avec son facteur pour les mutations de partage. Le guide ne remplace pas les mesures de charge ni les attaques automatisées.

## Préparation et schéma — 5 minutes

1. Dans le workspace du premier compte, créer une base « Tâches ». Ajouter : texte « Notes », nombre « Charge », select « Statut » (À faire, En cours, Terminé), multi-select « Étiquettes », date « Échéance », checkbox « Vérifié », personne « Responsables », URL « Lien » et relation « Dépendances ».
2. Créer une seconde base « Références internes » et une ligne « Budget confidentiel ». Choisir cette base comme cible de Dépendances. Créer dans Tâches la ligne « Livrer le décor » et lui affecter la référence confidentielle. Choisir un responsable interne, qui n'est pas dans la liste assignable aux invités de Tâches.
3. Inviter le second compte comme guest, lui partager Tâches en lecture. S'il n'a pas de facteur et que le workspace l'impose, suivre le parcours guidé avant d'accéder au contenu. La base Références internes reste non partagée.

## Lecture seule et frontières — 4 minutes

4. Dans la fenêtre privée, ouvrir Tâches. Le message de lecture seule explique l'absence d'édition. Les commandes de schéma et de corbeille sont absentes. La référence confidentielle et le responsable caché donnent une mention neutre, sans titre ni nombre.
5. Ouvrir Livrer le décor : titre et corps ne sont pas modifiables. Les lignes ne se sont pas ajoutées à l'arborescence latérale. Une recherche du titre confidentiel ne le retourne pas ; celle d'une ligne autorisée ouvre sa route native.

## Prestataire en édition — 6 minutes

6. L'owner passe le partage en édition après vérification d'identité si demandée. Recharger la fenêtre privée. Le guest met le Statut sur Terminé : vérifier le changement depuis le premier navigateur. C'est le cas d'usage de référence.
7. Essayer les autres types : texte, zéro puis vide pour Charge, faux puis vrai pour Vérifié, plusieurs étiquettes, date ou période, URL HTTPS. Les valeurs sont enregistrées cellule par cellule. Le guest peut créer une ligne et modifier son titre/corps, mais ne peut pas gérer le schéma ni archiver une ligne.
8. Dans Responsables, le guest ne voit que les personnes explicitement assignables et lui-même, sans emails ni annuaire. Ajouter son nom sans effacer l'affectation masquée. Ouvrir Dépendances : la cible confidentielle n'est pas sélectionnable. Enregistrer sans nouveau choix ; l'owner constate que la relation cachée existe toujours.
9. Si souhaité, partager Références internes en lecture : la cible devient visible après rafraîchissement ; retirer ce partage et constater le retour à la mention neutre.

## Concurrence, navigation et recherche — 6 minutes

10. Les deux comptes ouvrent l'édition de Notes. Enregistrer une valeur côté owner, puis une valeur différente côté guest. Le guest reçoit le message de conflit et voit la valeur actuelle ; sa saisie reste disponible. Choisir explicitement de la réappliquer, puis vérifier le résultat.
11. Modifier deux cellules différentes de la même ligne depuis les deux comptes : les deux changements passent sans conflit de ligne. Pendant ce temps, ouvrir le corps de la ligne dans les deux navigateurs et écrire dans chacun ; le contenu converge et les cellules restent indépendantes.
12. Tester deux tris, des filtres simples combinés par ET et leur effacement. Le guest change son affichage sans modifier la vue commune. Avec plus de dix lignes, choisir dix lignes par page, avancer puis revenir. Une modification concurrente peut déplacer une ligne entre pages : la pagination n'est pas un instantané figé.
13. Rechercher un mot placé dans Notes puis dans le corps collaboratif. Le texte relationnel est recherchable dès son enregistrement ; le corps suit la projection asynchrone. Une ligne inaccessible ne doit pas apparaître.

## Cache, révocation et cycle de vie — 6 minutes

14. Garder un autre onglet du guest ouvert sur une ligne d'une autre base autorisée. Sur Livrer le décor, simuler une coupure réseau via les outils du navigateur. Modifier le **corps** et attendre l'indication de copie locale ; fermer l'onglet, rétablir le réseau et le rouvrir. Le texte réapparaît et rejoint l'autre navigateur après vérification des droits. Les cellules relationnelles ne sont pas enregistrées hors ligne dans IndexedDB.
15. Refaire une modification hors ligne, garder l'onglet suspendu ou fermé, puis retirer le partage Tâches côté owner. Au retour en ligne, l'ancien corps ne doit pas être renvoyé. Réattribuer Tâches en lecture et rouvrir : le corps serveur apparaît, sans la modification interdite. L'autre base et son cache restent accessibles.
16. Pendant que le guest écrit dans une ligne de Tâches, déplacer puis archiver/restaurer une page ordinaire sans lien avec cette base : la ligne doit rester ouverte et ses écritures enregistrées. Archiver ensuite la ligne côté owner, vérifier sa disparition et la fermeture de son édition, puis la restaurer depuis la corbeille de la base. Restaurer aussi une option retirée. Le panneau de restauration des **colonnes** est prévu dans la finition de l'interface ; il n'est pas livré ici.
17. Côté owner, ouvrir « Sécurité de l'espace », décocher « Autoriser les copies locales… », enregistrer et confirmer. Les onglets actifs du guest annoncent que la copie locale est désactivée ; un onglet retardataire doit appliquer l'interdiction au réveil, sans recréer l'ancien cache. Le contenu serveur reste accessible en ligne. Réautoriser ensuite les copies et recharger pour créer une copie neuve.
18. Déconnecter le guest dans un onglet puis réveiller l'autre : la session reste fermée et les copies locales de cet utilisateur sont effacées. Un navigateur entièrement hors ligne ne reçoit pas instantanément une révocation : le contrôle au retour doit empêcher toute reprise des anciennes écritures. Les marqueurs techniques de déconnexion peuvent rester ; ils protègent contre les onglets retardataires.

## À signaler

Noter le rôle, la route ouverte, le message et l'ordre des actions en cas d'écart. Ne pas joindre de cookies, secrets de facteur ou liens de récupération. Les captures/exportations faites avant retrait restent hors du contrôle du serveur. Les vérifications automatiques et les limites restantes figurent dans la fiche 6d ; aucun risque résiduel n'est accepté par ce guide.

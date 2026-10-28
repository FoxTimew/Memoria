# Session 6c — guide à deux navigateurs

Prévoir environ 25 minutes avec des données de test. Utiliser `https://localhost`, migration 0027 de 6b et API/web/collab/worker démarrés. Aucune nouvelle migration ni remise à zéro. A : owner avec facteur et preuve récente ; B : second compte vérifié, guest (fenêtre privée ou autre navigateur). Un navigateur privé peut refuser la persistance : utiliser un second profil normal pour la fermeture/réouverture si nécessaire.

## Préparer le tableau — A

1. Dans le workspace, **Nouvelle base**, nom « Tâches ». Son lien « Tâches — tableau » ouvre la vue. La page portant la base reste gérée dans l’arbre ; aucune ligne ne s’y ajoute.
2. **Gérer les colonnes** : créer « Statut », type « Choix ». Choisir ensuite Statut dans « Propriété à modifier », ajouter « À faire » et « Terminé ».
3. Ajouter Notes (texte), Charge (nombre), Étiquettes (choix multiples Art/Son), Échéance (date), Vérifié (checkbox), Responsable (personnes), Lien (URL). Créer « Livrer le décor » et « Relire les textures ».
4. Cliquer une cellule, saisir et confirmer. Essayer zéro, « Non », vide : ils restent distincts. Un nombre utilise le point décimal. Une URL invalide est refusée sans effacer la saisie.
5. Essayer une colonne date/heure vide : début `2026-10-27T14:00:00+01:00`, fuseau `Europe/Paris`. Une colonne remplie refuse un changement de type/précision. Renommer une option, la retirer puis restaurer : l’ancienne cellule la conserve, mais le sélecteur ne la propose plus pendant son retrait.

## Le prestataire met à jour sa tâche — A et B

1. **Retour aux pages → Membres, invitations et partages** : inviter B comme guest sur la page Tâches en lecture. Accepter dans B via Mailpit ou lien copié. Si le workspace impose un facteur, le parcours mène d’abord à sa configuration.
2. Dans B, ouvrir Tâches — tableau : explication Lecture seule, cellules non modifiables, gestion des colonnes/corbeille/vue commune absentes.
3. Dans A, passer le partage en édition, recharger B. B ouvre **Statut de Livrer le décor**, choisit **Terminé**, confirme. Actualiser A : statut enregistré. B peut créer une ligne, mais pas modifier le schéma ni les options.
4. A ouvre la ligne par son titre ; B modifie une cellule de cette ligne. Le corps reste ouvert dans A. Ouvrir ensuite la ligne dans B, taper simultanément : chacun voit texte et présence de l’autre. Tester aussi le bouton d’enregistrement du titre.

## Références sans divulgation

1. A crée une autre base Interne, une ligne Référence interne et une colonne relation dans Tâches ciblant Interne. Ne pas partager Interne à B. Ajouter ce lien dans Livrer le décor.
2. B voit **Certaines valeurs ne sont pas accessibles**, sans titre ni nombre ; le sélecteur ne révèle pas la cible. Confirmer depuis B, puis vérifier A : lien conservé.
3. A s’affecte dans Responsable. Sans liste assignable, B ne voit que son nom dans le sélecteur et la mention neutre pour A. B s’ajoute : A constate la conservation de l’ancienne affectation.
4. A ouvre **Gérer les colonnes → Personnes proposées aux invités**, choisit A et B, enregistre. Si demandé, configurer/vérifier son identité puis revenir, sélectionner à nouveau et confirmer. B voit les noms autorisés, sans emails ni annuaire complet.
5. Partager aussi Interne à B en lecture : la référence devient visible et sélectionnable depuis Tâches en édition. Aucun parent non partagé ne doit être révélé.

## Concurrence, tri, filtres et recherche

1. A et B ouvrent la même cellule Notes et saisissent des textes différents. Enregistrer A puis B : B doit voir la valeur actuelle et garder son texte. Choisir **Garder ma saisie pour la réappliquer**, confirmer, vérifier A. Refaire avec **Utiliser la valeur actuelle**.
2. Éditer deux cellules différentes de la même ligne : pas de conflit artificiel de ligne.
3. **Tri et filtres** : filtrer Statut = Terminé, trier par titre, appliquer. Ajouter un filtre vide/date/nombre. Tous se combinent par ET ; personne, relation et choix multiples ne sont pas triables. B ajuste son affichage ; A peut enregistrer la vue commune et vérifier après réouverture.
4. Masquer/réafficher une colonne dans « Colonnes visibles ». Avec onze lignes, choisir dix par page, avancer/reculer sans répétition. Un changement d’affichage repart de la première page.
5. Revenir aux pages et rechercher un mot du titre/Notes. Le résultat ouvre la ligne collaborative native, sans entrée dans l’arbre. Une ligne non partagée reste absente pour B.

## Cache, révocation et onglets retardataires

1. B ouvre une ligne, attend **Copie locale à jour**, coupe le réseau via les outils navigateur, écrit un marqueur et attend la confirmation locale. Fermer l’onglet, rétablir le réseau, rouvrir l’URL : après contrôle des droits, la saisie revient et se synchronise vers A.
2. B ouvre aussi une ligne d’une autre base partagée. Couper le réseau, modifier la première, laisser son onglet en arrière-plan. A retire Tâches ; rétablir le réseau B. L’éditeur concerné s’arrête et propose l’export du travail en mémoire ; l’autre base reste utilisable.
3. Réattribuer Tâches en lecture, recharger l’ancienne ligne : aucun texte non synchronisé avant retrait ne revient. Titre, corps et cellules restent non modifiables. Le test automatisé complète cette manipulation par un vrai gel CDP des timers.
4. Archiver puis restaurer une ligne depuis A : connexions et cache de cette ligne invalidés, autre base préservée. Rouvrir la ligne restaurée ; l’ancien cache ne revient pas.
5. Depuis un autre onglet B : **Accueil et déconnexion → Se déconnecter → Effacer les copies locales et se déconnecter**. Revenir à l’onglet laissé ouvert : session fermée. Dans Application/IndexedDB `memoria-yjs-cache-v1`, les stores documents/updates n’ont plus de données de cet utilisateur. Les marqueurs de révocation restent volontairement présents.

Les cellules et le titre non confirmé ne sont pas des brouillons hors ligne. Une nouvelle ouverture exige le réseau même si un cache existe. Finition visuelle et revue 6d restent distinctes.

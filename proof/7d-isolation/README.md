# Preuve 7d : publication Yjs isolée

30 octobre 2026, autorisation du développeur après le diagnostic `d389b68`. **Prototype, pas intégration de production.** Aucun changement de plafond, de politique d'accès ou de quota.

Le build normal de `apps/collab` reste identique. `build.mjs` adapte uniquement le bundle de preuve, par remplacements explicites dont l'absence ou la multiplicité fait échouer la construction. Les sources générées et leurs empreintes sont conservées dans `.local/isolation-source`. Les contrôles du service existant sont réutilisés ; la dépendance Hocuspocus installée n'est pas modifiée.

## Répartition

- Processus de contrôle : vrais sockets réseau, admission dès réception des octets, Better Auth, contrôles de droits/session/politique, leadership et LISTEN, file de salle, Store PostgreSQL, projections et pool partagé de validation existants.
- Un worker de publication partagé : vrais documents Yjs et Hocuspocus, chargement/application Yjs, calcul de snapshot déjà durable, présence et diffusion native. Le processus de contrôle ne conserve pas de copie supplémentaire des arbres Yjs.
- Les hooks Hocuspocus rejoignent le processus de contrôle par MessagePort privé. La publication attend la validation puis le commit réel. Le reçu durable revient sur le socket réel après la publication et le traitement natif ; les horloges du banc restent aux mêmes frontières.
- L'identité des trames d'admission reste celle du tampon reçu sur le réseau : un identifiant privé permet de retrouver ce tampon après l'aller-retour IPC, de terminer son débit comptable et de libérer ses octets. Les listes de trames sont nettoyées après traitement et fermeture.

Le protocole IPC est borné (4 096 appels simultanés, délai de secours 30 s), sous les bornes d'admission de l'application. Ce délai ne remplace aucun contrôle : les sockets restent détenus par le processus qui applique les révocations et l'échec fermé. Une absence de publication ne devient jamais une confirmation de sauvegarde.

## Mémoire et reprise

Le budget par défaut reste **1 Gio**, mêmes classes de réservation. La preuve ajoute **32 Mio fixes** pour le worker de publication, par analogie avec la réserve par worker de validation existante ; c'est une hypothèse à vérifier par mesure, pas une nouvelle estimation de capacité acquise. À quatre workers de validation, trente pages de la classe ≤256 Kio réservent **1 008 Mio** au total. Le worker de publication a une limite V8 de 384 Mio de vieille génération et 16 Mio de jeune génération ; ces limites ne sont pas une mesure RSS et ne remplacent pas l'admission mémoire.

Après mort réelle du worker, le contrôleur ferme les sockets, invalide les salles, attend les écritures en cours puis recrée le worker. Au retour, les salles sont relues depuis PostgreSQL par le chemin de chargement normal, avec vérification des droits et du registre de fichiers. Les anciens appels/documents sont liés à leur époque et refusés ; les anciennes connexions et charges de trames sont libérées. Aucune copie mémoire provenant du worker perdu n'est utilisée comme autorité.

## Commandes

1. `node proof/7d-isolation/run.mjs transport` : les douze scénarios permanents du service, sans réécriture des assertions.
2. `node proof/7d-isolation/run.mjs files-wire` : attaques R12 sur le vrai WSS/Caddy et les commandes HMAC.
3. `node proof/7d-isolation/run.mjs recovery` : perte du worker, commit avant publication, édition hors ligne, reconnexion automatique du provider natif et révocation pendant la reprise.
4. `node proof/7d-isolation/run.mjs cold` : trois séries, deux profils de 1 Mio, trente échantillons par série après deux échauffements, <500 ms.
5. `node proof/7d-isolation/run.mjs capacity` : trois séries par profil typique, trente pages réellement ouvertes et écrites avec le budget de 1 Gio.
6. `node proof/7d-isolation/run.mjs files-mixed` : même banc dix rédacteurs/cinq pages, avec et sans conversions 8K, trois séries par profil, plafonds serveur et WSS inchangés.

Les mesures gardent le protocole secteur, Windows/WSL après préparation et vmstat sans swap. Aucun build ni test en parallèle. Les rapports de preuve sont séparés sous `.local/isolation`; ils ne remplacent pas les rapports de production précédents.

## Limites à conserver dans la relecture

Le test de reprise est un vrai provider natif, pas le front final ni une saturation CPU volontaire. Il ne clôture pas `CONTROL_UNAVAILABLE`. Le pont IPC et le cycle de vie du worker restent un prototype à examiner avant intégration, même si ses tests passent. L'isolation ne retire pas le coût Yjs : elle le déplace et peut ajouter une attente de diffusion. Mesurer le reçu auteur et l'application chez l'autre client, sans qualifier uniquement le compteur validation/SQL. La charge de gros transferts, la charge NAT et la comparaison alternée finale avec main restent des obligations distinctes de 7d.

## Résultat de la preuve

Les 24 séries froid/capacité/mixte passent leurs plafonds absolus : [fiche, chiffres et journaux](../../docs/reviews/session-7-7d-isolation.md). Le plus grand p95 typique avec historique et conversions est de 24,343 ms ; trente pages réservent 1 008 Mio. Cela ne prouve pas la non-régression : un surcoût historique apparaît face à la campagne précédente non alternée. Comparaison alternée recommandée avant intégration, sans dérogation à `max(10 %, 2 ms)`.

Le premier essai mixte interrompu par un renommage Windows refusé reste conservé ; reproduction réelle du lecteur concurrent, correctif atomique borné puis campagne complète recommencée. `node proof/7d-isolation/summarize.mjs` produit les tableaux à partir des rapports bruts. Aucun build de production ne charge ce prototype.

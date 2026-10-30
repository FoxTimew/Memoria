# 7d — une personne seule, cinq minutes sans modification

30 octobre 2026. Test fonctionnel du vrai front, indépendant des mesures de charge. Il ne clôt pas 7d et ne reproduit pas une saturation CPU.

## Résultat observé

Une seule fenêtre de navigateur, un compte et une ligne ouverte comme page collaborative, via le front Next construit, Nest, PostgreSQL et WSS derrière Caddy. Une phrase témoin est enregistrée avant l'observation. Ensuite, **305,079 secondes sans saisie, rechargement ni interaction** :

- révision de contenu inchangée (`1` avant et après) ;
- **18 trames de présence envoyées, 98 trames reçues** ;
- **aucune fermeture**, une connexion encore ouverte à la fin ;
- seul état visible : « Enregistré sur le serveur » ; aucune alerte, erreur navigateur ou réponse 429 ;
- phrase toujours présente après rechargement, effectué après les cinq minutes.

La suite termine avec **un test réussi, zéro échec**. Le rapport est écrit avant les assertions finales ; son journal complet réussi prouve également le rechargement final. Les trames sont comptées par type, sans conserver cookie, authentification ou contenu du document. Les conteneurs de test utilisent des ports et montages isolés ; les services de développement ne sont pas utilisés comme cibles de panne.

[Rapport](evidence/session-7-7d-reprise-campagne/idle-report.json), [journal complet compressé](evidence/session-7-7d-reprise-campagne/idle-front.txt.gz), [capture après rechargement](evidence/session-7-7d-reprise-campagne/idle-after-reload.png) ; empreintes dans le [manifeste](evidence/session-7-7d-reprise-campagne/manifest.json).

Le test autorise une reconnexion transparente, conformément au critère produit, mais n'en a pas observé ici. Il prouve le maintien par la présence pour cette exécution, pas la reprise après `CONTROL_UNAVAILABLE`, l'hibernation du navigateur ou la saturation CPU.

## Relecture et reproduction

Lire [l'observateur du navigateur](../../apps/api/src/testing/collaboration-idle-front.ts) puis [la fixture du vrai front](../../apps/api/src/files-ui.e2e.ts). Exécuter `pnpm test:collab:idle:browser`, après construction du front et avec PostgreSQL/Caddy locaux disponibles. La suite prépare ses autres services isolés ; elle affiche une progression toutes les trente secondes et ne doit pas tourner pendant un benchmark.

À la main : ouvrir seul une page, saisir une phrase et attendre « Enregistré sur le serveur ». Garder l'onglet visible cinq minutes sans toucher au document. Vérifier l'absence d'erreur, saisir à nouveau, attendre la sauvegarde puis recharger. La présence d'un deuxième éditeur rendrait cet essai différent.

Ce qui pourrait casser : suppression des messages de présence, changement du délai Hocuspocus, onglet masqué ou suspendu, panne du contrôle d'accès. Les fermetures client 1005 du banc et les fermetures serveur `CONTROL_UNAVAILABLE` restent distinguées ; seul le premier diagnostic est expliqué à ce stade.

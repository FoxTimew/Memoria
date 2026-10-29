# Option antivirus locale — préparation de la décision 7d

29 octobre 2026. **Option non activée, aucun risque accepté.** Les fichiers restent soumis aux contrôles de type, au réencodage raster et aux avertissements de téléchargement. Aucun asset envoyé à un service externe.

## Coût et limites vérifiés dans les sources

La [documentation officielle Docker](https://docs.clamav.net/manual/Installing/Docker.html) recommande 3 Gio minimum et 4 Gio de préférence ; son explication indique environ 1,2 Gio pour le moteur de signatures et 2,4 Gio pendant le remplacement simultané des moteurs. Ce sont des indications de l'éditeur, **pas une mesure Memoria**. Le rechargement non concurrent réduit le pic mais suspend les analyses. Il faudrait prévoir cette mémoire **en plus** de la pile ; la configuration minimale visée de 8 Gio doit donc être requalifiée avec l'option.

La version LTS [1.4.6, publiée le 7 août 2026](https://github.com/Cisco-Talos/clamav/releases/tag/clamav-1.4.6), corrige notamment des vulnérabilités du parseur. Une image officielle devra être épinglée par digest et qualifiée avant activation. La [configuration de cette version](https://raw.githubusercontent.com/Cisco-Talos/clamav/clamav-1.4.6/etc/clamd.conf.sample) borne taille, durée, récursion et extraction ; le moteur ne couvre pas un fichier individuel de plus de 2 Gio. Une limite dépassée doit produire un résultat incomplet, jamais « sain ». Le maximum Memoria de 5 Gio reste donc partiellement hors couverture. Les archives chiffrées et les signatures absentes ou périmées sont également des limites.

## Intégration proposée, à décider

Service `clamd` local facultatif, utilisateur non privilégié, sans identifiants S3/PostgreSQL ni socket Docker. Un seul scan à la fois au départ, entrée immuable et sortie de verdict bornée. Un processus de mise à jour des signatures séparé peut accéder à leur serveur officiel ; le scanner n'a pas besoin d'accès réseau externe. Les noms de fichiers originaux ne doivent pas apparaître dans les journaux du scanner.

Le verdict serait lié au hash de l'objet final, à la version moteur/signatures et à la date. Résultats distincts : détection, analyse terminée sans détection, analyse incomplète/indisponible. Même une analyse terminée ne garantit pas l'absence de malware. Une panne, un timeout ou un dépassement ne doivent jamais être convertis en succès. L'opérateur doit choisir explicitement entre mise en quarantaine des non analysables et téléchargement averti ; ne pas choisir cette politique à sa place.

Coût disque supplémentaire : signatures persistantes et extraction temporaire bornée, à dimensionner selon les formats du studio ; la copie de validation peut être réutilisée sans télécharger le fichier entier en RAM. Coût temps : une passe d'analyse supplémentaire, qui retarde la disponibilité ; aucun débit chiffré local n'est encore mesuré. Ne pas extrapoler le temps de conversion d'images au scan antivirus.

## Qualification nécessaire avant activation

- Image officielle épinglée, signatures à jour, test EICAR inoffensif, fichier ordinaire, archive chiffrée, limite de taille et timeout ; différencier tous les verdicts.
- Mesure de RAM/CPU/disque et de débit sur assets représentatifs, rechargement des signatures inclus ; trois séries avec le protocole mémoire et la collaboration active.
- Attaque de réponse tardive après révocation ou remplacement de job : aucun verdict ne peut publier une autre génération ou un objet d'un autre hash.
- Panne/redémarrage du scanner et perte de signatures : reprise bornée et quarantaine conservée, sans fuite de noms, chemins, tickets ou contenu.

**Recommandation provisoire :** garder l'option facultative pour le pilote, sans la présenter comme une couverture des gros assets. La décision malware reste à soumettre dans le tableau des risques 7d, avec la qualification de capacité manquante explicitement indiquée.

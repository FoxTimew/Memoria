# Session 7d — revue adverse et mesures finales

29 octobre 2026. Branche `codex/session-7-files`. **En cours : ne pas fusionner sur la base de cette fiche intermédiaire.** Les validations de 7a, 7b et 7c restent datées dans leurs propres fiches ; elles ne remplacent pas les contrôles finaux de 7d. Aucun risque résiduel accepté ici.

## Livré et vérifié à ce stade

Le gateway de lecture ferme ses flux dès la perte du canal de contrôle, puis rétablit LISTEN avec un délai progressif borné à cinq secondes. Les nouvelles lectures ne rouvrent qu'après une connexion vérifiée ; chacune reprend les contrôles courants. Une admission commencée avant la coupure ne peut publier après la reprise : elle doit appartenir à la même époque de contrôle. Les anciens flux restent fermés, jamais ressuscités.

Le [test permanent de reprise](../../apps/files/src/recovery.e2e.ts) utilise son propre PostgreSQL Docker et RustFS, protégés par le garde-fou d'isolation. Il détruit réellement la connexion LISTEN, puis arrête brutalement et redémarre **son PostgreSQL de test**. Il vérifie les lectures fermées pendant la panne, la reprise sans intervention, le refus d'une admission traversant la coupure et le refus d'une session révoquée. PostgreSQL et Caddy de développement ne sont jamais redémarrés par ce test.

Le test autonome a aussi révélé un import trop large du gateway vers le package auth : le barrel chargeait Better Auth, absent de l'application files. L'export `@memoria/auth/throttle` fournit désormais uniquement les quotas requis. Aucun contrôle d'authentification ni timeout n'est retiré.

À lire : [gateway](../../apps/files/src/gateway.ts), [test de reprise](../../apps/files/src/recovery.e2e.ts), [export auth](../../packages/auth/package.json), puis l'instrumentation WSS [serveur](../../apps/collab/src/testing/file-load-trace.ts) et [client séparé](../../apps/collab/src/testing/file-load-client.ts).

## Mesures et portée

La [décomposition WSS](session-7-7d-wss.md) passe ses trois séries par profil avec le protocole secteur/Windows/WSL/swap : 24 cas, 3 600 reçus, 566 intervalles vmstat sans swap. Le premier essai s'est arrêté sur une erreur d'instrumentation (trame `ArrayBuffer` non décodée), avant tout résultat exploitable ; correction et test de décodage ajoutés. Cet essai est conservé à côté des séries valides.

Les horloges sont locales à chaque processus. Les échantillons sont reliés par le reçu de l'update. Le temps client de modification chevauche le délai avant envoi et ne s'ajoute pas une seconde fois au reçu total. Le résidu inclut transport, Caddy et ordonnancement : aucune mesure séparée du réseau aller/retour. La mesure d'application de la réplique inclut les callbacks Yjs ; la diffusion distante n'est pas assimilée à l'arrivée du reçu durable chez l'auteur. Les résultats instrumentés ne remplacent pas la comparaison alternée finale non instrumentée.

## Contrôles restant à clôturer

| Obligation                                         | État de cette fiche intermédiaire                                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matrice R12/S5-R11 consolidée et attaques          | [Matrice intermédiaire](session-7-7d-matrice.md), inventaire fermé et suites relancées ; convertisseur désormais attaqué, charge restant à clôturer |
| Fuites et proxy                                    | Canaris SDK, HTTP/retry/audit/outbox, signatures observées et clés absentes des journaux Caddy/RustFS ; configurations externes non couvertes       |
| Gros transferts, charge mixte, conversions 8K, NAT | Non qualifiés par les durées de tests fonctionnels ; campagnes finales restantes                                                                    |
| CONTROL_UNAVAILABLE et reconnexion sans perte      | Saturation volontaire et parcours réel à exécuter ; absence de preuve de reprise automatique globale du serveur collaboratif                        |
| Décomposition WSS contenu/historique               | [24 cas conformes](session-7-7d-wss.md) ; réception chez les autres clients et délai du front final à compléter en charge mixte                     |
| Gateway après perte LISTEN et redémarrage PG       | Test réel réussi ; journal et observation temporelle versionnés, sans les présenter comme un p95                                                    |
| Convertisseur permanent sans socket Docker         | [Livré et attaqué](session-7-7d-convertisseur.md), six séries 8K conformes ; charge mixte arrêtée à une fermeture dès l'échauffement                |
| Antivirus facultatif                               | [Option locale préparée](session-7-7d-antivirus.md), coût éditeur et limites ; aucune capacité locale déclarée mesurée                              |
| Comparaison alternée main                          | À exécuter sur la candidate finale ; main distant vérifié `56c52b4b5cb4c4df94841328398d141955b48394`                                                |
| Risques, guide consolidé, description PR           | [Tableau de travail](session-7-7d-risques.md) sans acceptation ; guide/description finale à terminer après les preuves restantes                    |

## Contrôles de ce point intermédiaire

Journaux complets dans [evidence/session-7-7d-initiale](evidence/session-7-7d-initiale/manifest.json). Les comptes Node incluent les tests parents ; les durées fonctionnelles ne sont pas des p95.

| Commande                           | Résultat                                                                                   | Journal                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                       | Hooks, lint, types, bootstrap Nest ; **182 tests réussis, 6 ignorés**, 38 fichiers réussis | [check.txt](evidence/session-7-7d-initiale/check.txt)                                                                    |
| `pnpm test:db`                     | Les **6 tests SQL** ignorés ci-dessus passent                                              | [db.txt](evidence/session-7-7d-initiale/db.txt)                                                                          |
| `pnpm test:files:gateway-recovery` | **1**, vrai LISTEN/arrêt brutal/reprise PG, admission retardée et révocation               | [gateway.txt](evidence/session-7-7d-initiale/gateway.txt)                                                                |
| `pnpm test:files:e2e`              | **12**, dont canari SDK et inventaire fermé des routes                                     | [transfers.txt](evidence/session-7-7d-initiale/transfers.txt)                                                            |
| `pnpm test:files:reading`          | **15**, reprise compatible avec anciens contrôles/flux                                     | [reading.txt](evidence/session-7-7d-initiale/reading.txt)                                                                |
| `pnpm test:files:races`            | **6**, courses et rollback                                                                 | [races.txt](evidence/session-7-7d-initiale/races.txt)                                                                    |
| `pnpm test:files:boundaries`       | **16 + 7 + 3**, registre, cellules et WSS/HMAC                                             | [boundaries.txt](evidence/session-7-7d-initiale/boundaries.txt)                                                          |
| `pnpm test:files:recovery`         | **10**, états ambigus et anciens jobs                                                      | [recovery.txt](evidence/session-7-7d-initiale/recovery.txt)                                                              |
| `pnpm test:files:browser`          | **1**, HTTPS/CORS/proxy et audit des signatures réelles dans Caddy/RustFS                  | [browser.txt](evidence/session-7-7d-initiale/browser.txt), [rapport](evidence/session-7-7d-initiale/browser-report.json) |
| `pnpm test:files:ui`               | **1**, produit final, multipart 81 Mio, guest edit, cache/gel/logout                       | [ui.txt](evidence/session-7-7d-initiale/ui.txt), [rapport](evidence/session-7-7d-initiale/ui-report.json)                |
| `pnpm test:docker:isolation`       | **1**, inventaire Docker réel, volume de développement refusé avant création               | [isolation.txt](evidence/session-7-7d-initiale/isolation.txt)                                                            |

Le test gateway observe 227 ms pour retrouver un health sain après la fermeture du premier flux, puis 1 730 ms après la commande de redémarrage de PostgreSQL. **Un seul exercice, pas des mesures de capacité** ; la fermeture est vérifiée sous cinq secondes. Les 503 pendant la panne et le refus d'une admission antérieure sont éprouvés séparément.

Essais échoués conservés : première instrumentation ArrayBuffer, injection SDK sur le mauvais client S3 du job (corrigée sur la vraie instance de travail), puis annotation TypeScript du test de reprise. Ils ne sont pas présentés comme des failles applicatives ni des séries de performance valides écartées. Aucun hook contourné, seuil ou quota modifié.

Deux essais initiaux de montage du test gateway ont aussi échoué : import auth trop large corrigé, puis acteur absent dans la fixture corrigé. Leurs sorties complètes n'ont pas été conservées ; seul le journal réussi est publié. Ce manque ne concerne aucune série de performance.

## Guide manuel de la reprise déjà disponible

Le [guide consolidé à deux navigateurs](session-7-guide-manuel.md) couvre également transferts, tâches invitées, avertissements et cache ; il reste identifié comme intermédiaire tant que la charge et le convertisseur permanent ne sont pas qualifiés. Le brouillon unique `.local/session-7-pr-description.md` rassemble 7a–7d avec les blocages explicites, sans annoncer une PR prête au merge.

1. Laisser les services locaux habituels fonctionner. Ne pas couper le PostgreSQL de développement.
2. Lancer `pnpm test:files:gateway-recovery` à la racine. Le test crée et détruit ses propres conteneurs ; le garde-fou refuse un port ou volume partagé avec le développement.
3. Vérifier un résumé final réussi et le rapport `.local/7d/gateway-recovery.json`. Les observations chronométrées décrivent ce seul exercice fonctionnel, pas la capacité de production.
4. Relire le contrôle d'époque dans le gateway : une réponse d'autorisation retardée au-delà d'une coupure reste refusée même après retour de PostgreSQL.

Ce qui pourrait encore casser : panne prolongée ou intermittente du réseau, redémarrage de la pile entière, charge élevée des contrôles par flux et saturation CPU. La reprise du gateway ne prouve ni la reprise du leadership collaboratif ni la capacité de cinquante personnes. Ces points restent ouverts avant clôture de 7d.

## Point du 30 octobre — convertisseur et arrêt de charge

Le [convertisseur permanent](session-7-7d-convertisseur.md) utilise le dossier privé retenu par le développeur, sans socket Docker applicatif, avec confinement, expirations, quota et revalidation indépendante des sorties. Six séries 8K passent ; l’interface finale passe avec ce service.

Le développeur a validé la fixture mixte d’une page de 1 Mio et quatre pages typiques, toujours dix rédacteurs et le budget de 1 Gio. Une série sans conversion passe ; le palier avec conversion ferme un client dès la vague d’échauffement 0. **Arrêt avant nouveau benchmark ou optimisation.** La fermeture n’est pas identifiée comme CONTROL_UNAVAILABLE. Le timeout d’inactivité du client synthétique pendant la préparation est une hypothèse à confirmer. Aucun p95 mixte avec conversion, aucune qualification CPU, aucun résultat historique mixte ni comparaison finale annoncé. Diagnostic, chiffres, journaux et recommandation dans la fiche dédiée.

**Suite autorisée le même jour :** l'[instrumentation du banc](session-7-7d-banc-mixte.md) confirme la fermeture locale par le délai Hocuspocus pendant la préparation. Préparation corrigée ; aucune fermeture sur les 1 000 écritures de la relance. Cette relance reste non qualifiée faute d'exercice des deux textures ; chevauchement explicite ajouté, puis nouvelle campagne refusée au seuil mémoire avant préparation. Aucun plafond ni contrôle produit modifié ; les trois séries finales restent requises.

**Front inactif, 30 octobre :** le [nouveau test du vrai front](session-7-7d-front-inactif.md) passe : une seule personne, 305 secondes sans modification, 18 trames de présence, 98 trames reçues, aucune fermeture ni erreur visible. Le contenu reste présent après rechargement. Cette preuve fonctionnelle ne remplace pas la saturation volontaire ni la reprise après `CONTROL_UNAVAILABLE`.

**Reprise et nouvel arrêt, même date :** la [campagne à dix rédacteurs](session-7-7d-reprise-campagne.md) passe ses trois séries contenu avec/sans conversions. Deuxième série historique avec conversions : une page typique dépasse son plafond serveur, **53,955 ms pour <50 ms**. Dix séries mesurées, neuf conformes et une en échec, sans swap ni fermeture, convergence vérifiée. Troisième répétition historique non lancée. Diagnostic sur les traces existantes publié, profilage ciblé recommandé avant optimisation ; aucun seuil ou contrôle modifié. Les autres mesures restent suspendues et la fiche demeure non clôturée.

**Suite autorisée le 30 octobre :** [profilage CPU/pool/SQL, correction candidate et requalification](session-7-7d-profilage-mixte.md). Le coût Yjs historique sur la boucle Node est établi ; céder l'I/O entre applications reste insuffisant. Douze séries non instrumentées : onze conformes, dernière série historique + 8K en échec sur une page typique à **55,624 ms (>50)**. Convergence des 12 000 écritures, zéro fermeture/swap, 24 conversions sous leurs limites ; aucune qualification globale ni gain fiable revendiqué. Suites ciblées : 42 résultats réussis. La fiche dédiée donne les journaux complets, les trois valeurs et médianes, le guide de relecture et les options. **Arrêt avant nouvelle optimisation**, aucune baisse de contrôle ni hausse de seuil ; la comparaison main et les autres obligations restent à exécuter après arbitrage.

**Preuve d'isolation autorisée ensuite :** [fiche dédiée](session-7-7d-isolation.md), prototype hors build de production. Douze séries mixtes conformes aux plafonds absolus (typique avec historique/8K : maximum 24,343 ms), six froides sous 500 ms, six séries de trente pages dans 1 Gio ; 12 000 contributions convergentes, aucune fermeture/swap. Reprise après mort du worker testée avec commit durable et révocation. Correctif Windows distinct, après reproduction d'un lecteur bloquant le renommage atomique, puis campagne complète reprise. **Comparaison alternée toujours absente** : surcoût historique apparent exposé, pas de dérogation ni d'intégration. Les obligations restantes de cette fiche ne sont pas clôturées par le prototype.

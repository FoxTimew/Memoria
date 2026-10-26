# Session 6a — reprise des mesures, refus après préparation

26 octobre 2026. Candidate de code inchangée : **`2dcc4f9a625d62f315282c993ff6422b0676de33`**. Le développeur a redémarré WSL, relancé l’infrastructure et demandé les deux mesures différées, dans l’ordre tableau puis cellules/Yjs. **Aucune mesure de latence n’a été effectuée : 6a reste ouverte.** Le banc cellules n’a pas été lancé après l’arrêt du tableau.

## Protocole et point d’arrêt

Le secteur est confirmé (`BatteryStatus=2`). Après le redémarrage, un premier relevé au repos était à 2,577 Gio, puis le relevé avant lancement est remonté à **4,103 Gio**. Aucun build ni test ne tournait en parallèle du banc ; sa compilation préalable est terminée et le processus esbuild libéré avant préparation et chronométrage.

Le banc a préparé **10 000 lignes, 50 propriétés, neuf types, 100 options par propriété, 50 cibles de relation et 20 personnes**. À **15 h 05 min 07 s, heure de Paris**, avant le premier échantillon owner/filtre peu sélectif, il a relevé **2 954 285 056 octets = 2,751 Gio** libres. L’assertion `FREE_RAM_BELOW_3_GIB` a arrêté le processus ; sortie 1, fixture supprimée normalement. Aucun p95, plan chronométré ou série réussie ne doit être déduit de ce lancement. Il manque environ **255 Mio** au minimum strict ; une marge supplémentaire reste nécessaire pour ne pas retomber sous la borne avant une série suivante.

[Journal intégral du lancement](evidence/session-6a-table-retry-ram-refused.txt). Les trois séries, <200 ms pour le tableau et <100 ms pour les cellules restent exigés. Aucun seuil n’est abaissé, aucune optimisation ni modification applicative n’est faite dans cette reprise.

## Consommation relevée après l’arrêt

Le diagnostic ci-dessous est pris **après le refus et le nettoyage**, à 15 h 06 min 03 s : ce n’est pas une mesure de pic pendant le chargement. Windows affiche alors **3,108 Gio disponibles**, sur **13,856 Gio utilisables**. Ce rebond ne remplace pas le contrôle après préparation.

| Ensemble                    |                               Mémoire relevée | Interprétation                                                                                     |
| --------------------------- | --------------------------------------------: | -------------------------------------------------------------------------------------------------- |
| `vmmemWSL`                  |                          3 802 Mio (3,71 Gio) | Ensemble de la VM Docker/WSL                                                                       |
| Cache disque Linux `Cached` |                          2 464 Mio (2,41 Gio) | **Inclus dans WSL**, réutilisable côté Linux ; pas équivalent à la RAM déjà rendue à Windows       |
| Conteneur PostgreSQL        |                                     199,9 Mio | **Inclus dans WSL** ; chiffre `docker stats`, pas la somme des RSS PostgreSQL partageant des pages |
| Autres conteneurs           | MinIO 84,71 ; Mailpit 23,18 ; Caddy 15,85 Mio | Inclus dans WSL, aucun autre conteneur actif observé                                               |
| Docker Desktop Windows      |                                       473 Mio | Somme des working sets de ses cinq processus, hors VM                                              |
| Backend Docker Windows      |                                       228 Mio | Deux processus, hors VM ; autres auxiliaires Docker environ 104 Mio                                |
| Node                        |                                       415 Mio | Neuf processus ; `host-daemon.mjs`, quatre `cua-repl.mjs`, quatre `server.mjs`                     |
| Auxiliaires `node_repl`     |                                        91 Mio | Neuf processus distincts des `node.exe`                                                            |
| Application `ChatGPT`       |                          1 435 Mio (1,40 Gio) | Douze processus de l’application ; somme des working sets                                          |
| `codex`                     |                                       327 Mio | Deux processus ; auxiliaires Codex supplémentaires environ 86 Mio                                  |

Ces lignes **ne s’additionnent pas toutes** : les conteneurs et le cache Linux sont déjà compris dans WSL ; les working sets Windows peuvent inclure des pages partagées. Aucun argument de processus, token ou secret n’a été relevé dans le diagnostic publié.

Entre les deux instantanés, le working set WSL augmente d’environ **1 058 Mio**, et son cache disque Linux d’environ **955 Mio**. Cela explique une grande part de la variation observée, sans constituer une attribution exacte du pic ni une preuve de fuite. PostgreSQL passe d’environ 39 à 200 Mio dans `docker stats`. Les neuf processus Node reviennent au même total de 415 Mio après nettoyage ; aucun vieux banc de mesure n’est encore actif. Les quatre `server.mjs` n’ont pas été identifiés plus finement : ne pas les assimiler arbitrairement à des serveurs applicatifs inutiles.

Sources : [avant lancement Windows](evidence/session-6a-retry-memory-before.json), [après arrêt Windows](evidence/session-6a-retry-memory-after.json), [conteneurs avant/après](evidence/session-6a-retry-memory-containers.txt), [WSL avant/après](evidence/session-6a-retry-memory-wsl.txt), [processus PostgreSQL](evidence/session-6a-retry-memory-postgres.txt), [points d’entrée Node](evidence/session-6a-retry-node-entries.json). Aucun processus utilisateur n’a été fermé ni service reconfiguré pour cette reprise.

## Suite et relecture

Reprendre seulement lorsque la préparation garde ≥3 Gio, en laissant une marge au-delà des 255 Mio manquants observés. Le poste semble avoir besoin d’environ 0,5 à 1 Gio de marge supplémentaire pour ce banc, **estimation**, pas garantie. Les fenêtres ou outils inactifs de l’application peuvent constituer une piste ; ne pas arrêter PostgreSQL, nécessaire au banc. Le cache WSL rend un simple relevé au repos insuffisant.

Le code et le [guide manuel à deux clients](session-6-6a-cellules-et-arborescence.md) sont inchangés ; leurs tests précédents restent archivés. Cette reprise publie uniquement le refus et le diagnostic de mémoire. Elle ne clôture pas 6a, ne qualifie pas les cellules finales et ne commence pas 6b. Aucune PR n’est créée.

Contrôle de cette livraison documentaire, une fois le banc arrêté : [journal complet de `pnpm check`](evidence/session-6a-memory-retry-check.txt), hooks/lint/types/Nest réussis, **136 tests réussis et 6 tests SQL ignorés** par cette commande. Les six tests SQL séparés de la livraison précédente ne sont pas présentés comme relancés ici. Commit et push normaux, sans contournement des hooks ; hash final vérifié directement sur le distant dans le compte rendu.

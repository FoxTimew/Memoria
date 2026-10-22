# ADR 010 — Outbox, jobs et livraisons

Statut : accepté — 2026-10-22.

**Décision.** Événements de domaine ajoutés à `outbox_events` dans la transaction métier. Un relais dans le worker lit les événements disponibles, réserve un bail avec `FOR UPDATE SKIP LOCKED`, envoie un job pg-boss, puis marque la publication. Les jobs portent des IDs, pas des documents ou secrets.

L'outbox est une table de messages à envoyer, écrite en même temps que les données. Si la transaction échoue, ni modification ni événement ne subsiste ; si le processus tombe après commit, le relais retrouve le message. Cela évite de réussir une sauvegarde tout en perdant son webhook.

**Alternatives.** HTTP webhook dans la transaction ; événement en mémoire après commit ; Kafka/Redis ; dépendre d'une promesse « exactement une fois » sur HTTP.

**Raison.** PostgreSQL + pg-boss suffisent ; les pannes réseau imposent une livraison au moins une fois.

**Conséquences.** Le crash après enqueue avant marquage republie : dédupliquer avec `(workspace,event,endpoint)` et ignorer les livraisons terminales. `singletonKey` seul ne constitue pas une déduplication permanente. Un scanner réveille les outbox/livraisons bloquées après expiration de bail. Ne marquer publié qu'après enqueue réussi ou existence confirmée du job équivalent. `materialized_at` est posé dans la transaction qui crée les livraisons, même si aucun endpoint ne correspond. Un événement publié mais non matérialisé reste conservé et peut être réenfilé si le job disparaît. Les livraisons portent leur propre `claimed_until`, pour reprendre un worker mort. pg-boss gère son schéma et ses migrations ; aucun modèle Drizzle manuel de ses tables.

Événements : `page.created`, `page.updated`, `block.updated`, `database.row.created`, `database.row.updated`. Enveloppe versionnée ; payload limité aux IDs et version de page, permettant au consommateur de relire l'état autorisé. Sélectionner les endpoints actifs correspondant à l'événement lors de la matérialisation des livraisons ; leur création doit précéder l'événement.

HMAC-SHA256 sur les octets exacts `timestamp + '.' + eventId + '.' + body`, headers `X-Memoria-Event-Id`, `X-Memoria-Timestamp`, `X-Memoria-Signature: v1=hex`. Secret aléatoire chiffré, rotation avec fenêtre de coexistence bornée. Timeout 10 s, réponse bornée, pas de corps journalisé. 2xx = succès ; retries exponentiels avec jitter, plafond 1 h, 10 tentatives max par défaut, puis exhausted. Le registre de livraisons possède le compteur et `next_attempt_at` ; programmer les jobs avec `startAfter`, sans deuxième boucle de retry HTTP indépendante dans pg-boss. La reprise d'un crash peut dupliquer un appel et doit conserver le même event ID. Désactivation après 10 échecs consécutifs configurable, réactivation manuelle après connexion forte ; remise à zéro après succès sous verrou endpoint. [pg-boss jobs](https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md).

HTTPS public par défaut ; refuser credentials URL, ports non autorisés, loopback/link-local/métadonnées cloud et IP privées. Résoudre A/AAAA à chaque tentative, vérifier toutes les IP et connecter une IP vérifiée en conservant hostname/SNI ; refuser les redirections pour éviter le rebinding. En self-hosted seulement : allowlist d'hôtes/CIDR/ports de l'exploitant pour le LAN, avec TLS vérifié, jamais une exemption contrôlée par le workspace. Implémentation réseau à tester avant activation.

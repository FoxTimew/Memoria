# Session 7d — refus de leadership et reprise ciblée

6 novembre 2026. Diagnostic et correction autorisés par le développeur après le point `eb2d1fd`. Cette fiche complète le [témoin rouge CPU](session-7-7d-cpu.md) ; elle ne clôture pas la session 7d.

## Diagnostic avant correction

La fixture conserve désormais les seuls codes fixes du serveur : refus d'admission, refus de transaction, âge du leadership et fermeture demandée. Aucun SQL, contenu, identifiant de session ou jeton n'est ajouté à cette trace. Deux répétitions sans modification applicative ont été exécutées avec le même palier supplémentaire de 3 500 ms, les conversions 8K et le vrai front.

- Première répétition : rafale réelle 3 527 ms, garde local de leadership périmé à 3 904 ms, fermeture 1000 ; le front reprend et les 94 saisies convergent. Le défaut est intermittent.
- Deuxième répétition : rafale réelle 3 572 ms ; `Room.update` rejette `COLLAB_LEADERSHIP_LOST`, sans erreur de validation du candidat ni réplique fatale. La fermeture demandée est **1008 `UPDATE_REJECTED`**, puis le front reste « Édition arrêtée ». Aucun refus d'admission ni de droits n'est observé.

Le garde SQL a correctement refusé la transaction pendant l'expiration du bail. L'erreur était ensuite confondue avec un contenu invalide, ce qui arrêtait définitivement le front. La première capture `eb2d1fd` n'avait pas conservé son motif exact : la nouvelle trace prouve ce chemin de panne reproduit, sans inventer les données manquantes de l'ancienne capture. Le diagnostic a été présenté avant modification du service.

## Correction et garanties

`LeadershipLost` distingue uniquement les deux refus de fencing locaux/SQL. Le serveur ferme leur socket en **1013 `LEADERSHIP_UNAVAILABLE`** ; il ne compte pas cet incident comme une tentative de contenu invalide. La transaction reste annulée, sans application, diffusion ni reçu durable. Le front utilise son mécanisme de reconnexion existant : contrôle HTTP courant, session Better Auth, autorisation du document, nouvelle validation du diff et nouvelle transaction avec fencing. Les contributions seulement locales restent dans Yjs ; aucun rejeu de messages bruts n'est ajouté.

Le front ne transforme pas les refus 1008 en reprises automatiques. Seul le code technique fixe éventuel du message d'authentification est exempté de l'arrêt définitif ; le serveur ferme aussi cette connexion en 1013. Un contenu portant la même chaîne ne peut produire l'exception typée côté serveur. Ni les durées 1 500/2 500/3 000 ms du contrôle et du leadership, ni les délais de reconnexion, ni les contrôles de session, politique ou droits ne changent. Le prototype d'isolation reste hors production.

Le diagnostic complémentaire révèle une seconde course lors de la reprise. Après une saisie hors ligne, une frappe produite pendant l'authentification peut être envoyée en `Update` (type 2) avant le diff de reprise `SyncStep2` (type 1). Le serveur ne connaît pas encore les horloges dont cette frappe dépend ; son codec la refuse correctement. Le test avec la véritable classe du front reproduit **type 0 → type 2 → `UNRESOLVED_DEPENDENCIES`**, même sans saturation CPU. Les deux premiers essais d'injection ne modifiaient pas le hook réellement enregistré et ne constituent pas cette preuve ; leurs journaux restent conservés. L'essai rouge suivant injecte effectivement le délai dans l'extension enregistrée, sans retirer les contrôles, et rejoue les octets contre le codec complet.

Correction côté front : les mises à jour incrémentales restent dans le document Yjs jusqu'à l'envoi du premier diff complet sur la socket courante. Elles sont incluses dans ce diff ; aucune file supplémentaire n'est conservée et aucun reçu n'est inventé. Le drapeau est réinitialisé à chaque connexion. Le booléen `synced` de Hocuspocus ne suffit pas : il signifie que le client a reçu le diff du serveur, pas qu'il a envoyé le sien. Le test permanent affirme désormais l'ordre **type 0 → type 1**, les deux textes reçus par le pair, le reçu durable et l'absence de 1008. Le validateur et le refus des dépendances manquantes sont inchangés.

## Preuves et limites

Le test permanent `reconnect-fence.e2e.ts` utilise PostgreSQL, Better Auth, Hocuspocus et la classe réelle du front. Sa fixture suspend le heartbeat et expire le bail SQL pour reproduire le refus de manière déterministe ; le scénario d'ordre des messages retarde le hook d'authentification et le traitement du premier vecteur d'état. Elle n'injecte ni reçu ni code de fermeture. **Cinq scénarios passent** (six résultats Node avec le parent) : refus SQL sans diffusion puis reprise et reçu unique ; garde local périmé puis reprise ; révocation entre refus et reconnexion interdisant le texte local ; frappe pendant réauthentification ; contenu invalide restant bloqué en 1008. Ces tests sont fonctionnels, distincts des mesures CPU.

La première requalification du vrai front après cette correction passe deux séries (96 et 95 saisies, réouvertures après 1 486 et 1 602 ms), puis échoue à la troisième : après deux reconnexions techniques, le validateur rejette un candidat Yjs et provoque un nouveau 1008. 90 saisies restent locales, 78 sont visibles chez l'autre personne ; 70 révisions supplémentaires ne correspondent pas à 70 saisies, car certaines sont regroupées. Les trois séries sont sans swap (57/58/86 intervalles). Ce résultat rouge reste conservé et interdit de qualifier cette correction partielle. Trois répétitions instrumentées supplémentaires passent sans reproduire le rejet ; elles ne l'effacent pas. Le sous-motif du candidat de la troisième série n'avait pas été conservé. Le test d'entrelacement établit séparément le refus des dépendances manquantes ; la requalification finale vérifie les deux corrections ensemble, sans prétendre reconstruire les octets perdus de cette capture.

### Requalification finale : trois séries conformes

Vrai front reconstruit, deux comptes, WSS/Caddy/PostgreSQL, quatre workers de charge et conversions 8K ; mêmes paliers CPU et mêmes garde-fous. Aucun build ni test concurrent. **286 saisies** confirmées, toutes visibles chez le pair et après rechargement de l'auteur, aucune erreur JavaScript ni 429. Quatre fermetures techniques 1013 sont observées ; aucun 1008 ni `CONTROL_UNAVAILABLE`.

| Série | Rafale demandée 3 500 ms, durée réelle | Saisies confirmées | Fermeture → nouvelle socket | Conversion maximale | Pic convertisseur |
| ----- | -------------------------------------- | ------------------ | --------------------------- | ------------------- | ----------------- |
| 1     | 3 590,35 ms                            | 96                 | 1 365 ms                    | 19,203 s            | 91,47 Mio         |
| 2     | 3 583,20 ms                            | 95                 | 1 559 ms                    | 19,585 s            | 115,73 Mio        |
| 3     | 3 639,87 ms                            | 95                 | 1 492 puis 1 397 ms         | 19,767 s            | 91,21 Mio         |

La latence du tableau est celle de la **réouverture de socket**, pas du reçu durable : le test prouve ce dernier et la convergence ensuite, sans leur attribuer ce temps. Médiane des plus grandes réouvertures par série : 1 492 ms. Les 85/84/77 révisions supplémentaires regroupent plusieurs saisies ; elles ne se comparent pas une pour une au nombre de tokens. Les douze conversions sont validées, sous 30 s/512 Mio.

Secteur présent ; minima arrondis : Windows 4,62 Gio avant préparation et 3,53 Gio après ; WSL 5,48 Gio après préparation. **54/52/52 intervalles vmstat**, si/so à zéro et compteurs inchangés. Une première cohorte verte (également 286 saisies, 160 intervalles) est conservée ; la cohorte finale ci-dessus suit la relecture préservant le traitement antérieur des pannes globales, hors compteur de contenu invalide. Journaux bruts, anciens refus et [empreintes des artefacts](evidence/session-7-7d-reconnexion/manifest.json) conservés. Ce diagnostic de famine CPU n'est pas une mesure de latence normale ni une substitution à la comparaison alternée avec main.

`pnpm check` complet passe : **189 tests réussis, six tests SQL ignorés**, lint, types, bootstrap Nest et installation des hooks conformes. Les suites PostgreSQL/WebSocket séparées donnent **23 résultats réussis** : six pour la reprise (cinq sous-scénarios et le parent), treize pour le transport, un pour le leadership, trois pour le journal. Les refus attendus restent visibles dans les journaux ; aucun test de panne n'a été ignoré ni hook contourné. Le test navigateur final donne trois réussites supplémentaires. Journaux complets dans les artefacts, notamment `check.log.gz`, `functional-final2.log.gz`, `transport-final2.log.gz` et `regressions.log.gz`.

`CONTROL_UNAVAILABLE` reste distinct : aucune occurrence dans les deux répétitions de diagnostic. La perte permanente d'un canal de contrôle rend encore le service indisponible sans réarmement ; cette correction du refus transitoire n'est pas une preuve de reprise de ce chemin global. Les gros transferts, la charge NAT, la comparaison finale avec main et la mesure antivirus restent requis.

## Relecture et test manuel

Lire d'abord cette fiche, puis `apps/collab/src/service/leadership.ts`, les traitements `retryLeadership` de `server.ts`, `apps/web/src/lib/collaboration-client.ts` et le test permanent. Le principal risque est de classer un refus métier comme transitoire : la distinction repose sur une classe serveur, pas sur un texte fourni par un client. Les routes et quotas restent inchangés.

Sur un environnement de test, deux navigateurs sur une page : saisir hors ligne puis reconnecter tout en continuant à saisir, vérifier « Enregistré sur le serveur », convergence et conservation après rechargement. Refaire en retirant l'accès pendant la coupure : aucune contribution locale ne doit être renvoyée. Le diagnostic CPU est volontairement perturbateur, à lancer uniquement hors studio actif avec `pnpm test:collab:cpu:browser --extended-cpu` ; il construit le front et applique les garde-fous avant chacune des trois séries. `node scripts/test-collab.mjs --suite reconnect-fence` rejoue les cinq frontières sans charge CPU ni mesure de performance.

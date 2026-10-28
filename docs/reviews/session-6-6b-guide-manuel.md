# Session 6b — guide à deux clients (20–30 minutes)

Cette étape livre les services ; le tableau visuel sera en 6c. Utiliser des données de test. Démarrer la pile habituelle après `pnpm db:migrate`, avec API/collab/worker de cette branche. Les suites automatiques créent leurs schémas PostgreSQL isolés et un proxy TLS temporaire ; elles ne réinitialisent pas votre workspace.

## 1. Préparer les deux comptes

Navigateur A : owner, avec facteur fort configuré. Navigateur B ou fenêtre privée : invité du même workspace. Garder l'interface de partage de la session 5 pour accorder les droits. Dans chaque console du navigateur, charger ce petit client ; il utilise les cookies existants, ne demande ni mot de passe ni jeton :

```js
var workspace = 'REMPLACER_PAR_ID_DU_WORKSPACE';
var root = `/api/internal/workspaces/${workspace}`;
var call = async (path, method = 'GET', body) => {
  const response = await fetch(root + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  console.log(response.status, data);
  return { status: response.status, data };
};
```

Copier l'ID depuis l'URL du workspace. Ne coller ces commandes que dans votre origine Memoria. Si le navigateur impose une confirmation de collage, taper vous-même le code ; aucun contournement de protection n'est nécessaire.

## 2. Créer une base et les propriétés dans A

```js
var base = (await call('/databases', 'POST', { title: 'Tâches 6b' })).data;
var b = `/databases/${base.id}`;
var schema = '1';
var fields = {};
var add = async (name, kind, extra = {}) => {
  const r = await call(b + '/properties', 'POST', {
    expectedSchemaVersion: schema,
    name,
    kind,
    ...extra,
  });
  if (r.status === 200) {
    schema = r.data.schemaVersion;
    fields[kind] = r.data.id;
  }
};
await add('Description', 'text');
await add('Estimation', 'number');
await add('Fait', 'checkbox');
await add('Échéance', 'date', { config: { mode: 'date' } });
await add('Lien', 'url');
await add('Statut', 'select');
await add('Tags', 'multi_select');
await add('Responsables', 'person');
var target = (await call('/databases', 'POST', { title: 'Références privées' })).data;
await add('Liens de tâche', 'relation', { targetDatabaseId: target.id });
```

Réponse attendue : 200 à chaque étape. Le conteneur est une page ordinaire, visible dans l'arbre ; ses lignes n'y apparaîtront pas. Pour les options, appeler `POST b + '/properties/' + fields.select + '/options'` avec `{expectedSchemaVersion:schema,label:'À faire'}`, puis mettre `schema` à la version reçue. Faire de même pour multi-select. Conserver leurs IDs.

Créer une ligne et rejouer exactement la même demande :

```js
var body = { receipt: crypto.randomUUID(), expectedSchemaVersion: schema, title: 'Première tâche' };
var row = (await call(b + '/rows', 'POST', body)).data.id;
await call(b + '/rows', 'POST', body); // même ID, replayed:true
var r = b + '/rows/' + row;
var set = async (property, value) => {
  const current = (await call(r + '/cells/' + property)).data;
  return call(r + '/cells/' + property, 'PATCH', {
    expectedSchemaVersion: schema,
    expectedCellVersion: current.version,
    value,
  });
};
await set(fields.text, 'Texte trouvable mémoiretest');
await set(fields.number, '12.50');
await set(fields.checkbox, false);
await set(fields.date, { start: '2026-10-27', end: null });
await set(fields.url, 'https://example.test/');
```

Select reçoit un ID d'option, multi-select un tableau d'IDs. Relation et personne reçoivent `{add:[id],remove:[]}` ou `{clearVisible:true}`. Pour la relation, créer une ligne de la base cible et utiliser son ID. Pour une personne, lire le sélecteur `POST b + '/properties/' + fields.person + '/choices'` avec `{}` ; les IDs sont des références de personne, pas les IDs de comptes.

## 3. Lire, filtrer et provoquer un conflit

```js
await call(b + '/query', 'POST', {
  filters: [{ field: fields.text, op: 'contains', value: 'mémoiretest' }],
  sorts: [{ field: fields.number, direction: 'asc' }],
  pageSize: 50,
});
await call('/search?q=mémoiretest');
var old = (await call(r + '/cells/' + fields.text)).data;
await set(fields.text, 'Texte mémoiretest modifié');
await call(r + '/cells/' + fields.text, 'PATCH', {
  expectedSchemaVersion: schema,
  expectedCellVersion: old.version,
  value: 'Ancienne saisie',
}); // 409, aucune écriture silencieuse
```

Créer quelques lignes supplémentaires pour tester `pageSize:1`. Reprendre la même requête avec le `cursor` retourné ; changer le tri tout en gardant ce curseur doit donner 409. Changer une définition avec un ancien `expectedSchemaVersion` doit aussi donner 409. Tester une valeur `javascript:` pour URL : refus, aucune requête réseau vers cette adresse.

## 4. Comparer A et B

Dans A, partager **seulement** la page conteneur Tâches 6b à l'invité B, en lecture. Dans B, recopier les IDs `base.id`, `row` et des propriétés, puis utiliser le même client. `GET b`, `POST b/query`, `GET r` et les cellules sont lisibles ; l'écriture donne 404. La base Références privées est absente de sa liste. La cellule relation fournit `{items:[],hasHidden:true}`, sans titre ni ID de sa cible ; son sélecteur est vide.

Passer B en édition depuis A. B peut modifier deux cellules et le titre (`PATCH r`, `{expectedVersion:'1',title:'…'}`), créer une ligne ; il ne peut pas créer de propriété, modifier les options/la vue commune, archiver ou modifier la liste assignable. `clearVisible` sur la relation ne supprime pas la cible masquée : A la voit toujours. Deux cellules distinctes modifiées dans A/B réussissent, deux modifications fondées sur la même version de cellule produisent un 409.

Pour la liste assignable, A obtient une preuve forte récente dans l'écran Sécurité, puis `PUT b + '/assignable-people'` avec `{expectedSchemaVersion:schema,people:[id]}`. Sans preuve récente, la route refuse ; cette console ne remplace pas le futur guidage de l'interface. Mettre à jour `schema`. B ne voit que la liste choisie et lui-même dans le sélecteur, sans emails.

## 5. Cycle de vie, collaboration et cache

`POST r + '/archive'` avec la version actuelle de `GET r`, puis `GET b + '/trash?pageSize=50'`. Restaurer avec `POST r + '/restore'` et la version de corbeille. Une ligne archivée n'apparaît plus dans requête/recherche et son ouverture collaborative est refusée. Les capacités ne sont pas libérées avant purge.

`POST r + '/collaboration'` retourne l'identité, la salle, les révisions et `rowScope` ; le WSS doit réutiliser cette portée. Le test manuel de l'éditeur de ligne attend 6c. Pour vérifier dès 6b la convergence, la lecture seule réellement hostile, la fermeture ciblée, le cache dans deux onglets et l'arrêt brutal du worker :

```powershell
node scripts/build-server.mjs api --database-services-e2e
node --env-file=.env apps/api/dist/database-services.e2e.mjs
```

Attendre le résumé **10 tests réussis, zéro échec**. Ce test utilise le service réel, un Caddy temporaire avec vérification TLS et Edge sur Windows ; les comptes et données sont synthétiques. Les messages `READ_ONLY`, `ACCESS_DENIED` et fermeture sont attendus pour les attaques. Il ne remplace pas les essais visuels et la revue finale de 6c/6d.

L'outbox peut être inspectée en SQL en lecture seule : `type`, `aggregate_id`, `aggregate_version`, `payload` de `outbox_events`. Attendre la fenêtre et une projection à jour. Attendu : `database.row.created` une fois, puis des `database.row.updated` regroupés, contenant IDs et révisions seulement. Les événements ne sont pas livrés à des webhooks à ce stade.

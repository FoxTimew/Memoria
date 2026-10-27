import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import assert from 'node:assert/strict';
import { loadProfile } from './profiles.ts';
import { testDatabase } from './database.ts';
import { decodeDocument } from '../codec.ts';
import { Leadership } from '../service/leadership.ts';
import { Store } from '../service/store.ts';
import { IncrementalValidator } from '../service/incremental-validator.ts';
import { ValidationPool } from '../service/validation-pool.ts';
import { readCollabConfig } from '../service/config.ts';
import { readMemorySnapshot, assertMemoryStage } from '../../../../scripts/measurement-memory.mjs';
test(
  'Production incremental validation and journal, 1 MiB profiles',
  { timeout: 120000 },
  async () => {
    const db = await testDatabase(),
      leader = new Leadership(db.url, () => {});
    await leader.start();
    const validators = new ValidationPool(readCollabConfig().COLLAB_VALIDATION_WORKERS),
      store = new Store(db.pool, leader),
      reports: object[] = [];
    try {
      const guestDepth = Number(process.env.COLLAB_MEASURE_GUEST_DEPTH ?? 0);
      if (guestDepth) {
        assert([5, 50].includes(guestDepth), 'Only documented guest profiles');
        const roots = Array.from({ length: 100 }, () => randomUUID());
        await db.client.query('BEGIN');
        try {
          const factor = randomUUID();
          await db.client.query(
            "INSERT INTO auth_passkeys(id,user_id,public_key,credential_id,counter,device_type,backed_up) VALUES($1,$2,'measurement-only',$3,0,'singleDevice',false)",
            [factor, db.user, randomUUID()],
          );
          await db.client.query(
            "INSERT INTO session_assurance(session_id,method,verified_at,security_version,factor_id) VALUES($1,'passkey',now(),0,$2)",
            [db.session, factor],
          );
          await db.client.query(
            'INSERT INTO workspace_policies(workspace_id,require_strong_auth,grace_days,strong_auth_enabled_at) VALUES($1,true,0,now())',
            [db.workspace],
          );
          await db.client.query(
            "UPDATE workspace_members SET role='guest' WHERE workspace_id=$1 AND user_id=$2",
            [db.workspace, db.user],
          );
          for (let i = 0; i < 100; i++)
            await db.client.query(
              'INSERT INTO pages(id,workspace_id,parent_id,position) VALUES($1,$2,$3,$4)',
              [roots[i], db.workspace, i > 0 && i < guestDepth - 1 ? roots[i - 1] : null, 'p' + i],
            );
          await db.client.query('UPDATE pages SET parent_id=$1 WHERE id=$2', [
            roots[guestDepth - 2],
            db.page,
          ]);
          // Bound profile: 50 guests x 100 roots = 5000 active grants. Only the
          // measured author has a live session; this is resolver load, not 50 writers.
          if (guestDepth === 50)
            for (let i = 0; i < 49; i++) {
              const user = randomUUID();
              await db.client.query(
                "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Load guest',$2,true)",
                [user, user + '@example.test'],
              );
              await db.client.query(
                "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'guest')",
                [db.workspace, user],
              );
            }
          await db.client.query(
            "INSERT INTO access_subjects(workspace_id,kind,member_id) SELECT workspace_id,'member',id FROM workspace_members WHERE workspace_id=$1",
            [db.workspace],
          );
          const subjects = (
            await db.client.query(
              'SELECT id FROM access_subjects WHERE workspace_id=$1 AND deleted_at IS NULL',
              [db.workspace],
            )
          ).rows;
          for (const subject of subjects)
            await db.client.query(
              "INSERT INTO access_grants(workspace_id,subject_id,resource_type,resource_id,level,inherit) SELECT $1,$2,'page',id,'edit',true FROM unnest($3::uuid[]) id",
              [db.workspace, subject.id, roots.slice(0, guestDepth === 50 ? 100 : 10)],
            );
          assert.equal(
            (
              await db.client.query(
                'SELECT count(*)::int n FROM access_grants WHERE workspace_id=$1',
                [db.workspace],
              )
            ).rows[0].n,
            guestDepth === 50 ? 5000 : 10,
          );
          await db.client.query('COMMIT');
        } catch (e) {
          await db.client.query('ROLLBACK');
          throw e;
        }
      }
      // Outside the timed region: browser identity carries a page epoch since 5d.
      // The main reference has no epoch feature; its authentic session/MFA checks remain enabled.
      const accessVersion =
        process.env.COLLAB_MEASURE_PAGE_EPOCH === 'true' || guestDepth
          ? ((
              await db.pool.query(
                'SELECT e.version FROM page_access_state e JOIN workspace_members m ON m.id=e.member_id WHERE e.workspace_id=$1 AND e.page_id=$2 AND m.user_id=$3',
                [db.workspace, db.page, db.user],
              )
            ).rows[0].version as number)
          : undefined;
      for (const profile of ['content-1M', 'history-1M']) {
        const snapshot = await loadProfile(profile),
          generation = randomUUID();
        const doc = new Y.Doc();
        doc.getXmlFragment('prosemirror');
        Y.applyUpdate(doc, snapshot);
        await db.pool.query('DELETE FROM collaboration_documents WHERE page_id=$1', [db.page]);
        await db.pool.query(
          'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,$6)',
          [
            db.page,
            db.workspace,
            generation,
            snapshot,
            snapshot.length,
            Buffer.byteLength(JSON.stringify(decodeDocument(doc))),
          ],
        );
        const replica = new IncrementalValidator(validators),
          samples: object[] = [];
        await replica.init(snapshot);
        const memory =
          process.env.COLLAB_MEASURE_HYGIENE === 'true' ? readMemorySnapshot() : undefined;
        if (memory) assertMemoryStage(memory, 'after-preparation');
        const nodes = [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)],
          texts = nodes.filter((n): n is Y.XmlText => n instanceof Y.XmlText),
          cards = nodes.filter(
            (n): n is Y.XmlElement =>
              n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
          );
        try {
          for (let i = 0; i < 220; i++) {
            let update!: Uint8Array;
            const capture = (u: Uint8Array) => {
              update = u;
            };
            doc.on('update', capture);
            doc.transact(() => {
              if (i % 4 === 0)
                cards[i % cards.length]!.setAttribute('health', (200 + i) as unknown as string);
              else if (i % 4 === 1) texts[i % texts.length]!.delete(0, 1);
              else texts[i % texts.length]!.insert(0, 'x');
            });
            doc.off('update', capture);
            const start = performance.now(),
              validated = await replica.prepare(update),
              validatedAt = performance.now();
            await store.append(
              generation,
              i,
              [
                {
                  identity: {
                    ...db,
                    key: db.user,
                    ...(accessVersion === undefined ? {} : { accessVersion }),
                  },
                  receipt: randomUUID(),
                  update,
                },
              ],
              update,
              validated.blocks,
              validated.blockIdsToReserve,
            );
            const committedAt = performance.now();
            await replica.commit();
            if (i >= 20)
              samples.push({
                validation: validatedAt - start,
                transaction: committedAt - validatedAt,
                total: performance.now() - start,
              });
          }
          const totals = (samples as { total: number }[]).map((s) => s.total).sort((a, b) => a - b),
            p95 = totals[189]!;
          const preparedPlans = (
            await db.pool.query(
              'SELECT name,generic_plans,custom_plans FROM pg_prepared_statements ORDER BY name',
            )
          ).rows;
          const report = {
            profile,
            memoryAfterPreparation: memory,
            guestDepth,
            p95,
            max: totals.at(-1),
            iterations: 200,
            warmup: 20,
            preparedPlans,
            samples,
          };
          reports.push(report);
          console.log(JSON.stringify({ ...report, samples: 200 }));
        } finally {
          await replica.close();
          doc.destroy();
        }
      }
      await writeFile(
        '.local/3a-warm-production.json',
        JSON.stringify(
          {
            date: new Date().toISOString(),
            scope:
              'Worker prepare + production fenced journal transaction including ID reservation + replica commit. No projection, socket, network or queue.',
            reports,
          },
          null,
          2,
        ),
      );
      for (const report of reports as { profile: string; p95: number }[])
        assert(
          report.profile === 'history-1M' ? report.p95 <= 100 : report.p95 < 50,
          `${report.profile}: p95=${report.p95}`,
        );
    } finally {
      await validators.close();
      await leader.close();
      await db.close();
    }
  },
);

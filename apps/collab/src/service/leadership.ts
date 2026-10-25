import pg from 'pg';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
const namespace = 1296387393;
export interface Fence {
  owner: string;
  epoch: number;
  pid: number;
}
/** The dedicated connection owns the lock. Pool connections fence every write transaction. */
export class Leadership {
  private readonly control: pg.Client;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private token: Fence | undefined;
  private stopped = false;
  private acknowledged = 0;
  private heartbeat: Promise<void> | undefined;
  constructor(
    url: string,
    private readonly onLost: () => void,
  ) {
    this.control = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 1500,
      query_timeout: 1500,
    });
    this.control.on('error', () => this.lose());
    this.control.on('end', () => this.lose());
  }
  async start() {
    try {
      await this.control.connect();
      const lock = await this.control.query(
        'SELECT pg_try_advisory_lock($1,hashtext(current_schema())) AS acquired',
        [namespace],
      );
      if (!lock.rows[0].acquired) throw new Error('COLLAB_LEADER_EXISTS');
      const owner = randomUUID();
      const row = (
        await this.control.query(
          `INSERT INTO collaboration_leadership(id,owner,epoch,backend_pid,lease_until) VALUES(1,$1,1,pg_backend_pid(),clock_timestamp()+interval '3 seconds') ON CONFLICT(id) DO UPDATE SET owner=EXCLUDED.owner,epoch=collaboration_leadership.epoch+1,backend_pid=EXCLUDED.backend_pid,lease_until=EXCLUDED.lease_until RETURNING epoch,backend_pid`,
          [owner],
        )
      ).rows[0];
      this.token = { owner, epoch: Number(row.epoch), pid: Number(row.backend_pid) };
      this.acknowledged = Date.now();
      this.schedule();
      return this.fence;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  get fence() {
    if (this.stopped || !this.token || Date.now() - this.acknowledged > 2500)
      throw new Error('COLLAB_LEADERSHIP_LOST');
    return this.token;
  }
  private schedule() {
    this.timer = setTimeout(() => {
      this.heartbeat = this.renew().finally(() => {
        this.heartbeat = undefined;
      });
    }, 500);
  }
  private async renew() {
    if (this.stopped) return;
    try {
      const result = await this.control.query(
        "UPDATE collaboration_leadership SET lease_until=clock_timestamp()+interval '3 seconds' WHERE id=1 AND owner=$1 AND epoch=$2",
        [this.token!.owner, this.token!.epoch],
      );
      if (result.rowCount !== 1) throw new Error('Fence replaced');
      this.acknowledged = Date.now();
      if (!this.stopped) this.schedule();
    } catch {
      this.lose();
    }
  }
  private lose() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.onLost();
    void this.control.end().catch(() => {});
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.heartbeat;
    await this.control.end().catch(() => {});
  }
}
/** Caller must BEGIN first and retain this shared row lock through COMMIT. No workspace lock. */
export async function assertFence(client: PoolClient, fence: Fence) {
  const result = await client.query({
    name: 'collaboration-assert-fence-v1',
    text: `SELECT l.id FROM collaboration_leadership l WHERE id=1 AND owner=$1 AND epoch=$2 AND lease_until>clock_timestamp()
 AND EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND pid=l.backend_pid AND classid=$3::oid AND objid=(hashtext(current_schema())::bigint & 4294967295)::oid AND objsubid=2) FOR SHARE OF l`,
    values: [fence.owner, fence.epoch, namespace],
  });
  if (result.rowCount !== 1) throw new Error('COLLAB_LEADERSHIP_LOST');
}

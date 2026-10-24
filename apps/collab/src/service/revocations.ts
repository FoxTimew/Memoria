import pg from 'pg';
/** LISTEN is a prompt signal only. Periodic SQL recheck also covers expiry and missed signals. */
export class Revocations {
  private readonly control: pg.Client;
  private schema = '';
  private stopped = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  private pulse: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> | undefined;
  private again = false;
  private pinging = false;
  constructor(
    url: string,
    private readonly recheck: () => Promise<void>,
    private readonly fail: () => void,
    private readonly fallbackMs = 5000,
  ) {
    this.control = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 1500,
      query_timeout: 1500,
    });
    this.control.on('error', () => this.failed());
    this.control.on('end', () => this.failed());
    this.control.on('notification', (event) => {
      try {
        const payload = JSON.parse(event.payload ?? '{}') as { schema?: string };
        if (payload.schema === this.schema) this.request();
      } catch {
        this.failed();
      }
    });
  }
  async start() {
    try {
      await this.control.connect();
      this.schema = (await this.control.query('SELECT current_schema() AS schema')).rows[0].schema;
      await this.control.query('LISTEN memoria_collaboration');
      this.poll = setInterval(() => this.request(), this.fallbackMs);
      this.pulse = setInterval(() => {
        if (this.pinging || this.stopped) return;
        this.pinging = true;
        void this.control
          .query('SELECT 1')
          .catch(() => this.failed())
          .finally(() => {
            this.pinging = false;
          });
      }, 1000);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  request() {
    if (this.stopped) return;
    if (this.checking) {
      this.again = true;
      return;
    }
    this.checking = this.recheck()
      .catch(() => this.failed())
      .finally(() => {
        this.checking = undefined;
        if (this.again) {
          this.again = false;
          this.request();
        }
      });
  }
  private failed() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.poll);
    clearInterval(this.pulse);
    this.fail();
    void this.control.end().catch(() => {});
  }
  async close() {
    this.stopped = true;
    clearInterval(this.poll);
    clearInterval(this.pulse);
    await this.checking;
    await this.control.end().catch(() => {});
  }
}

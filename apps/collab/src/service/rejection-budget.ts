/** Rejection history survives socket reconnects for this authenticated user in the room. */
export class RejectionBudget {
  private users = new Map<string, { count: number; since: number; blockedUntil: number }>();
  constructor(
    private readonly now = () => Date.now(),
    readonly maximum = 3,
    readonly windowMs = 60000,
  ) {}
  blocked(user: string) {
    const entry = this.users.get(user);
    if (!entry) return false;
    if (this.now() - entry.since >= this.windowMs && entry.blockedUntil <= this.now()) {
      this.users.delete(user);
      return false;
    }
    return entry.blockedUntil > this.now();
  }
  reject(user: string) {
    for (const [key, entry] of this.users)
      if (this.now() - entry.since >= this.windowMs && entry.blockedUntil <= this.now())
        this.users.delete(key);
    const entry = this.users.get(user) ?? { count: 0, since: this.now(), blockedUntil: 0 };
    entry.count++;
    if (entry.count >= this.maximum) entry.blockedUntil = this.now() + this.windowMs;
    this.users.set(user, entry);
  }
}

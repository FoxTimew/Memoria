import * as Y from 'yjs';
import {
  AccessChanged,
  CacheForbidden,
  LocalSessionRevoked,
  logoutMarker,
  yjsCache,
} from './yjs-cache.ts';
import { cachePolicyEvent } from './cache-policy.ts';
import type { CachePage, CacheTicket, YjsCache } from './yjs-cache.ts';
import { onLocalSignOut } from './local-sign-out.ts';
import type { CollaborationClient } from './collaboration-client.ts';

export class CollaborationCache {
  private chain: Promise<void> = Promise.resolve();
  private tokens = new Map<number, string[]>();
  private outstanding = 0;
  private failed = '';
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  private unlisten: () => void;
  private acknowledgements = new Set<string>();
  private channel: BroadcastChannel | undefined;
  private changed = (update: Uint8Array, origin: unknown) => {
    const local = origin !== this.client.provider;
    const token = local ? crypto.randomUUID() : undefined;
    if (token) this.tokens.set(this.client.durable.sequence, [token]);
    void this.queue(() => this.store.append(this.ticket, this.page, update.slice(), token));
  };
  private wake = () => {
    if (this.closed) return;
    try {
      if (logoutMarker(this.ticket.user) !== this.ticket.marker) {
        this.revoked();
        return;
      }
    } catch {
      /* The transactional check also catches revoked epochs. */
    }
    void this.store
      .assertActive(this.ticket, this.page.workspace, this.page.page)
      .catch((error: unknown) => this.error(error));
  };
  constructor(
    private readonly client: CollaborationClient,
    readonly ticket: CacheTicket,
    readonly page: CachePage,
    updates: Uint8Array[],
    private readonly onChange: () => void,
    private readonly onRevoked: (message?: string) => void,
    private readonly store: YjsCache = yjsCache,
  ) {
    // Applying saved Yjs structs preserves client identities and deletions; never seed JSON.
    for (const update of updates) Y.applyUpdate(client.doc, update, client.provider);
    if (page.pending.length) {
      client.durable.edit();
      this.tokens.set(client.durable.sequence, [...page.pending]);
    }
    client.doc.on('update', this.changed);
    this.unlisten = onLocalSignOut(ticket.user, () => this.revoked());
    globalThis.addEventListener(cachePolicyEvent, this.wake);
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(cachePolicyEvent);
      this.channel.onmessage = this.wake;
    }
    for (const event of ['focus', 'pageshow', 'visibilitychange'])
      globalThis.addEventListener(event, this.wake);
    this.timer = setInterval(this.wake, 2000);
  }
  get state() {
    return {
      phase: this.failed
        ? ('error' as const)
        : this.outstanding
          ? ('saving' as const)
          : ('saved' as const),
      message: this.failed,
    };
  }
  private error(error: unknown) {
    if (error instanceof AccessChanged) this.client.stop('ACCESS_CHANGED');
    else if (error instanceof CacheForbidden) {
      this.close();
      this.client.disableCache();
    } else if (error instanceof LocalSessionRevoked) this.revoked();
    else {
      this.failed = error instanceof Error ? error.message : 'Stockage local indisponible.';
      this.onChange();
    }
  }
  private revoked() {
    if (this.closed) return;
    this.close();
    this.onRevoked();
  }
  private queue(work: () => Promise<void>) {
    if (this.closed) return Promise.resolve();
    this.outstanding++;
    this.onChange();
    const next = this.chain
      .then(work)
      .catch((e: unknown) => this.error(e))
      .finally(() => {
        this.outstanding--;
        this.onChange();
      });
    this.chain = next;
    return next;
  }
  acknowledge(sequence: number) {
    const entries = [...this.tokens].filter(([n]) => n <= sequence);
    const tokens = entries.flatMap(([, ids]) => ids).filter((id) => !this.acknowledgements.has(id));
    if (!tokens.length || this.closed || this.failed) return;
    for (const token of tokens) this.acknowledgements.add(token);
    void this.queue(async () => {
      try {
        await this.store.acknowledge(this.ticket, this.page, tokens);
        for (const [n, ids] of entries) {
          const remaining = (this.tokens.get(n) ?? ids).filter((id) => !tokens.includes(id));
          if (remaining.length) this.tokens.set(n, remaining);
          else this.tokens.delete(n);
        }
      } finally {
        for (const token of tokens) this.acknowledgements.delete(token);
      }
    });
  }
  retry() {
    const token = this.client.durable.dirty ? crypto.randomUUID() : undefined;
    if (token)
      this.tokens.set(this.client.durable.sequence, [
        ...(this.tokens.get(this.client.durable.sequence) ?? []),
        token,
      ]);
    const update = Y.encodeStateAsUpdate(this.client.doc);
    return this.queue(async () => {
      await this.store.append(this.ticket, this.page, update, token);
      this.failed = '';
    });
  }
  async discard() {
    this.close();
    await this.chain;
    await this.store.discard(this.ticket, this.page);
  }
  revokeAccess() {
    this.close();
    this.onRevoked('Votre accès a changé. Le document a été fermé.');
    // Hide the document immediately, then erase after any previously queued transactions.
    void this.chain
      .then(() => this.store.revokePage(this.ticket, this.page.workspace, this.page.page))
      .catch((error: unknown) => {
        if (!(error instanceof LocalSessionRevoked))
          this.onRevoked(
            'Le document a été fermé, mais sa copie locale n’a pas pu être effacée. Reconnectez-vous puis réessayez la déconnexion et le nettoyage avant de quitter ce poste partagé.',
          );
      });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.channel?.close();
    globalThis.removeEventListener(cachePolicyEvent, this.wake);
    this.unlisten();
    this.client.doc.off('update', this.changed);
    for (const event of ['focus', 'pageshow', 'visibilitychange'])
      globalThis.removeEventListener(event, this.wake);
  }
}

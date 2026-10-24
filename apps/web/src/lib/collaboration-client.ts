import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { HocuspocusProviderWebsocketConfiguration } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { DurableState } from './collaboration-state.ts';
import { presenceUserSchema } from '@memoria/contracts';
import { CollaborationCache } from './collaboration-cache.ts';
import type { CachePage, CacheTicket } from './yjs-cache.ts';

class OwnPresenceProvider extends HocuspocusProvider {
  override awarenessUpdateHandler(
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) {
    // Remote timeout cleanup must never be sent as an attempt to remove another user's cursor.
    const own = (ids: number[]) => ids.filter((id) => id === this.document.clientID);
    const filtered = {
      added: own(change.added),
      updated: own(change.updated),
      removed: own(change.removed),
    };
    if (filtered.added.length + filtered.updated.length + filtered.removed.length)
      super.awarenessUpdateHandler(filtered, origin);
  }
}

export type CollaborationStatus = {
  phase: 'connecting' | 'saved' | 'saving' | 'offline' | 'blocked';
  loaded: boolean;
  dirty: boolean;
  revision: number;
  message: string;
  local: { phase: 'none' | 'saving' | 'saved' | 'error'; message: string };
  people: { id: string; name: string; color: string }[];
};
export function collaborationError(code: string) {
  if (code.includes('MEMORY_CAPACITY'))
    return 'Trop de pages sont ouvertes sur le serveur. Fermez-en une ou réessayez plus tard.';
  if (code.includes('GENERATION_CHANGED'))
    return 'Cette page a été réinitialisée. Exportez vos modifications avant de recharger.';
  if (/ACCESS|SESSION|READ_ONLY|permission/i.test(code))
    return 'Votre accès a changé ou votre session a expiré. L’édition est arrêtée.';
  if (/QUOTA|CAPACITY|RATE|QUEUE|LIMIT/.test(code))
    return 'La limite du service a été atteinte. Exportez vos modifications puis rechargez la page.';
  return 'Le serveur a refusé une modification. Exportez le contenu avant de recharger la version enregistrée.';
}

/** Network receipts and local persistence are independent guarantees. */
export class CollaborationClient {
  readonly doc = new Y.Doc();
  readonly durable: DurableState;
  readonly socket: HocuspocusProviderWebsocket;
  readonly provider: HocuspocusProvider;
  cache?: CollaborationCache;
  private connected = false;
  private disconnected = false;
  private loaded = false;
  private blocked = '';
  private destroyed = false;
  private listeners = new Set<(state: CollaborationStatus) => void>();
  private timer: ReturnType<typeof setInterval>;
  private offline = () => {
    this.connected = false;
    this.disconnected = true;
    this.socket.disconnect();
    this.emit();
  };
  private online = () => {
    void this.recheck().then(() => this.connect());
  };
  private edit = (_update: Uint8Array, origin: unknown) => {
    if (origin !== this.provider && !this.destroyed) this.durable.edit();
  };
  constructor(
    readonly room: string,
    readonly generation: string,
    config: HocuspocusProviderWebsocketConfiguration,
    private readonly verifyAccess?: () => Promise<void>,
    readonly user?: { id: string; name: string; color: string },
    expectedSession?: string,
  ) {
    this.doc.getXmlFragment('prosemirror');
    this.durable = new DurableState(generation, () => this.emit());
    this.doc.on('update', this.edit);
    const tracker = this.durable;
    this.socket = new (class extends HocuspocusProviderWebsocket {
      override send(message: Uint8Array) {
        // Do not keep an unbounded offline wire queue. Reconnection sends the Yjs diff.
        if (this.webSocket?.readyState !== 1) return;
        tracker.sent(message);
        super.send(message);
      }
    })({
      ...config,
      autoConnect: false,
      minDelay: 1000,
      maxDelay: 5000,
      messageReconnectTimeout: 45000,
    });
    this.provider = new OwnPresenceProvider({
      name: room,
      document: this.doc,
      websocketProvider: this.socket,
      ...(user ? {} : { awareness: null }),
      token:
        expectedSession && user ? JSON.stringify({ user: user.id, session: expectedSession }) : '',
      flushDelay: 100,
      forceSyncInterval: 15000,
      onOpen: () => {
        this.connected = true;
        this.disconnected = false;
        this.durable.reconnect();
        if (this.user) this.provider.awareness?.setLocalStateField('user', this.user);
        this.emit();
      },
      onSynced: ({ state }) => {
        if (state) this.loaded = true;
        this.emit();
      },
      onStateless: ({ payload }) => this.durable.received(payload),
      onAwarenessChange: () => this.emit(),
      onAuthenticationFailed: ({ reason }) => this.stop(reason),
      onClose: ({ event }) => {
        this.connected = false;
        this.disconnected = true;
        if (event.code === 1008) this.stop(event.reason);
        else {
          this.emit();
          void this.recheck();
        }
      },
    });
    this.provider.attach();
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this.offline);
      window.addEventListener('online', this.online);
    }
    this.timer = setInterval(() => {
      // Also covers a missed close event and cookie expiry during a network interruption.
      if (!this.connected) void this.recheck();
    }, 15000);
  }
  get state(): CollaborationStatus {
    const people = new Map<string, { id: string; name: string; color: string }>();
    if (this.connected)
      for (const state of this.provider?.awareness?.getStates().values() ?? []) {
        const user = presenceUserSchema.safeParse(state.user);
        if (user.success) people.set(user.data.id, user.data);
      }
    return {
      phase: this.blocked
        ? 'blocked'
        : !this.connected
          ? this.disconnected
            ? 'offline'
            : 'connecting'
          : !this.loaded
            ? 'connecting'
            : this.durable.dirty || !this.durable.confirmed
              ? 'saving'
              : 'saved',
      loaded: this.loaded,
      dirty: this.durable.dirty,
      revision: this.durable.revision,
      message: this.blocked,
      local: this.cache?.state ?? { phase: 'none', message: '' },
      people: [...people.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  subscribe(listener: (state: CollaborationStatus) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    this.cache?.acknowledge(this.durable.acknowledged);
    if (!this.destroyed) for (const listener of this.listeners) listener(this.state);
  }
  private async recheck() {
    if (this.destroyed || this.blocked || !this.verifyAccess) return;
    try {
      await this.verifyAccess();
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        [401, 403, 404, 409].includes(Number(error.status))
      )
        this.stop('ACCESS_DENIED');
    }
  }
  stop(reason: string) {
    if (this.destroyed) return;
    if (this.cache && /ACCESS|SESSION|permission/i.test(reason)) {
      this.cache.revokeAccess();
      return;
    }
    this.blocked = collaborationError(reason);
    this.socket.disconnect();
    this.emit();
  }
  connect() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.offline();
      return;
    }
    if (!this.destroyed && !this.blocked) void this.socket.connect().catch(() => this.emit());
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cache?.close();
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this.offline);
      window.removeEventListener('online', this.online);
    }
    clearInterval(this.timer);
    this.doc.off('update', this.edit);
    this.listeners.clear();
    // Detach before destroy so an explicit abandonment never flushes a last queued update.
    this.provider.detach();
    this.provider.destroy();
    this.socket.destroy();
    this.doc.destroy();
  }
  attachCache(
    ticket: CacheTicket,
    page: CachePage,
    updates: Uint8Array[],
    onRevoked: (message?: string) => void,
  ) {
    this.cache = new CollaborationCache(
      this,
      ticket,
      page,
      updates,
      () => this.emit(),
      (message) => {
        this.destroy();
        onRevoked(message);
      },
    );
  }
}

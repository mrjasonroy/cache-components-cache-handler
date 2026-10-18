/**
 * In-memory stand-in for the ioredis client surface the ISR RedisCacheHandler
 * uses. Records TTLs and every command so tests can assert what reached Redis.
 */
export class FakeRedis {
  readonly store = new Map<string, { value: string; ttl?: number }>();
  readonly sets = new Map<string, Set<string>>();
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly commands: string[] = [];
  quitCalled = false;

  async get(key: string): Promise<string | null> {
    this.commands.push("get");
    return this.store.get(key)?.value ?? null;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    this.commands.push("mget");
    return keys.map((key) => this.store.get(key)?.value ?? null);
  }

  async set(key: string, value: string, mode?: string, ttl?: number): Promise<string> {
    this.commands.push("set");
    this.store.set(key, { value, ttl: mode === "EX" ? ttl : undefined });
    return "OK";
  }

  async setex(key: string, ttl: number, value: string): Promise<string> {
    this.commands.push("setex");
    this.store.set(key, { value, ttl });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.commands.push("del");
    return this.remove(keys);
  }

  async unlink(...keys: string[]): Promise<number> {
    this.commands.push("unlink");
    return this.remove(keys);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.commands.push("sadd");
    const set = this.sets.get(key) ?? new Set<string>();
    this.sets.set(key, set);
    const before = set.size;
    for (const member of members) set.add(member);
    return set.size - before;
  }

  async smembers(key: string): Promise<string[]> {
    this.commands.push("smembers");
    return Array.from(this.sets.get(key) ?? []);
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    this.commands.push("expire");
    return 1;
  }

  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const pipeline = {
      set: (key: string, value: string, mode?: string, ttl?: number) => {
        ops.push(() => this.set(key, value, mode, ttl));
        return pipeline;
      },
      sadd: (key: string, ...members: string[]) => {
        ops.push(() => this.sadd(key, ...members));
        return pipeline;
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => this.expire(key, seconds));
        return pipeline;
      },
      del: (...keys: string[]) => {
        ops.push(() => this.del(...keys));
        return pipeline;
      },
      unlink: (...keys: string[]) => {
        ops.push(() => this.unlink(...keys));
        return pipeline;
      },
      exec: async () => {
        const results: Array<[null, unknown]> = [];
        for (const op of ops) {
          results.push([null, await op()]);
        }
        return results;
      },
    };
    return pipeline;
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(...args);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  async quit(): Promise<string> {
    this.quitCalled = true;
    return "OK";
  }

  getStored(key: string): { value: string; ttl?: number } | undefined {
    return this.store.get(key);
  }

  /** Every key, strings and sets alike, as `KEYS *` would list them. */
  keys(): string[] {
    return [...this.store.keys(), ...this.sets.keys()];
  }

  private remove(keys: string[]): number {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key) || this.sets.delete(key)) count++;
    }
    return count;
  }
}

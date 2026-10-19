/**
 * An in-memory stand-in for the ioredis commands the handlers use. Several handler sets can share
 * one instance to simulate several Next instances on one Redis. Test-only; not built.
 */

import { EventEmitter } from "node:events";

type Value = Buffer | Map<string, string> | Map<string, number>;

interface Item {
  value: Value;
  expiresAt?: number;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      source += `\\${pattern[++i] ?? ""}`;
    } else if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export class FakeRedis extends EventEmitter {
  status = "ready";
  /** Pass another fake's `items` to simulate a second instance on the same Redis. */
  constructor(readonly items: Map<string, Item> = new Map()) {
    super();
  }
  /** Set to make every command reject. */
  failWith: Error | undefined;
  readonly commands: string[] = [];
  /** Batches of commands sent together (issued in one synchronous run): round trips. */
  roundTrips = 0;
  private batchOpen = false;

  private live(key: string): Item | undefined {
    const item = this.items.get(key);
    if (item?.expiresAt !== undefined && Date.now() >= item.expiresAt) {
      this.items.delete(key);
      return undefined;
    }
    return item;
  }

  private run(name: string): void {
    this.commands.push(name);
    if (!this.batchOpen) {
      this.roundTrips++;
      this.batchOpen = true;
      queueMicrotask(() => {
        this.batchOpen = false;
      });
    }
    if (this.failWith) throw this.failWith;
    if (this.status !== "ready") throw new Error("Stream isn't writeable");
  }

  /** Simulate losing the connection. */
  goDown(): void {
    this.status = "reconnecting";
    this.emit("error", new Error("ECONNREFUSED"));
  }

  /** Simulate (re)connecting. */
  comeUp(): void {
    this.status = "ready";
    this.emit("ready");
  }

  /** Remaining TTL in seconds, -1 without expiry, -2 if missing. */
  ttlOf(key: string): number {
    const item = this.live(key);
    if (!item) return -2;
    if (item.expiresAt === undefined) return -1;
    return Math.ceil((item.expiresAt - Date.now()) / 1000);
  }

  async get(key: string): Promise<string | null> {
    this.run("get");
    const value = this.live(key)?.value;
    return value instanceof Buffer ? value.toString() : null;
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    this.run("getBuffer");
    const value = this.live(key)?.value;
    return value instanceof Buffer ? value : null;
  }

  async set(key: string, value: string | Buffer, ...args: unknown[]): Promise<"OK" | null> {
    this.run("set");
    if (args.includes("NX") && this.live(key)) return null;
    const item: Item = { value: Buffer.isBuffer(value) ? value : Buffer.from(value) };
    if (args[0] === "EX") item.expiresAt = Date.now() + Number(args[1]) * 1000;
    this.items.set(key, item);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.run("del");
    return keys.filter((key) => this.items.delete(key)).length;
  }

  async unlink(...keys: string[]): Promise<number> {
    this.run("unlink");
    return keys.filter((key) => this.items.delete(key)).length;
  }

  async exists(key: string): Promise<number> {
    return this.live(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.run("expire");
    const item = this.live(key);
    if (!item) return 0;
    item.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    this.run("hset");
    // As Redis: `HSET key` with no field is an error.
    if (Object.keys(fields).length === 0) {
      throw new Error("ERR wrong number of arguments for 'hset' command");
    }
    let item = this.live(key);
    if (!item || !(item.value instanceof Map)) {
      item = { value: new Map<string, string>() };
      this.items.set(key, item);
    }
    const hash = item.value as Map<string, string>;
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
    return Object.keys(fields).length;
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    this.run("hmget");
    const value = this.live(key)?.value;
    const hash = value instanceof Map ? (value as Map<string, string>) : undefined;
    return fields.map((field) => hash?.get(field) ?? null);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    this.run("hdel");
    const value = this.live(key)?.value;
    if (!(value instanceof Map)) return 0;
    return fields.filter((field) => (value as Map<string, string>).delete(field)).length;
  }

  async hlen(key: string): Promise<number> {
    const value = this.live(key)?.value;
    return value instanceof Map ? value.size : 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.run("hgetall");
    const value = this.live(key)?.value;
    return value instanceof Map ? Object.fromEntries(value as Map<string, string>) : {};
  }

  private zset(key: string, create: boolean): Map<string, number> | undefined {
    const item = this.live(key);
    if (item?.value instanceof Map) return item.value as Map<string, number>;
    if (!create) return undefined;
    const zset = new Map<string, number>();
    this.items.set(key, { value: zset });
    return zset;
  }

  private sorted(key: string): [string, number][] {
    return [...(this.zset(key, false) ?? new Map<string, number>())].sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    );
  }

  async zadd(key: string, ...scoreMembers: (string | number)[]): Promise<number> {
    this.run("zadd");
    if (scoreMembers.length === 0)
      throw new Error("ERR wrong number of arguments for 'zadd' command");
    const zset = this.zset(key, true);
    for (let i = 0; i + 1 < scoreMembers.length; i += 2) {
      zset?.set(String(scoreMembers[i + 1]), Number(scoreMembers[i]));
    }
    return scoreMembers.length / 2;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    this.run("zrem");
    const zset = this.zset(key, false);
    return members.filter((member) => zset?.delete(member)).length;
  }

  async zcard(key: string): Promise<number> {
    this.run("zcard");
    return this.zset(key, false)?.size ?? 0;
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    ...options: (string | number)[]
  ): Promise<string[]> {
    this.run("zrangebyscore");
    const bound = (value: number | string, infinite: string, inf: number) => {
      const text = String(value);
      if (text === infinite) return { at: inf, open: false };
      return text.startsWith("(")
        ? { at: Number(text.slice(1)), open: true }
        : { at: Number(text), open: false };
    };
    const low = bound(min, "-inf", Number.NEGATIVE_INFINITY);
    const high = bound(max, "+inf", Number.POSITIVE_INFINITY);
    let matched = this.sorted(key).filter(
      ([, score]) =>
        (low.open ? score > low.at : score >= low.at) &&
        (high.open ? score < high.at : score <= high.at),
    );
    const limit = options.indexOf("LIMIT");
    if (limit >= 0) {
      const offset = Number(options[limit + 1]);
      matched = matched.slice(offset, offset + Number(options[limit + 2]));
    }
    return options.includes("WITHSCORES")
      ? matched.flatMap(([member, score]) => [member, String(score)])
      : matched.map(([member]) => member);
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    this.run("zrange");
    const all = this.sorted(key);
    const end = stop < 0 ? all.length + stop : stop;
    return all.slice(start, end + 1).flatMap(([member, score]) => [member, String(score)]);
  }

  async zremrangebyscore(key: string, min: string, max: number): Promise<number> {
    this.run("zremrangebyscore");
    const zset = this.zset(key, false);
    if (!zset) return 0;
    let removed = 0;
    for (const [member, score] of zset) {
      if ((min === "-inf" || score >= Number(min)) && score <= max) {
        zset.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zremrangebyrank(key: string, start: number, stop: number): Promise<number> {
    this.run("zremrangebyrank");
    const zset = this.zset(key, false);
    if (!zset) return 0;
    const all = this.sorted(key);
    const end = stop < 0 ? all.length + stop : stop;
    const doomed = all.slice(start, end + 1);
    for (const [member] of doomed) zset.delete(member);
    return doomed.length;
  }

  async scan(_cursor: string, ...args: (string | number)[]): Promise<[string, string[]]> {
    this.run("scan");
    const pattern = globToRegExp(String(args[args.indexOf("MATCH") + 1]));
    return ["0", [...this.items.keys()].filter((key) => this.live(key) && pattern.test(key))];
  }

  /** Owned connections wrap this for the timeout watchdog; the fake's commands bypass it. */
  sendCommand(command: unknown): unknown {
    return command;
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }

  disconnect(): void {}
}

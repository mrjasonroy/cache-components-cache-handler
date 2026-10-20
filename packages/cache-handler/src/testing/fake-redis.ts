/**
 * An in-memory stand-in for the ioredis commands the handlers use. Several handler sets can share
 * one instance to simulate several Next instances on one Redis. Test-only; not built.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { nowMs } from "../shared/clock.js";
import { decodeRecord, encodeRecord } from "../shared/tag-store.js";
import { UPDATE_TAGS_SCRIPT, mergeUpdate } from "../shared/tag-update.js";

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
  /** Scripts this "server" has cached, by SHA1: EVALSHA of any other is NOSCRIPT. */
  private readonly scripts = new Set<string>();

  private live(key: string): Item | undefined {
    const item = this.items.get(key);
    if (item?.expiresAt !== undefined && nowMs() >= item.expiresAt) {
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

  /** Simulate losing the connection, with `error` as the reason. */
  goDown(error: Error = new Error("ECONNREFUSED")): void {
    this.status = "reconnecting";
    this.emit("error", error);
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
    return Math.ceil((item.expiresAt - nowMs()) / 1000);
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
    if (args[0] === "EX" && !(Number.isInteger(Number(args[1])) && Number(args[1]) > 0)) {
      // As Redis: EX takes a whole number of seconds greater than 0.
      throw new Error("ERR invalid expire time in 'set' command");
    }
    if (args.includes("NX") && this.live(key)) return null;
    const item: Item = { value: Buffer.isBuffer(value) ? value : Buffer.from(value) };
    if (args[0] === "EX") item.expiresAt = nowMs() + Number(args[1]) * 1000;
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
    item.expiresAt = nowMs() + seconds * 1000;
    return 1;
  }

  async hset(key: string, ...args: [Record<string, string>] | [string, string]): Promise<number> {
    this.run("hset");
    // ioredis takes the fields as an object or as one field and value.
    const fields = typeof args[0] === "string" ? { [args[0]]: args[1] as string } : args[0];
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

  /**
   * EVAL, for the one script the package sends ({@link UPDATE_TAGS_SCRIPT}), emulated in
   * TypeScript. The real script runs in the real-Redis suite.
   */
  async eval(script: string, numKeys: number, ...keysAndArgs: string[]): Promise<number> {
    this.run("eval");
    const sha = createHash("sha1").update(script).digest("hex");
    this.scripts.add(sha);
    return this.runScript(sha, numKeys, keysAndArgs);
  }

  async evalsha(sha: string, numKeys: number, ...keysAndArgs: string[]): Promise<number> {
    this.run("evalsha");
    if (!this.scripts.has(sha)) throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    return this.runScript(sha, numKeys, keysAndArgs);
  }

  /** `SCRIPT FLUSH`: the server forgets every cached script (a restart or failover does too). */
  async script(subcommand: "FLUSH"): Promise<"OK"> {
    this.run("script");
    if (subcommand === "FLUSH") this.scripts.clear();
    return "OK";
  }

  private runScript(sha: string, numKeys: number, keysAndArgs: string[]): number {
    const known = createHash("sha1").update(UPDATE_TAGS_SCRIPT).digest("hex");
    if (sha !== known || numKeys !== 1) throw new Error("FakeRedis: unknown script");
    const [key, ...args] = keysAndArgs;
    let item = this.live(key);
    if (!item || !(item.value instanceof Map)) {
      item = { value: new Map<string, string>() };
      this.items.set(key, item);
    }
    const hash = item.value as Map<string, string>;
    for (let i = 0; i + 2 < args.length; i += 3) {
      const [tag, stale, expired] = args.slice(i, i + 3);
      const update = { stale: Number(stale), ...(expired ? { expired: Number(expired) } : {}) };
      hash.set(tag, encodeRecord(mergeUpdate(decodeRecord(hash.get(tag)), update)));
    }
    return args.length / 3;
  }

  async zadd(key: string, ...args: (string | number)[]): Promise<number> {
    this.run("zadd");
    // GT: only ever raise a member's score (a new member is added).
    const gt = args[0] === "GT";
    const scoreMembers = gt ? args.slice(1) : args;
    if (scoreMembers.length === 0)
      throw new Error("ERR wrong number of arguments for 'zadd' command");
    const zset = this.zset(key, true);
    for (let i = 0; i + 1 < scoreMembers.length; i += 2) {
      const member = String(scoreMembers[i + 1]);
      const score = Number(scoreMembers[i]);
      const current = zset?.get(member);
      if (!gt || current === undefined || score > current) zset?.set(member, score);
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

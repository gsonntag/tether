import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { bedrockTableRates } from "../../shared/bedrockRates";
import type { BedrockModel, BedrockSettings } from "../../shared/credentials";
import type { SessionCost } from "../../shared/costs";

export const unpricedBedrock = (reason = "no-usage"): SessionCost => ({ estimated: true, complete: false, reasons: [reason] });
export const noBedrockCharge: SessionCost = { usd: 0, estimated: false, complete: true };

export function bedrockRates(settings: BedrockSettings, model: BedrockModel) {
  return model.rates ? { ...model.rates, cacheWriteLong: model.cacheWriteLong } : bedrockTableRates(settings.region, model);
}

export function priceBedrock(settings: BedrockSettings, model: BedrockModel, usage: any, tier?: string): SessionCost {
  if (tier && !["auto", "default", "standard"].includes(tier)) return unpricedBedrock("bedrock-rate");
  const rates = bedrockRates(settings, model);
  if (!rates) return unpricedBedrock("bedrock-rate");
  const output = usage?.output_tokens;
  const claude = model.harness === "claude";
  const cached = (claude ? usage?.cache_read_input_tokens : usage?.input_tokens_details?.cached_tokens) ?? 0;
  const details = usage?.input_tokens_details;
  const lifetime = claude ? usage?.cache_creation : details?.cache_write_tokens_details;
  const longCount = claude ? lifetime?.ephemeral_1h_input_tokens : lifetime?.ttl_12h_tokens;
  const shortCount = claude ? lifetime?.ephemeral_5m_input_tokens : lifetime?.ttl_30m_tokens;
  const totalWrites = claude ? usage?.cache_creation_input_tokens : details?.cache_write_tokens;
  const writes = totalWrites ?? ((longCount ?? 0) + (shortCount ?? 0));
  const ordinary = claude ? usage?.input_tokens : usage?.input_tokens - cached - writes;
  const validCount = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (![ordinary, output, cached, writes].every(validCount)) return unpricedBedrock();
  if (cached && rates.cached === undefined) return unpricedBedrock("no-cache-read-rate");
  if (writes && rates.cacheWrite === undefined) return unpricedBedrock("no-write-rate");
  const long = longCount ?? (writes && rates.cacheWriteLong !== undefined && shortCount !== writes ? undefined : 0);

  if (long !== undefined && (!validCount(long) || long > writes || (shortCount !== undefined && (!validCount(shortCount) || shortCount + long !== writes)))) return unpricedBedrock();
  if (long && rates.cacheWriteLong === undefined) return unpricedBedrock("no-write-rate");
  const shortRate = rates.cacheWrite ?? 0;
  const longRate = rates.cacheWriteLong ?? shortRate;
  const writeCost = long === undefined ? writes * Math.min(shortRate, longRate) : (writes - long) * shortRate + long * longRate;
  const usd = (ordinary * rates.input + output * rates.output + cached * (rates.cached ?? 0) + writeCost) / 1_000_000;
  return Number.isFinite(usd) ? {
    usd, estimated: true, complete: long !== undefined,
    ...(long === undefined ? { reasons: ["no-cache-ttl"] } : {}), ...(model.rates ? {} : { notes: ["bedrock-table"] }),
  } : unpricedBedrock();
}

/** A durable UTC-day ledger shared by live and terminal providers, even in different processes. */
export class BedrockSpend {
  private db: Database;
  constructor(credentialFile: string) {
    const directory = join(dirname(credentialFile), "bedrock");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new Database(join(directory, "spend.sqlite"));
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, day TEXT NOT NULL, began INTEGER NOT NULL, usd REAL, complete INTEGER
      );
      CREATE INDEX IF NOT EXISTS requests_day ON requests(day)`);
  }

  begin(id: string, limit?: number, now = Date.now()): boolean {
    const day = new Date(now).toISOString().slice(0, 10);
    const started = this.db.transaction(() => {
      if (limit !== undefined) {
        const total = this.db.query<{ usd: number; unknown: number }, [number, string]>(`
          SELECT COALESCE(SUM(usd), 0) AS usd,
            COUNT(CASE WHEN complete = 0 OR (complete IS NULL AND began < ?) THEN 1 END) AS unknown
          FROM requests WHERE day = ?
        `).get(now - 20 * 60_000, day)!;
        if (total.unknown || total.usd >= limit) return false;
      }
      this.db.run("INSERT INTO requests (id, day, began) VALUES (?, ?, ?)", [id, day, now]);
      return true;
    });
    return started.immediate();
  }

  finish(id: string, cost: SessionCost) {
    this.db.run("UPDATE requests SET usd = ?, complete = ? WHERE id = ?", [cost.usd ?? null, Number(cost.complete), id]);
  }
  close() { this.db.close(); }
}

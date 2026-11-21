import { appendFileSync, readFileSync } from "node:fs";

const seed = JSON.parse(readFileSync(process.env.RELAY_TEST_PG_SEED, "utf8"));
const noop = async () => ({ rows: [], rowCount: 1 });

class FakePool {
  async query(sql) {
    if (sql === "BEGIN") appendFileSync(process.env.RELAY_TEST_PG_WRITES, "saveDelta\n");
    if (sql.startsWith("INSERT INTO tasks(")) appendFileSync(process.env.RELAY_TEST_PG_WRITES, "task-upsert\n");
    if (sql.includes("SELECT * FROM tasks")) return { rows: seed.tasks };
    if (sql.includes("SELECT * FROM peers")) return { rows: seed.peers };
    if (sql.includes("SELECT * FROM events")) return { rows: seed.events };
    if (sql.includes("SELECT * FROM messages")) return { rows: seed.messages };
    if (sql.includes("SELECT * FROM kv")) return { rows: seed.kv };
    if (sql.includes("MAX(id) AS max_id")) return { rows: [{ max_id: seed.events.at(-1)?.id || 0 }] };
    return noop();
  }
  async connect() {
    return { query: this.query.bind(this), release() {}, on() {}, once() {} };
  }
  async end() {}
}

export { FakePool as Pool };

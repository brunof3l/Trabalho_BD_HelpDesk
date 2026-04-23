const sqlite3 = require("sqlite3");

function getSqliteFilePath() {
  return process.env.SQLITE_FILE || "./banco3_SQLite.sqlite";
}

function openSqliteDb() {
  const filePath = getSqliteFilePath();
  const db = new sqlite3.Database(filePath);
  db.serialize();
  return db;
}

function sqliteRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function sqliteGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

const BANCO3_SQLITE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS view_relatorios (
  status TEXT NOT NULL PRIMARY KEY,
  total INTEGER NOT NULL,
  atualizado_em TEXT NOT NULL
);
`;

async function ensureSqliteSchema(sqliteDb) {
  const statements = BANCO3_SQLITE_SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await sqliteRun(sqliteDb, statement);
  }
}

async function checkSqlite(sqliteDb) {
  await sqliteGet(sqliteDb, "SELECT 1 AS ok");
  return true;
}

async function initSqlite(sqliteDb) {
  await ensureSqliteSchema(sqliteDb);
  await checkSqlite(sqliteDb);
  return true;
}

module.exports = {
  getSqliteFilePath,
  openSqliteDb,
  ensureSqliteSchema,
  checkSqlite,
  initSqlite,
  BANCO3_SQLITE_SCHEMA_SQL,
};


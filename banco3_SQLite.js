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

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

const BANCO3_SQLITE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS relatorios (
  id INTEGER NOT NULL PRIMARY KEY,
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  status TEXT NOT NULL,
  data_criacao TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relatorios_status ON relatorios(status);
CREATE INDEX IF NOT EXISTS idx_relatorios_data ON relatorios(data_criacao);
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

async function upsertRelatorio(sqliteDb, relatorio) {
  await sqliteRun(
    sqliteDb,
    `
      INSERT INTO relatorios (id, titulo, descricao, status, data_criacao)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        titulo = excluded.titulo,
        descricao = excluded.descricao,
        status = excluded.status,
        data_criacao = excluded.data_criacao
    `,
    [
      relatorio.id,
      relatorio.titulo,
      relatorio.descricao,
      relatorio.status,
      relatorio.data_criacao,
    ]
  );
}

async function listRelatorios(sqliteDb, limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  return sqliteAll(
    sqliteDb,
    `
      SELECT id, titulo, descricao, status, data_criacao
      FROM relatorios
      ORDER BY data_criacao DESC
      LIMIT ?
    `,
    [safeLimit]
  );
}

module.exports = {
  getSqliteFilePath,
  openSqliteDb,
  ensureSqliteSchema,
  checkSqlite,
  initSqlite,
  upsertRelatorio,
  listRelatorios,
  sqliteRun,
  sqliteGet,
  sqliteAll,
  BANCO3_SQLITE_SCHEMA_SQL,
};

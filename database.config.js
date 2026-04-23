const mysql = require("mysql2/promise");
const sqlite3 = require("sqlite3");

function getMySqlConfig() {
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "auditoria_ti",
    port: Number(process.env.MYSQL_PORT || 3306),
  };
}

function createMySqlPool() {
  const { host, user, password, database, port } = getMySqlConfig();

  return mysql.createPool({
    host,
    user,
    password,
    database,
    port,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
  });
}

function getSqliteFilePath() {
  return process.env.SQLITE_FILE || "./read-model.sqlite";
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

const MYSQL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chamados (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  titulo VARCHAR(180) NOT NULL,
  descricao TEXT NOT NULL,
  status ENUM('ABERTO','EM_ANDAMENTO','CONCLUIDO','CANCELADO') NOT NULL DEFAULT 'ABERTO',
  data_criacao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_status_data (status, data_criacao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const SQLITE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS view_relatorios (
  status TEXT NOT NULL PRIMARY KEY,
  total INTEGER NOT NULL,
  atualizado_em TEXT NOT NULL
);
`;

async function ensureMySqlSchema(mysqlPool) {
  await mysqlPool.execute(MYSQL_SCHEMA_SQL);
}

async function ensureSqliteSchema(sqliteDb) {
  const statements = SQLITE_SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await sqliteRun(sqliteDb, statement);
  }
}

async function checkMySql(mysqlPool) {
  await mysqlPool.query("SELECT 1");
  return true;
}

async function checkSqlite(sqliteDb) {
  await sqliteGet(sqliteDb, "SELECT 1 AS ok");
  return true;
}

async function initMySql(mysqlPool) {
  const { host, user, password, database, port } = getMySqlConfig();
  const conn = await mysql.createConnection({ host, user, password, port });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } catch (e) {
    const code = e?.code || "";
    if (code !== "ER_ACCESS_DENIED_ERROR" && code !== "ER_DBACCESS_DENIED_ERROR") throw e;
  }
  await conn.end();

  await ensureMySqlSchema(mysqlPool);
  await checkMySql(mysqlPool);
  return true;
}

async function initSqlite(sqliteDb) {
  await ensureSqliteSchema(sqliteDb);
  await checkSqlite(sqliteDb);
  return true;
}

module.exports = {
  createMySqlPool,
  getMySqlConfig,
  getSqliteFilePath,
  openSqliteDb,
  ensureMySqlSchema,
  ensureSqliteSchema,
  checkMySql,
  checkSqlite,
  initMySql,
  initSqlite,
  MYSQL_SCHEMA_SQL,
  SQLITE_SCHEMA_SQL,
};

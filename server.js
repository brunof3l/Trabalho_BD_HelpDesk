const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const admin = require("firebase-admin");

const {
  createMySqlPool,
  getMySqlConfig,
  initMySql,
} = require("./banco2_mysql");

const { getSqliteFilePath, openSqliteDb, initSqlite } = require("./banco3_SQLite");
const { criarChamado, listarRelatorios, sincronizarChamadoParaSqlite } = require("./database");

function getFirebaseProjectId(serviceAccount) {
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    serviceAccount?.project_id ||
    "sistema-de-auditoria-de-ti"
  );
}

function initFirebaseAdmin() {
  if (admin.apps.length > 0) return;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson && serviceAccountJson.trim()) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: getFirebaseProjectId(serviceAccount),
    });
    return;
  }

  const serviceAccountFile =
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE ||
    path.join(__dirname, "serviceAccountKey.json");

  if (fs.existsSync(serviceAccountFile)) {
    const raw = fs.readFileSync(serviceAccountFile, "utf8");
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: getFirebaseProjectId(serviceAccount),
    });
    return;
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: getFirebaseProjectId(),
  });
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function corsDev(req, res, next) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

function readBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

async function requireAuth(req, res) {
  // Validação do token Firebase (ID Token) para proteger as rotas do dashboard
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "Token ausente" });
    return null;
  }

  try {
    return await admin.auth().verifyIdToken(token);
  } catch (err) {
    res.status(401).json({ ok: false, error: "Não autorizado" });
    return null;
  }
}

function httpJson(method, port, routePath, body) {
  return new Promise((resolve, reject) => {
    const rawBody = body ? Buffer.from(JSON.stringify(body), "utf8") : null;

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: routePath,
        method,
        headers: {
          "content-type": "application/json",
          ...(rawBody ? { "content-length": rawBody.length } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const parsed = (() => {
            try {
              return JSON.parse(data || "{}");
            } catch {
              return {};
            }
          })();
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        });
      }
    );

    req.on("error", reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

async function getMySqlHealth(mysqlPool) {
  try {
    await initMySql(mysqlPool);
    return { mysqlOk: true, mysqlError: null };
  } catch (e) {
    return { mysqlOk: false, mysqlError: e?.code || e?.message || "Erro" };
  }
}

async function getSqliteHealth(sqliteDb, sqliteFilePath) {
  try {
    await initSqlite(sqliteDb);
    const exists = fs.existsSync(sqliteFilePath);
    return {
      sqliteOk: exists,
      sqliteError: exists ? null : "Arquivo não encontrado",
    };
  } catch (e) {
    return { sqliteOk: false, sqliteError: e?.code || e?.message || "Erro" };
  }
}

function startAuthServer(port) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(corsDev);

  app.get("/health", (req, res) => {
    res.json({ ok: true, services: { firebaseOk: admin.apps.length > 0 } });
  });

  app.post("/auth", async (req, res) => {
    const token = req.body?.token;
    if (!token) return res.status(400).json({ ok: false, error: "token é obrigatório" });

    try {
      const decoded = await admin.auth().verifyIdToken(token);
      process.stdout.write(
        `[AUTH OK] uid=${decoded.uid} email=${decoded.email || ""} nome=${decoded.name || ""} token=${token}\n`
      );
      res.json({
        ok: true,
        user: {
          uid: decoded.uid,
          email: decoded.email || null,
          name: decoded.name || null,
        },
      });
    } catch (err) {
      const code = err?.errorInfo?.code || err?.code || null;
      const message = err?.message || "Falha ao validar token";
      const payload = decodeJwtPayload(token);
      const tokenInfo = payload
        ? {
            aud: payload.aud || null,
            iss: payload.iss || null,
            sub: payload.sub || null,
            user_id: payload.user_id || null,
            iat: payload.iat || null,
            exp: payload.exp || null,
          }
        : null;
      process.stderr.write(`Falha no AUTH /auth: ${code || ""} ${message}\n`);
      res.status(401).json({
        ok: false,
        error: "Não autorizado",
        details: { code, message, tokenInfo },
      });
    }
  });

  app.listen(port, () => {
    process.stdout.write(`Servidor AUTH (Firebase) em http://localhost:${port}\n`);
  });
}

function startWriteServer(port, mysqlPool) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(corsDev);

  app.get("/health", async (req, res) => {
    const cfg = getMySqlConfig();
    const { mysqlOk, mysqlError } = await getMySqlHealth(mysqlPool);
    res.json({
      ok: true,
      services: { mysqlOk },
      errors: { mysqlError },
      config: { host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database },
    });
  });

  app.post("/chamados", async (req, res) => {
    // CQRS (Write): cria chamado no MySQL e dispara uma "sincronização" simples para o SQLite (Read)
    const decoded = await requireAuth(req, res);
    if (!decoded) return;

    const titulo = req.body?.titulo;
    const descricao = req.body?.descricao;

    try {
      const chamado = await criarChamado(mysqlPool, { titulo, descricao });

      const sync = await httpJson("POST", Number(process.env.PORT || 3000), "/relatorios/sync", {
        uid: decoded.uid,
        chamado,
      });

      res.json({
        ok: true,
        chamado,
        syncOk: Boolean(sync.ok),
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e?.message || "Erro ao criar chamado" });
    }
  });

  app.listen(port, () => {
    process.stdout.write(`Servidor WRITE (MySQL) em http://localhost:${port}\n`);
  });
}

function startReadServer(port, sqliteDb, sqliteFilePath) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(corsDev);

  app.get("/health", async (req, res) => {
    const { sqliteOk, sqliteError } = await getSqliteHealth(sqliteDb, sqliteFilePath);
    res.json({
      ok: true,
      services: { sqliteOk },
      errors: { sqliteError },
    });
  });

  app.get("/status", async (req, res) => {
    // Endpoint usado pela UI: status consolidado (Banco 2 e Banco 3)
    const writePort = Number(process.env.WRITE_PORT || 3002);
    const writeHealth = await httpJson("GET", writePort, "/health");
    const sqliteHealth = await getSqliteHealth(sqliteDb, sqliteFilePath);

    res.json({
      mysql: writeHealth.data?.services?.mysqlOk ? "OK" : "ERRO",
      sqlite: sqliteHealth.sqliteOk ? "OK" : "ERRO",
    });
  });

  app.post("/relatorios/sync", async (req, res) => {
    // CQRS (Read): recebe o resumo do chamado e persiste no SQLite
    const chamado = req.body?.chamado;
    if (!chamado?.id) return res.status(400).json({ ok: false, error: "Chamado inválido" });

    try {
      await initSqlite(sqliteDb);
      const relatorio = await sincronizarChamadoParaSqlite(sqliteDb, chamado);
      res.json({ ok: true, relatorio });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || "Erro ao sincronizar" });
    }
  });

  app.get("/relatorios", async (req, res) => {
    // CQRS (Read): lista os chamados desnormalizados gravados no SQLite para o dashboard
    const decoded = await requireAuth(req, res);
    if (!decoded) return;

    try {
      await initSqlite(sqliteDb);
      const rows = await listarRelatorios(sqliteDb, 100);
      res.json({ ok: true, items: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || "Erro ao listar relatórios" });
    }
  });

  app.use(
    express.static(path.join(__dirname, "public"), {
      extensions: ["html"],
      etag: false,
      maxAge: 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) res.setHeader("cache-control", "no-store");
      },
    })
  );

  app.listen(port, () => {
    process.stdout.write(`Servidor READ/UI (SQLite) em http://localhost:${port}\n`);
  });
}

async function main() {
  initFirebaseAdmin();

  const authPort = Number(process.env.AUTH_PORT || 3001);
  const writePort = Number(process.env.WRITE_PORT || 3002);
  const readPort = Number(process.env.PORT || 3000);

  const mysqlPool = createMySqlPool();
  const sqliteFilePath = getSqliteFilePath();
  const sqliteDb = openSqliteDb();

  const firebaseOk = admin.apps.length > 0;
  const mysql = await getMySqlHealth(mysqlPool);
  const sqlite = await getSqliteHealth(sqliteDb, sqliteFilePath);

  process.stdout.write(
    `Banco 1 (Firebase): ${firebaseOk ? "OK" : "ERRO"}\n` +
      `Banco 2: ${mysql.mysqlOk ? "OK" : `ERRO (${mysql.mysqlError})`}\n` +
      `Banco 3: ${sqlite.sqliteOk ? "OK" : `ERRO (${sqlite.sqliteError})`}\n`
  );

  startAuthServer(authPort);
  startWriteServer(writePort, mysqlPool);
  startReadServer(readPort, sqliteDb, sqliteFilePath);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});

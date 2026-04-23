const { initMySql } = require("./banco2_mysql");
const { upsertRelatorio, listRelatorios } = require("./banco3_SQLite");

async function criarChamado(mysqlPool, { titulo, descricao }) {
  // Banco 2 (Write): garante schema e insere um novo chamado
  await initMySql(mysqlPool);

  const cleanTitulo = String(titulo || "").trim();
  const cleanDescricao = String(descricao || "").trim();

  if (!cleanTitulo) throw new Error("Título é obrigatório");
  if (!cleanDescricao) throw new Error("Descrição é obrigatória");

  const [result] = await mysqlPool.execute(
    `
      INSERT INTO chamados (titulo, descricao, status)
      VALUES (?, ?, 'ABERTO')
    `,
    [cleanTitulo, cleanDescricao]
  );

  const id = Number(result.insertId);
  const [rows] = await mysqlPool.execute(
    `
      SELECT id, titulo, descricao, status, data_criacao
      FROM chamados
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  );

  return rows[0];
}

async function sincronizarChamadoParaSqlite(sqliteDb, chamado) {
  // Banco 3 (Read): grava um resumo do chamado no SQLite para simular a sincronização (Sprint 3)
  const relatorio = {
    id: Number(chamado.id),
    titulo: String(chamado.titulo || ""),
    descricao: String(chamado.descricao || ""),
    status: String(chamado.status || "ABERTO"),
    data_criacao: String(chamado.data_criacao || new Date().toISOString()),
  };

  await upsertRelatorio(sqliteDb, relatorio);
  return relatorio;
}

async function listarRelatorios(sqliteDb, limit) {
  // Banco 3 (Read): lista os registros desnormalizados exibidos no dashboard
  return listRelatorios(sqliteDb, limit);
}

module.exports = {
  criarChamado,
  sincronizarChamadoParaSqlite,
  listarRelatorios,
};

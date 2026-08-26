// ═══════════════════════════════════════════════════════════════
// vector-store.js — A2 本地知识库向量存储
//
// 规格 §1.5.3（B 选择：better-sqlite3 + sqlite-vss）
// 红线 Q4：documents/doc_chunks/vss_doc_chunks 的 CRUD 必须严格使用
//          下面 4 条建表 SQL（唯一事实源），绝不臆测字段。
//          新增列必须改 SQL + 写迁移脚本 migrations/001_*.sql
// ═══════════════════════════════════════════════════════════════

const fs = require('node:fs')
const path = require('node:path')

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;

-- 表 1：文档主表（严格按 §1.5.3.1 列名）
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('pdf','docx','txt','md','manual','chat')),
  source_path TEXT,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_documents_source_name ON documents(source_name);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);

-- 表 2：文档切片表
CREATE TABLE IF NOT EXISTS doc_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_document_id ON doc_chunks(document_id);

-- 表 4：知识库设置（单行）
CREATE TABLE IF NOT EXISTS knowledge_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chunk_size_tokens INTEGER NOT NULL DEFAULT 512,
  overlap_tokens INTEGER NOT NULL DEFAULT 64,
  embedding_model TEXT NOT NULL DEFAULT 'bge-small-zh-v1.5-onnx-int8',
  updated_at INTEGER NOT NULL
);
`

// sqlite-vss vss0 虚拟表需要先 .load 扩展；扩展未就绪时，该表不建，
// 向量搜索自动降级服务端 HTTP（Q3 红线）
const VSS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS vss_doc_chunks USING vss0(
  chunk_embedding(768)
);
`

// ─────────────── 统一返回格式（对齐 Recall 174008 成功经验）───────────────
function ok(data, extra = {}) {
  return { success: true, code: 0, msg: 'ok', data, durationMs: 0, ...extra }
}
function fail(code, msg, extra = {}) {
  return { success: false, code, msg, data: null, durationMs: 0, ...extra }
}
function wrap(ret, t0) {
  return { ...ret, durationMs: Date.now() - t0 }
}

class VectorStore {
  constructor({ dbPath, nativeAddonsDir }) {
    this.dbPath = dbPath
    this.nativeAddonsDir = nativeAddonsDir
    this._db = null
    this._vssLoaded = false
  }

  // ───────────── 单例连接 ─────────────
  getDB() {
    if (this._db) return this._db
    const t0 = Date.now()
    try {
      const Database = require('better-sqlite3')
      const db = new Database(this.dbPath)
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      db.exec(SCHEMA_SQL)

      // 单行 config 初始化
      const cfgRow = db.prepare('SELECT id FROM knowledge_config WHERE id = 1').get()
      if (!cfgRow) {
        db.prepare(`INSERT INTO knowledge_config(id, chunk_size_tokens, overlap_tokens, embedding_model, updated_at)
                    VALUES (1, 512, 64, 'bge-small-zh-v1.5-onnx-int8', ?)`).run(Date.now())
      }

      // 尝试加载 sqlite-vss 扩展（失败不阻塞，向量功能降级 HTTP）
      try {
        const dll = path.join(this.nativeAddonsDir, 'sqlite_vss.dll')
        if (fs.existsSync(dll)) {
          db.loadExtension(dll)
          db.exec(VSS_SCHEMA_SQL)
          this._vssLoaded = true
        }
      } catch (_) {
        this._vssLoaded = false
      }

      this._db = db
      return db
    } catch (e) {
      // 连接失败：返回给 router 判定为本地不可用 → 自动 fallback HTTP
      throw new Error(`知识库 DB 连接失败：${e.message}`)
    }
  }

  isVssReady() { return this._vssLoaded }

  // ───────────── 文档：CRUD ─────────────
  listDocuments({ limit = 50, offset = 0 } = {}) {
    const t0 = Date.now()
    try {
      const db = this.getDB()
      const rows = db.prepare(`SELECT id, source_name, source_type, source_path, total_chunks, created_at, updated_at, metadata
                               FROM documents ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset)
      const total = db.prepare('SELECT COUNT(*) c FROM documents').get().c
      return wrap(ok({ items: rows.map(this._parseDocRow), total }), t0)
    } catch (e) { return wrap(fail(5000, e.message), t0) }
  }

  createDocument({ source_name, source_type, source_path = null, metadata = {} }) {
    const t0 = Date.now()
    try {
      const db = this.getDB()
      const now = Date.now()
      const info = db.prepare(`INSERT INTO documents(source_name, source_type, source_path, total_chunks, created_at, updated_at, metadata)
                               VALUES (?, ?, ?, 0, ?, ?, ?)`).run(
        source_name, source_type, source_path, now, now, JSON.stringify(metadata || {})
      )
      return wrap(ok({ id: info.lastInsertRowid }), t0)
    } catch (e) { return wrap(fail(5001, e.message), t0) }
  }

  deleteDocument(id) {
    const t0 = Date.now()
    try {
      const db = this.getDB()
      const tx = db.transaction((docId) => {
        // 级联会自动删 doc_chunks；手动清 vss_doc_chunks 的对应 rowid
        const chunkIds = db.prepare('SELECT id FROM doc_chunks WHERE document_id = ?').all(docId).map((r) => r.id)
        for (const cid of chunkIds) {
          try { db.prepare('DELETE FROM vss_doc_chunks WHERE rowid = ?').run(cid) } catch (_) {}
        }
        db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
      })
      tx(id)
      return wrap(ok({ deleted: id }), t0)
    } catch (e) { return wrap(fail(5002, e.message), t0) }
  }

  // ───────────── 切片 + 向量：批量入库（事务）─────────────
  /**
   * @param {object} p
   * @param {number} p.document_id
   * @param {Array<{chunk_index:number, content:string, char_start:number, char_end:number, vector?:Float32Array}>} p.chunks
   */
  insertDocChunksWithVectors({ document_id, chunks }) {
    const t0 = Date.now()
    try {
      const db = this.getDB()
      const now = Date.now()
      const insertChunk = db.prepare(`INSERT INTO doc_chunks(document_id, chunk_index, content, char_start, char_end, created_at)
                                      VALUES (?, ?, ?, ?, ?, ?)`)
      const insertVss = this._vssLoaded
        ? db.prepare(`INSERT INTO vss_doc_chunks(rowid, chunk_embedding) VALUES (?, ?)`)
        : null
      const updateDoc = db.prepare(`UPDATE documents SET total_chunks = total_chunks + ?, updated_at = ? WHERE id = ?`)

      const tx = db.transaction(() => {
        let count = 0
        for (const c of chunks) {
          const info = insertChunk.run(document_id, c.chunk_index, c.content, c.char_start, c.char_end, now)
          const rowid = info.lastInsertRowid
          if (insertVss && c.vector) {
            // better-sqlite3 Blob
            insertVss.run(rowid, Buffer.from(c.vector.buffer))
          }
          count++
        }
        updateDoc.run(count, now, document_id)
        return count
      })
      const inserted = tx()
      return wrap(ok({ inserted, vssReady: this._vssLoaded }), t0)
    } catch (e) { return wrap(fail(5010, e.message), t0) }
  }

  // ───────────── 向量搜索（本地 sqlite-vss，失败返回 vss:false 让 router 降级 HTTP）─────────────
  vectorSearch({ queryVector, topK = 8 }) {
    const t0 = Date.now()
    try {
      if (!this._vssLoaded) {
        return wrap({ success: false, code: 5020, msg: 'VSS_NOT_LOADED', data: null, durationMs: 0, vssReady: false }, t0)
      }
      const db = this.getDB()
      const stmt = db.prepare(`
        SELECT rowid, distance FROM vss_doc_chunks
         WHERE chunk_embedding MATCH ? AND k = ?
         ORDER BY distance
      `)
      const rows = stmt.all(Buffer.from(queryVector.buffer), topK)
      // 回连 doc_chunks + documents 拿真实文本
      const ids = rows.map((r) => r.rowid).join(',')
      const chunkMap = {}
      if (ids) {
        db.prepare(`
          SELECT c.id, c.content, c.chunk_index, c.document_id,
                 d.source_name, d.source_type
            FROM doc_chunks c JOIN documents d ON c.document_id = d.id
           WHERE c.id IN (${ids})
        `).all().forEach((r) => { chunkMap[r.id] = r })
      }
      const hits = rows.map((r) => ({
        chunkId: r.rowid,
        distance: r.distance,
        content: chunkMap[r.rowid]?.content || '',
        documentId: chunkMap[r.rowid]?.document_id,
        sourceName: chunkMap[r.rowid]?.source_name,
      }))
      return wrap(ok({ hits, vssReady: true }), t0)
    } catch (e) {
      return wrap({ success: false, code: 5021, msg: e.message, data: null, durationMs: 0, vssReady: false }, t0)
    }
  }

  // ───────────── config ─────────────
  getConfig() {
    const t0 = Date.now()
    try {
      const db = this.getDB()
      const row = db.prepare('SELECT chunk_size_tokens, overlap_tokens, embedding_model, updated_at FROM knowledge_config WHERE id = 1').get()
      return wrap(ok(row), t0)
    } catch (e) { return wrap(fail(5030, e.message), t0) }
  }

  _parseDocRow(r) {
    try { r.metadata = JSON.parse(r.metadata || '{}') } catch (_) { r.metadata = {} }
    return r
  }
}

function createVectorStore({ dbPath, nativeAddonsDir }) {
  return new VectorStore({ dbPath, nativeAddonsDir })
}

module.exports = { createVectorStore }

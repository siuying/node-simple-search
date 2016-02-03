import sqlite from 'sqlite3'
import mozporter from 'sqlite3-mozporter'
import invariant from 'invariant'
const debug = require('debug')('search')

const docWithResultSet = (rows) => {
  return rows.reduce((map, row) => {
    map[row.field] = row.value
    return map
  } , {})
}

const docsWithResultSet = (rows) => {
  const objects = rows.reduce((map, row) => {
    let docId = row.doc_id
    let field = row.field
    let value = row.value

    let doc = map[docId]
    if (!doc) {
      doc = {}
      map[docId] = doc
    }
    doc[field] = value
    return map
  }, {})
  return Object.keys(objects).map(k => objects[k]);
}

const docIdsWithResultSet = (rows) => {
  const resultSet = rows.reduce((set, row) => {
    set.add(row.doc_id)
    return set
  }, new Set());
  return Array.from(resultSet);
}

export default class SimpleSearch {
  constructor(filename, callback) {
    debug("open database")
    this.database = mozporter(new sqlite.Database(filename));
    this.database.serialize(() => {
      this.database.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ig_search USING FTS4 (id, doc_id, field, value, tokenize=mozporter)`);
      if (callback) {
        callback(null, this);
      }
    });
  }

  // Index a document with given ID
  index(id, doc, callback) {
    invariant(id, "id cannot be nil");
    invariant(doc, "doc cannot be nil");

    return new Promise((resolve, reject) => {
      this.database.serialize(() => {
        this.database.run(`begin transaction`);
        this.database.run(`delete from ig_search where doc_id = ?`, id);
        var stmt = this.database.prepare("insert into ig_search (doc_id, field, value) values (?, ?, ?)");
        Object.keys(doc).forEach((key) => {
          const value = doc[key];
          stmt.run(id, key, value);
        });
        stmt.finalize();
        this.database.run(`commit transaction`);
        resolve();
      });
    });
  }

  // Get an indexed document by ID
  get(id, callback) {
    invariant(id, "id cannot be nil");

    return new Promise((resolve, reject) => {
      this.database.serialize(() => {
        this.database.all(`SELECT field, value FROM ig_search WHERE doc_id = ?`, id, (error, rows) => {
          if (error) {
            reject(error);
            return
          }

          resolve(docWithResultSet(rows));
        });
      });
    });
  }

  search(options, callback) {
    const {query, field, fetchIdOnly} = Object.assign({}, {field: null, fetchIdOnly: false}, options);
    invariant(query, "query cannot be null");
    return new Promise((resolve, reject) => {
      let sql = "";
      if (fetchIdOnly) {
        sql += "SELECT doc_id FROM ig_search \n";
        sql += "JOIN ( SELECT distinct doc_id, rank(matchinfo(ig_search), 1) AS rank FROM ig_search ";
      } else {
        sql += "SELECT doc_id, field, value FROM ig_search \n";
        sql += "JOIN ( SELECT doc_id, rank(matchinfo(ig_search), 1) AS rank FROM ig_search ";
      }
      if (!field) {
        sql += "WHERE value MATCH ? ";
      } else {
        sql += "WHERE field = ? AND value MATCH ? ";
      }
      sql += "ORDER BY rank DESC ) \nAS ranktable USING(doc_id) \n";
      sql += "ORDER BY ranktable.rank DESC \n";

      let processor = fetchIdOnly ? docIdsWithResultSet : docsWithResultSet;
      let callback = (error, result) => {
        if (error) {
          reject(error);
          return
        }
        resolve(processor(result));
      };
      if (!field) {
        debug(sql, query);
        this.database.serialize(() => {
          this.database.all(sql, query, callback);
        });
      } else {
        debug(sql, field, query);
        this.database.serialize(() => {
          this.database.all(sql, field, query, callback);
        });
      }
    });
  }

  // Count number of document indexed
  count(callback) {
    return new Promise((resolve, reject) => {
      this.database.get(`select count(distinct doc_id) as count from ig_search`, (error, result) => {
        if (error) {
          reject(error);
          return
        }

        resolve(result.count);
        return
      });
    });
  }

  // close database
  close(callback) {
    return new Promise((resolve, reject) => {
      // clean up statemenets
      Object.keys(this.statements).forEach(s => s.finalize());

      // clonse database
      this.database.close(callback);

      resolve();
    });
  }

}

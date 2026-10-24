/*
 * core.js — logique pure (sans DOM, sans Grist) du widget SurveyJS pour Grist.
 *
 *  - analyse du JSON SurveyJS  -> arbre de « groupes » (racine + tables imbriquées) et de « champs »
 *  - proposition de mappage vers les colonnes / tables Grist
 *  - conversion des valeurs SurveyJS <-> valeurs Grist selon le type RÉEL de la colonne cible
 *  - construction des enregistrements à insérer
 *
 * Utilisable dans le navigateur (window.SJCore) et dans Node (require) pour les tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SJCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ROOT_ID = '$root';
  var NEW = '__new__';

  /* ------------------------------------------------------------------ */
  /* Utilitaires                                                         */
  /* ------------------------------------------------------------------ */

  function txt(t) {
    if (t == null) return '';
    if (typeof t === 'string') return t;
    if (typeof t === 'object') {
      return t.default || t.fr || t.en || Object.values(t)[0] || '';
    }
    return String(t);
  }

  function clone(o) {
    return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
  }

  function norm(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function sanitizeColId(s) {
    var r = String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!r) r = 'Col';
    if (/^[0-9]/.test(r)) r = 'C_' + r;
    return r;
  }

  function sanitizeTableId(s) {
    var r = sanitizeColId(s);
    return r.charAt(0).toUpperCase() + r.slice(1);
  }

  function getPath(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }

  function setPath(obj, path, value) {
    var cur = obj;
    for (var i = 0; i < path.length - 1; i++) {
      if (cur[path[i]] == null || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
      cur = cur[path[i]];
    }
    cur[path[path.length - 1]] = value;
  }

  // Les listes Grist encodées ['L', a, b] -> [a, b]
  function unwrapList(v) {
    if (Array.isArray(v) && v[0] === 'L') return v.slice(1);
    return v;
  }

  function choiceValues(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map(function (c) { return c && typeof c === 'object' ? c.value : c; })
      .filter(function (v) { return v !== undefined && v !== null && v !== ''; })
      .map(String);
  }

  /* ------------------------------------------------------------------ */
  /* Analyse du JSON SurveyJS                                            */
  /* ------------------------------------------------------------------ */

  var KIND_LABEL = {
    root: 'Formulaire (table du widget)',
    paneldynamic: 'Panneau dynamique',
    matrixdynamic: 'Matrice dynamique',
    matrixdropdown: 'Matrice à lignes fixes'
  };

  // Type Grist recommandé pour un type de question SurveyJS.
  function describe(q, qtype, parentDef) {
    parentDef = parentDef || {};
    var choices = choiceValues(q.choices && q.choices.length ? q.choices : parentDef.choices);
    switch (qtype) {
      case 'text': {
        var it = q.inputType || 'text';
        if (it === 'number' || it === 'range') return { gType: 'Numeric' };
        if (it === 'date') return { gType: 'Date' };
        if (it === 'datetime-local' || it === 'datetime') return { gType: 'DateTime' };
        return { gType: 'Text' };
      }
      case 'comment':
        return { gType: 'Text' };
      case 'radiogroup':
      case 'dropdown':
      case 'buttongroup':
        if (q.showOtherItem && choices.indexOf('other') < 0) choices.push('other');
        if (q.showNoneItem && choices.indexOf('none') < 0) choices.push('none');
        return { gType: 'Choice', choices: choices };
      case 'checkbox':
      case 'tagbox':
      case 'ranking':
        if (q.showOtherItem && choices.indexOf('other') < 0) choices.push('other');
        if (q.showNoneItem && choices.indexOf('none') < 0) choices.push('none');
        return { gType: 'ChoiceList', choices: choices };
      case 'imagepicker': {
        var ic = choiceValues(q.choices);
        return { gType: q.multiSelect ? 'ChoiceList' : 'Choice', choices: ic };
      }
      case 'boolean':
        return { gType: 'Bool' };
      case 'rating': {
        if (Array.isArray(q.rateValues) && q.rateValues.length) {
          var allNum = q.rateValues.every(function (v) {
            var x = v && typeof v === 'object' ? v.value : v;
            return typeof x === 'number' || (typeof x === 'string' && x !== '' && !isNaN(Number(x)));
          });
          return { gType: allNum ? 'Numeric' : 'Text' };
        }
        return { gType: 'Int' };
      }
      case 'slider':
        return { gType: 'Numeric' };
      case 'file':
      case 'signaturepad':
        return { gType: 'Attachments' };
      case 'expression':
        return { gType: 'Any' };
      default:
        return { gType: 'Text' };
    }
  }

  function newGroup(id, key, kind, title, parent) {
    return { id: id, key: key, kind: kind, title: title, parent: parent ? parent.id : null, fields: [], groups: [] };
  }

  function addField(group, f) {
    var key = f.path.join('.');
    if (group.fields.some(function (x) { return x.key === key; })) return;
    f.key = key;
    group.fields.push(f);
  }

  function addGroup(parent, q, kind) {
    var key = q.valueName || q.name;
    var id = parent.id === ROOT_ID ? key : parent.id + '/' + key;
    var g = newGroup(id, key, kind, txt(q.title) || key, parent);
    parent.groups.push(g);
    return g;
  }

  function addQuestionField(group, q) {
    var key = q.valueName || q.name;
    if (!key) return;
    var d = describe(q, q.type);
    var title = txt(q.title) || key;
    addField(group, { path: [key], title: title, qType: q.type, gType: d.gType, choices: d.choices });
    if (q.showOtherItem || q.showCommentArea || q.hasComment || q.hasOther) {
      addField(group, {
        path: [key + '-Comment'], title: title + ' (commentaire)', qType: 'comment', gType: 'Text'
      });
    }
  }

  function addColumnField(group, col, matrix) {
    if (!col || !col.name) return;
    var ct = col.cellType && col.cellType !== 'default' ? col.cellType : (matrix.cellType || 'dropdown');
    var d = describe(col, ct, matrix);
    addField(group, {
      path: [col.name], title: txt(col.title) || col.name, qType: ct, gType: d.gType, choices: d.choices
    });
  }

  var NESTED_CELLS = { matrixdynamic: 1, paneldynamic: 1, matrixdropdown: 1 };

  // Colonnes d'une matrice : une colonne dont la cellule est elle-même une matrice / un panneau dynamique
  // devient un niveau imbriqué.
  function walkColumns(cols, group, matrix) {
    (cols || []).forEach(function (c) {
      if (c && NESTED_CELLS[c.cellType]) {
        walkElements([Object.assign({}, c, { type: c.cellType })], group);
      } else {
        addColumnField(group, c, matrix);
      }
    });
  }

  function walkElements(elements, group) {
    (elements || []).forEach(function (q) {
      if (!q || !q.type) return;
      switch (q.type) {
        case 'panel':
          walkElements(q.elements, group);
          break;
        case 'paneldynamic': {
          var pg = addGroup(group, q, 'paneldynamic');
          walkElements(q.templateElements || q.template || q.elements, pg);
          break;
        }
        case 'matrixdynamic': {
          var mg = addGroup(group, q, 'matrixdynamic');
          walkColumns(q.columns, mg, q);
          // panneau de détail de chaque ligne : peut contenir des matrices / panneaux dynamiques imbriqués
          walkElements(q.detailElements, mg);
          break;
        }
        case 'matrixdropdown': {
          var dg = addGroup(group, q, 'matrixdropdown');
          addField(dg, { path: ['$row'], title: 'Ligne (clé)', qType: 'row', gType: 'Text', synthetic: true });
          walkColumns(q.columns, dg, q);
          walkElements(q.detailElements, dg);
          break;
        }
        case 'matrix': {
          // une valeur par ligne => une colonne par ligne
          var key = q.valueName || q.name;
          var cols = choiceValues((q.columns || []).map(function (c) { return c && typeof c === 'object' ? { value: c.value } : c; }));
          (q.rows || []).forEach(function (r) {
            var rv = r && typeof r === 'object' ? r.value : r;
            var rt = r && typeof r === 'object' ? txt(r.text) || String(rv) : String(rv);
            addField(group, {
              path: [key, String(rv)], title: (txt(q.title) || key) + ' — ' + rt,
              qType: 'matrix', gType: 'Choice', choices: cols
            });
          });
          break;
        }
        case 'multipletext': {
          var mk = q.valueName || q.name;
          (q.items || []).forEach(function (it) {
            var g = it.inputType === 'number' ? 'Numeric' : it.inputType === 'date' ? 'Date' : 'Text';
            addField(group, {
              path: [mk, it.name], title: (txt(q.title) || mk) + ' — ' + (txt(it.title) || it.name),
              qType: 'multipletext', gType: g
            });
          });
          break;
        }
        case 'html':
        case 'image':
          break;
        default:
          addQuestionField(group, q);
      }
    });
  }

  function analyze(json) {
    var root = newGroup(ROOT_ID, '', 'root', txt(json && json.title) || 'Formulaire', null);
    var pages = json && json.pages && json.pages.length
      ? json.pages
      : [{ elements: (json && (json.elements || json.questions)) || [] }];
    pages.forEach(function (p) { walkElements(p.elements || p.questions, root); });
    ((json && json.calculatedValues) || [])
      .filter(function (c) { return c && c.includeIntoResult && c.name; })
      .forEach(function (c) {
        addField(root, { path: [c.name], title: c.name, qType: 'calculatedValue', gType: 'Any' });
      });
    return root;
  }

  function flattenGroups(g, out) {
    out = out || [];
    out.push(g);
    g.groups.forEach(function (c) { flattenGroups(c, out); });
    return out;
  }

  function findGroup(root, id) {
    return flattenGroups(root).filter(function (g) { return g.id === id; })[0] || null;
  }

  /* ------------------------------------------------------------------ */
  /* Types et conversions                                                */
  /* ------------------------------------------------------------------ */

  var GRIST_TYPES = ['Text', 'Numeric', 'Int', 'Bool', 'Date', 'DateTime', 'Choice', 'ChoiceList', 'Attachments', 'Any'];

  function baseType(t) { return String(t || 'Any').split(':')[0]; }

  // 'ok' | 'warn' | 'bad'
  function typeCompat(field, colType) {
    var base = baseType(colType);
    var g = field.gType;
    if (g === 'Attachments') {
      // colonne Pièces jointes (directe), ou colonne Texte/Any contenant les identifiants (contournement)
      return (base === 'Attachments' || base === 'Text' || base === 'Any' || base === 'ChoiceList') ? 'ok' : 'bad';
    }
    if (base === 'Attachments') return 'bad';
    if (base === 'Ref' || base === 'RefList') return 'warn';
    if (base === 'Any' || base === 'Text') return 'ok';
    if (g === base) return 'ok';
    if (g === 'ChoiceList' && base === 'Choice') return 'warn';
    if (g === 'Choice' && base === 'ChoiceList') return 'ok';
    if ((g === 'Numeric' || g === 'Int') && (base === 'Numeric' || base === 'Int')) return 'ok';
    if ((g === 'Date' || g === 'DateTime') && (base === 'Date' || base === 'DateTime')) return 'ok';
    return 'warn';
  }

  function parseDateSeconds(v) {
    if (typeof v === 'number') return v;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000;
    var t = new Date(v).getTime();
    return isNaN(t) ? null : Math.floor(Date.UTC(
      new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()) / 1000);
  }

  function parseDateTimeSeconds(v) {
    if (typeof v === 'number') return v;
    var t = new Date(v).getTime(); // 'YYYY-MM-DDTHH:mm' => heure locale
    return isNaN(t) ? null : Math.floor(t / 1000);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function asText(v) {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(asText).join(', ');
    if (v && typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  // Valeur SurveyJS -> valeur Grist, selon le type RÉEL de la colonne.
  // Retourne undefined si la valeur ne doit pas être écrite.
  function toGrist(v, colType) {
    if (v === undefined || v === null || v === '') return undefined;
    var base = baseType(colType);
    switch (base) {
      case 'Text':
        return asText(v);
      case 'Choice':
        return asText(v);
      case 'Numeric': {
        var n = Number(v);
        return isFinite(n) ? n : asText(v);
      }
      case 'Int': {
        var i = Number(v);
        return isFinite(i) ? Math.round(i) : asText(v);
      }
      case 'Bool':
        return v === true || v === 'true' || v === 1 || v === 'yes' || v === 'oui';
      case 'Date': {
        var d = parseDateSeconds(v);
        return d === null ? asText(v) : d;
      }
      case 'DateTime': {
        var dt = parseDateTimeSeconds(v);
        return dt === null ? asText(v) : dt;
      }
      case 'ChoiceList': {
        var arr = Array.isArray(v) ? v : [v];
        arr = arr.map(asText).filter(function (x) { return x !== ''; });
        return arr.length ? ['L'].concat(arr) : undefined;
      }
      case 'Attachments': {
        var ids = (Array.isArray(v) ? v : [v]).filter(function (x) { return typeof x === 'number'; });
        return ids.length ? ['L'].concat(ids) : undefined;
      }
      case 'Ref': {
        var rn = Number(Array.isArray(v) ? v[0] : v);
        return isFinite(rn) && rn > 0 ? rn : undefined;
      }
      case 'RefList': {
        var rl = (Array.isArray(v) ? v : [v]).map(Number).filter(function (x) { return isFinite(x) && x > 0; });
        return rl.length ? ['L'].concat(rl) : undefined;
      }
      default: // Any
        if (typeof v === 'object') return JSON.stringify(v);
        return v;
    }
  }

  // Valeur Grist -> valeur SurveyJS (mode « modifier l'enregistrement »).
  function fromGrist(v, colType, field) {
    v = unwrapList(v);
    if (v === undefined || v === null || v === '') return undefined;
    var base = baseType(colType);
    var g = field && field.gType;
    switch (base) {
      case 'Date': {
        if (typeof v !== 'number') return String(v);
        return new Date(v * 1000).toISOString().slice(0, 10);
      }
      case 'DateTime': {
        if (typeof v !== 'number') return String(v);
        var d = new Date(v * 1000);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      }
      case 'ChoiceList': {
        var arr = Array.isArray(v) ? v : [v];
        return g === 'Choice' ? arr.join(', ') : arr;
      }
      case 'Bool':
        return !!v;
      case 'Numeric':
      case 'Int':
        return typeof v === 'number' ? v : Number(v);
      case 'Attachments':
        return Array.isArray(v) ? v : [v];
      default:
        if ((g === 'ChoiceList') && typeof v === 'string') {
          return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        }
        return v;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Mappage                                                             */
  /* ------------------------------------------------------------------ */

  // meta = { tables: { TableId: { columns: [ {id, label, type} ] } } }   (colonnes de données uniquement)
  function suggestMapping(rootG, meta, rootTableId, prev) {
    prev = prev || {};
    var out = {};
    var tableIds = Object.keys(meta.tables);
    var usedTables = {};
    usedTables[rootTableId] = true;

    function rec(g, parentTable) {
      var p = prev[g.id] || {};
      var gm = { fields: {} };
      if (g.id === ROOT_ID) {
        gm.table = rootTableId;
      } else {
        var t = p.table;
        if (!(t === NEW || (t && meta.tables[t]))) {
          t = tableIds.filter(function (id) { return !usedTables[id] && norm(id) === norm(g.key); })[0] || NEW;
        }
        gm.table = t;
        if (t !== NEW) usedTables[t] = true;
        gm.newTableName = p.newTableName || sanitizeTableId(g.key);
        var refCols = t !== NEW
          ? meta.tables[t].columns.filter(function (c) { return c.type === 'Ref:' + parentTable; })
          : [];
        var l = p.linkCol;
        if (!(l === NEW || (l && refCols.some(function (c) { return c.id === l; })))) {
          l = refCols.length ? refCols[0].id : NEW;
        }
        if (t === NEW) l = NEW;
        gm.linkCol = l;
        gm.newLinkName = p.newLinkName || sanitizeColId(parentTable);
      }

      var cols = gm.table !== NEW && meta.tables[gm.table] ? meta.tables[gm.table].columns : [];
      var used = {};
      if (gm.linkCol && gm.linkCol !== NEW) used[gm.linkCol] = true;

      g.fields.forEach(function (f) {
        var pf = (p.fields || {})[f.key];
        var fm;
        var pfOk = pf && (pf.col === null || (pf.col === NEW) || cols.some(function (c) { return c.id === pf.col; }));
        if (pfOk) {
          fm = { col: pf.col, type: pf.type || f.gType, newName: pf.newName || sanitizeColId(f.path.join('_')) };
        } else {
          var match = cols.filter(function (c) {
            return !used[c.id] &&
              (norm(c.id) === norm(f.key) || norm(c.label) === norm(f.title) || norm(c.label) === norm(f.key) ||
               (f.gType === 'Attachments' && (norm(c.id) === norm(f.key + 'ids') || norm(c.id) === norm(f.key.replace(/\./g, '_') + 'ids')))) &&
              typeCompat(f, c.type) !== 'bad';
          })[0];
          fm = { col: match ? match.id : NEW, type: f.gType, newName: sanitizeColId(f.path.join('_')) };
        }
        if (fm.col && fm.col !== NEW) used[fm.col] = true;
        if (gm.table === NEW && fm.col !== null) fm.col = NEW;
        gm.fields[f.key] = fm;
      });

      out[g.id] = gm;
      g.groups.forEach(function (c) { rec(c, gm.table); });
    }

    rec(rootG, null);
    return out;
  }

  function countMissing(rootG, mapping) {
    var n = { tables: 0, links: 0, columns: 0 };
    flattenGroups(rootG).forEach(function (g) {
      var gm = mapping[g.id];
      if (!gm) return;
      if (g.id !== ROOT_ID) {
        if (gm.table === NEW) n.tables++;
        else if (gm.linkCol === NEW) n.links++;
      }
      g.fields.forEach(function (f) {
        var fm = gm.fields[f.key];
        if (fm && fm.col === NEW) n.columns++;
      });
    });
    return n;
  }

  function colSpec(field, fm, tz) {
    var t = (fm && fm.type) || field.gType;
    var type = t === 'DateTime' ? 'DateTime:' + (tz || 'UTC') : t;
    var spec = {
      id: (fm && fm.newName) || sanitizeColId(field.key),
      type: type,
      isFormula: false,
      label: field.title || field.key
    };
    if ((t === 'Choice' || t === 'ChoiceList') && field.choices && field.choices.length) {
      spec.widgetOptions = JSON.stringify({ choices: field.choices });
    }
    return spec;
  }

  /* ------------------------------------------------------------------ */
  /* Données : arbre des valeurs du formulaire                           */
  /* ------------------------------------------------------------------ */

  // { rec: {fieldKey: valeur}, kids: { groupId: [ arbre, ... ] } }
  function buildTree(group, obj) {
    var rec = {};
    group.fields.forEach(function (f) { rec[f.key] = getPath(obj, f.path); });
    var kids = {};
    group.groups.forEach(function (cg) {
      var raw = obj ? obj[cg.key] : undefined;
      var rows = [];
      if (Array.isArray(raw)) {
        rows = raw;
      } else if (raw && typeof raw === 'object' && cg.kind === 'matrixdropdown') {
        rows = Object.keys(raw).map(function (k) {
          var o = Object.assign({}, raw[k] || {});
          o.$row = k;
          return o;
        });
      }
      kids[cg.id] = rows
        .filter(function (r) { return r && typeof r === 'object'; })
        .map(function (r) { return buildTree(cg, r); });
    });
    return { rec: rec, kids: kids };
  }

  // Convertit rec (valeurs SurveyJS) en enregistrement Grist.
  // colTypeOf(table, colId) -> type Grist de la colonne
  function toRecord(group, rec, gm, colTypeOf) {
    var out = {};
    group.fields.forEach(function (f) {
      var fm = gm.fields[f.key];
      if (!fm || !fm.col || fm.col === NEW) return;
      var ct = colTypeOf(gm.table, fm.col);
      if (f.gType === 'Attachments' && baseType(ct) !== 'Attachments') {
        // contournement : liste d'identifiants dans une colonne masquée ; une colonne formule de type Pièces jointes les relit
        var raw = rec[f.key];
        var ids = (Array.isArray(raw) ? raw : [raw]).filter(function (x) { return typeof x === 'number'; });
        if (!ids.length) return;
        var cb = baseType(ct);
        if (cb === 'ChoiceList') out[fm.col] = ['L'].concat(ids.map(String)); // liste d'identifiants (texte)
        else if (cb === 'Any') out[fm.col] = ['L'].concat(ids);               // liste d'entiers
        else out[fm.col] = ids.join(',');                                      // ancienne colonne Texte : « 12,13 »
        return;
      }
      var v = toGrist(rec[f.key], ct);
      if (v !== undefined) out[fm.col] = v;
    });
    return out;
  }

  // Simulation (sans écriture) : { table, record, children: [ ... ] }
  function dryRun(group, tree, mapping, colTypeOf) {
    var gm = mapping[group.id];
    var res = { table: gm.table, record: toRecord(group, tree.rec, gm, colTypeOf), children: [] };
    group.groups.forEach(function (cg) {
      var cgm = mapping[cg.id];
      (tree.kids[cg.id] || []).forEach(function (t) {
        var r = dryRun(cg, t, mapping, colTypeOf);
        if (cgm.linkCol && cgm.linkCol !== NEW) r.record[cgm.linkCol] = '<id parent>';
        res.children.push(r);
      });
    });
    return res;
  }


  /* ------------------------------------------------------------------ */
  /* Listes liées (valeurs issues d'une autre table)                      */
  /* ------------------------------------------------------------------ */

  var LOOKUP_TYPES = { text: 1, dropdown: 1, tagbox: 1, checkbox: 1, radiogroup: 1, buttongroup: 1, ranking: 1 };
  var LOOKUP_OPS = [
    ['=', 'est égal à'], ['!=', 'est différent de'], ['contains', 'contient'],
    ['>', 'supérieur à'], ['>=', 'supérieur ou égal à'], ['<', 'inférieur à'], ['<=', 'inférieur ou égal à'],
    ['in', 'est dans la liste (a, b, c)'], ['empty', 'est vide'], ['notempty', 'n’est pas vide']
  ];

  function lookupEligible(f) {
    return !!f && f.path.length === 1 && !f.synthetic && !!LOOKUP_TYPES[f.qType];
  }

  function isEmptyVal(v) {
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  }

  function looseEq(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    var na = typeof a === 'number' || (typeof a === 'string' && a.trim() !== '' && isFinite(Number(a)));
    var nb = typeof b === 'number' || (typeof b === 'string' && b.trim() !== '' && isFinite(Number(b)));
    if (na && nb) return Number(a) === Number(b);
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  }

  function listOf(v) {
    v = unwrapList(v);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && /[,;]/.test(v)) return v.split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean);
    return [v];
  }

  function cmpOrder(a, b) {
    var na = Number(a), nb = Number(b);
    if (a !== '' && b !== '' && isFinite(na) && isFinite(nb)) return na - nb;
    var sa = String(a).toLowerCase(), sb = String(b).toLowerCase();
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  // cell : valeur brute Grist (éventuellement liste) ; ref : valeur de référence (texte, nombre ou liste)
  function matchOp(cell, op, ref) {
    cell = unwrapList(cell);
    var cells = Array.isArray(cell) ? cell : [cell];
    var empty = cells.every(isEmptyVal);
    if (op === 'empty') return empty;
    if (op === 'notempty') return !empty;
    var refs = op === 'in' || Array.isArray(ref) ? listOf(ref) : null;
    switch (op) {
      case '=':
        return refs ? cells.some(function (c) { return refs.some(function (r) { return looseEq(c, r); }); })
                    : cells.some(function (c) { return looseEq(c, ref); });
      case 'in':
        return cells.some(function (c) { return refs.some(function (r) { return looseEq(c, r); }); });
      case '!=':
        return refs ? !cells.some(function (c) { return refs.some(function (r) { return looseEq(c, r); }); })
                    : !cells.some(function (c) { return looseEq(c, ref); });
      case 'contains':
        return cells.some(function (c) { return !isEmptyVal(c) && String(c).toLowerCase().indexOf(String(ref).toLowerCase()) >= 0; });
      case '>': return cells.some(function (c) { return !isEmptyVal(c) && cmpOrder(c, ref) > 0; });
      case '>=': return cells.some(function (c) { return !isEmptyVal(c) && cmpOrder(c, ref) >= 0; });
      case '<': return cells.some(function (c) { return !isEmptyVal(c) && cmpOrder(c, ref) < 0; });
      case '<=': return cells.some(function (c) { return !isEmptyVal(c) && cmpOrder(c, ref) <= 0; });
    }
    return true;
  }

  // rows : [{id, col: valeur, ...}] ; b : liaison ; dynRefs : valeurs courantes des filtres dynamiques (même ordre que b.dynamic)
  // Retourne [{value, text}]
  function buildItems(rows, b, dynRefs) {
    dynRefs = dynRefs || [];
    var fixed = (b.fixed || []).filter(function (f) { return f && f.col; });
    var dyn = (b.dynamic || []).map(function (f, i) { return { f: f, ref: dynRefs[i] }; }).filter(function (d) { return d.f && d.f.col; });

    var active = [];
    for (var i = 0; i < dyn.length; i++) {
      var noRef = dyn[i].f.op === 'empty' || dyn[i].f.op === 'notempty';
      if (!noRef && isEmptyVal(dyn[i].ref)) {
        if ((b.emptyBehavior || 'none') === 'none') return []; // filtre dynamique non renseigné : aucune valeur
        continue;                                               // « toutes les valeurs »
      }
      active.push(dyn[i]);
    }

    var seen = {}, items = [];
    rows.forEach(function (row) {
      for (var a = 0; a < fixed.length; a++) {
        if (!matchOp(row[fixed[a].col], fixed[a].op || '=', fixed[a].value)) return;
      }
      for (var d = 0; d < active.length; d++) {
        if (!matchOp(row[active[d].f.col], active[d].f.op || '=', active[d].ref)) return;
      }
      var val = b.valueCol === '$id' ? row.id : unwrapList(row[b.valueCol]);
      if (Array.isArray(val)) val = val.join(', ');
      if (isEmptyVal(val)) return;
      var lab = b.labelCol ? unwrapList(row[b.labelCol]) : val;
      if (Array.isArray(lab)) lab = lab.join(', ');
      var key = typeof val + ':' + String(val);
      if (seen[key]) return;
      seen[key] = true;
      items.push({ value: val, text: isEmptyVal(lab) ? String(val) : String(lab) });
    });
    if ((b.sort || 'label') === 'label') {
      items.sort(function (x, y) { return x.text.localeCompare(y.text, undefined, { numeric: true, sensitivity: 'base' }); });
    }
    return items;
  }


  // Lignes de la table source retenues par les filtres (fixes + dynamiques).
  // Retourne null si un filtre dynamique n'est pas renseigné et que le comportement est « aucune valeur ».
  function filterSourceRows(rows, b, dynRefs) {
    dynRefs = dynRefs || [];
    var fixed = (b.fixed || []).filter(function (f) { return f && f.col; });
    var active = [];
    var dyn = b.dynamic || [];
    for (var i = 0; i < dyn.length; i++) {
      var f = dyn[i];
      if (!f || !f.col) continue;
      var noRef = f.op === 'empty' || f.op === 'notempty';
      if (!noRef && isEmptyVal(dynRefs[i])) {
        if ((b.emptyBehavior || 'none') === 'none') return null;
        continue;
      }
      active.push({ f: f, ref: dynRefs[i] });
    }
    return rows.filter(function (row) {
      for (var a = 0; a < fixed.length; a++) {
        if (!matchOp(row[fixed[a].col], fixed[a].op || '=', fixed[a].value)) return false;
      }
      for (var d = 0; d < active.length; d++) {
        if (!matchOp(row[active[d].f.col], active[d].f.op || '=', active[d].ref)) return false;
      }
      return true;
    });
  }

  // Remplissage automatique : une ligne de matrice / de panneau par ligne retenue de la table source.
  // b.fill = [{field, col, type}] (col = colonne source ou '$id') ; la 1re correspondance sert de clé (doublons ignorés).
  // convert(m, valeur) : conversion optionnelle (ex. date Grist -> date SurveyJS).
  function buildFillRows(rows, b, dynRefs, convert) {
    var kept = filterSourceRows(rows, b, dynRefs);
    if (kept === null) return null;
    var maps = (b.fill || []).filter(function (m) { return m && m.field && m.col; });
    if (!maps.length) return [];
    var out = [], seen = {};
    kept.forEach(function (row) {
      var o = {};
      maps.forEach(function (m) {
        var v = m.col === '$id' ? row.id : unwrapList(row[m.col]);
        if (Array.isArray(v) && !(convert && m.type)) v = v.join(', ');
        if (convert) v = convert(m, v);
        if (!isEmptyVal(v)) o[m.field] = v;
      });
      var k = o[maps[0].field];
      if (k === undefined) return;
      var key = typeof k + ':' + String(k);
      if (seen[key]) return;
      seen[key] = true;
      out.push(o);
    });
    if ((b.sort || 'label') === 'label') {
      var f0 = maps[0].field;
      out.sort(function (x, y) { return String(x[f0]).localeCompare(String(y[f0]), undefined, { numeric: true, sensitivity: 'base' }); });
    }
    return out;
  }

  // Formule de la colonne Pièces jointes qui relit la colonne d'identifiants (texte « 12,13 »)
  function attachmentsFormula(idsCol) {
    return 'ids = $' + idsCol + '\n' +
      'if isinstance(ids, str):\n' +
      '  ids = ids.replace(";", ",").split(",")\n' +
      'return [int(i) for i in (ids or []) if str(i).strip().isdigit()]';
  }

  return {
    VERSION: '2026-10-24a',
    filterSourceRows: filterSourceRows, buildFillRows: buildFillRows,
    LOOKUP_OPS: LOOKUP_OPS, lookupEligible: lookupEligible, matchOp: matchOp, buildItems: buildItems, isEmptyVal: isEmptyVal,
    attachmentsFormula: attachmentsFormula,
    ROOT_ID: ROOT_ID, NEW: NEW, KIND_LABEL: KIND_LABEL, GRIST_TYPES: GRIST_TYPES,
    txt: txt, clone: clone, norm: norm, sanitizeColId: sanitizeColId, sanitizeTableId: sanitizeTableId,
    getPath: getPath, setPath: setPath, unwrapList: unwrapList, baseType: baseType,
    analyze: analyze, flattenGroups: flattenGroups, findGroup: findGroup,
    typeCompat: typeCompat, toGrist: toGrist, fromGrist: fromGrist,
    suggestMapping: suggestMapping, countMissing: countMissing, colSpec: colSpec,
    buildTree: buildTree, toRecord: toRecord, dryRun: dryRun
  };
});

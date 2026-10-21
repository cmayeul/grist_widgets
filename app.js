/*
 * app.js — widget Grist « Formulaires SurveyJS »
 *   - panneau de configuration (JSON, mappage, apparence, comportement)
 *   - rendu du formulaire pour l'utilisateur final
 *   - enregistrement dans Grist (tables liées, pièces jointes)
 *
 * Dépend de : grist-plugin-api.js, survey-core, survey-js-ui, survey-core/themes, core.js (SJCore)
 */
(function () {
  'use strict';

  var C = window.SJCore;
  var NEW = C.NEW;
  var ROOT = C.ROOT_ID;

  /* ------------------------------------------------------------------ */
  /* Petits utilitaires DOM                                              */
  /* ------------------------------------------------------------------ */

  function $(sel, root) { return (root || document).querySelector(sel); }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'selected' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var ch = arguments[i];
      if (ch === null || ch === undefined || ch === false) continue;
      if (Array.isArray(ch)) ch.forEach(function (c) { if (c) el.append(c); });
      else el.append(ch.nodeType ? ch : document.createTextNode(String(ch)));
    }
    return el;
  }

  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, kind === 'error' ? 7000 : 3500);
  }

  /* ------------------------------------------------------------------ */
  /* État                                                                */
  /* ------------------------------------------------------------------ */

  var DEFAULT_CONFIG = {
    jsonText: '',
    theme: 'DefaultLight',
    customTheme: null,
    surveyOptions: {},
    customCss: '',
    mode: 'new',            // 'new' | 'edit'
    afterSubmit: 'again',   // 'again' | 'auto' | 'none'
    attachmentsMode: 'ids', // 'ids' : identifiants dans une colonne masquée + colonne formule | 'direct' : colonne Pièces jointes
    mapping: null,
    colTypes: {}            // types réels des colonnes mappées, mémorisés à l'enregistrement de la config
  };

  var S = {
    config: C.clone(DEFAULT_CONFIG),
    draft: null,          // copie en cours d'édition dans le panneau de configuration
    meta: null,           // { tables: {...} } lu depuis les tables de métadonnées Grist
    rootTableId: null,
    analysis: null,       // arbre des groupes issu du JSON courant (draft)
    parseError: null,
    tab: 'form',
    configOpen: false,
    record: null,         // enregistrement sélectionné (mode « modifier »)
    model: null,          // modèle SurveyJS courant
    previewModel: null,
    busy: false
  };

  /* ------------------------------------------------------------------ */
  /* Grist : métadonnées                                                 */
  /* ------------------------------------------------------------------ */

  async function getRootTableId() {
    if (S.rootTableId) return S.rootTableId;
    try {
      S.rootTableId = await grist.getTable().getTableId();
    } catch (e) {
      try { S.rootTableId = await grist.selectedTable.getTableId(); } catch (e2) { /* ignoré */ }
    }
    return S.rootTableId;
  }

  async function loadMeta() {
    var tables = await grist.docApi.fetchTable('_grist_Tables');
    var cols = await grist.docApi.fetchTable('_grist_Tables_column');
    var byRef = {};
    var meta = { tables: {} };
    tables.id.forEach(function (id, i) {
      var tid = tables.tableId[i];
      if (!tid || /^_grist_/.test(tid)) return;
      if (tables.summarySourceTable && tables.summarySourceTable[i]) return; // tables de synthèse
      byRef[id] = tid;
      meta.tables[tid] = { ref: id, columns: [] };
    });
    cols.id.forEach(function (id, i) {
      var t = byRef[cols.parentId[i]];
      if (!t) return;
      var colId = cols.colId[i];
      if (/^gristHelper_/.test(colId) || colId === 'manualSort') return;
      if (cols.isFormula[i]) return; // colonnes formule : non inscriptibles
      meta.tables[t].columns.push({
        id: colId,
        label: cols.label[i] || colId,
        type: cols.type[i] || 'Any'
      });
    });
    S.meta = meta;
    return meta;
  }

  function colTypeLookup() {
    return function (table, col) {
      var t = S.meta && S.meta.tables[table];
      var c = t && t.columns.filter(function (x) { return x.id === col; })[0];
      if (c) return c.type;
      var ct = (S.config.colTypes || {})[table];
      return (ct && ct[col]) || 'Any';
    };
  }

  async function applyUA(actions) {
    var res = await grist.docApi.applyUserActions(actions);
    return (res && res.retValues) || res || [];
  }

  /* ------------------------------------------------------------------ */
  /* Grist : pièces jointes                                              */
  /* ------------------------------------------------------------------ */

  function dataUrlToFile(dataUrl, name, type) {
    var m = /^data:([^;,]*)(;base64)?,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('Pièce jointe illisible');
    var mime = type || m[1] || 'application/octet-stream';
    var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var ext = (mime.split('/')[1] || 'bin').split('+')[0];
    return new File([bytes], name || ('fichier.' + ext), { type: mime });
  }

  async function uploadAttachment(file, tok) {
    var form = new FormData();
    form.append('upload', file, file.name);
    var res = await fetch(tok.baseUrl + '/attachments?auth=' + encodeURIComponent(tok.token), {
      method: 'POST',
      body: form,
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!res.ok) throw new Error('Envoi de « ' + file.name + ' » refusé (' + res.status + ')');
    var ids = await res.json();
    return ids[0];
  }

  // Remplace, dans l'arbre, les valeurs des champs « Attachments » par des identifiants de pièces jointes.
  async function resolveAttachments(group, tree, ctx) {
    for (var i = 0; i < group.fields.length; i++) {
      var f = group.fields[i];
      if (f.gType !== 'Attachments') continue;
      var v = tree.rec[f.key];
      if (v === undefined || v === null || v === '') { tree.rec[f.key] = undefined; continue; }
      var items = Array.isArray(v) ? v : [v];
      var ids = [];
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        var content = typeof it === 'string' ? it : (it && it.content);
        if (!content) continue;
        if (ctx.existing[content]) { ids.push(ctx.existing[content]); continue; }
        var file;
        if (/^data:/.test(content)) {
          file = dataUrlToFile(content, it && it.name, it && it.type);
        } else if (/^blob:/.test(content)) {
          var blob = await (await fetch(content)).blob();
          file = new File([blob], (it && it.name) || 'fichier', { type: blob.type });
        } else {
          continue; // URL distante inconnue : ignorée
        }
        if (ctx.dry) { ids.push(1000 + ids.length); continue; }
        if (!ctx.tok) ctx.tok = await grist.docApi.getAccessToken({ readOnly: false });
        ids.push(await uploadAttachment(file, ctx.tok));
      }
      tree.rec[f.key] = ids;
    }
    for (var k = 0; k < group.groups.length; k++) {
      var cg = group.groups[k];
      var rows = tree.kids[cg.id] || [];
      for (var r = 0; r < rows.length; r++) await resolveAttachments(cg, rows[r], ctx);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Grist : enregistrement des réponses                                 */
  /* ------------------------------------------------------------------ */

  function collectColumns(records) {
    var keys = {};
    records.forEach(function (r) { Object.keys(r).forEach(function (k) { keys[k] = true; }); });
    var cols = {};
    Object.keys(keys).forEach(function (k) {
      cols[k] = records.map(function (r) { return r[k] === undefined ? null : r[k]; });
    });
    return cols;
  }

  async function bulkAdd(table, records, ctx) {
    var cols = collectColumns(records);
    var ids = records.map(function () { return null; });
    var rv = await applyUA([['BulkAddRecord', table, ids, cols]]);
    var newIds = rv[0];
    if (!Array.isArray(newIds)) newIds = [newIds];
    ctx.created.push({ table: table, ids: newIds.slice() });
    return newIds;
  }

  async function insertGroup(group, rows, parentId, ctx) {
    var gm = ctx.mapping[group.id];
    var records = rows.map(function (t) { return C.toRecord(group, t.rec, gm, ctx.colType); });
    if (parentId != null) {
      records.forEach(function (rec) { rec[gm.linkCol] = parentId; });
    }
    if (!records.length) return;
    var ids = await bulkAdd(gm.table, records, ctx);
    for (var i = 0; i < rows.length; i++) {
      for (var k = 0; k < group.groups.length; k++) {
        var cg = group.groups[k];
        var kids = rows[i].kids[cg.id] || [];
        if (kids.length) await insertGroup(cg, kids, ids[i], ctx);
      }
    }
  }

  // Lignes d'une table liées à un parent
  async function fetchChildRows(table, linkCol, parentId) {
    var data = await grist.docApi.fetchTable(table);
    var out = [];
    (data.id || []).forEach(function (id, i) {
      if (data[linkCol] && data[linkCol][i] === parentId) {
        var r = { id: id };
        Object.keys(data).forEach(function (k) { r[k] = data[k][i]; });
        out.push(r);
      }
    });
    return out;
  }

  async function deleteDescendants(group, parentId, ctx) {
    for (var k = 0; k < group.groups.length; k++) {
      var cg = group.groups[k];
      var cgm = ctx.mapping[cg.id];
      if (!cgm || !cgm.linkCol || cgm.linkCol === NEW) continue;
      var rows = await fetchChildRows(cgm.table, cgm.linkCol, parentId);
      for (var i = 0; i < rows.length; i++) await deleteDescendants(cg, rows[i].id, ctx);
      if (rows.length) {
        await applyUA([['BulkRemoveRecord', cgm.table, rows.map(function (r) { return r.id; })]]);
      }
    }
  }

  async function saveSurvey(data, opts) {
    opts = opts || {};
    var cfg = S.config;
    var rootG = C.analyze(JSON.parse(cfg.jsonText));
    var mapping = cfg.mapping;
    if (!mapping) throw new Error('Le mappage des données n’est pas configuré (voir la configuration du widget).');

    var rootTable = await getRootTableId();
    var mappedAny = C.flattenGroups(rootG).some(function (g) {
      var gm = mapping[g.id];
      return gm && g.fields.some(function (f) { return gm.fields[f.key] && gm.fields[f.key].col && gm.fields[f.key].col !== NEW; });
    });
    if (!mappedAny) throw new Error('Aucun champ du formulaire n’est relié à une colonne Grist.');
    C.flattenGroups(rootG).forEach(function (g) {
      var gm = mapping[g.id];
      if (!gm) throw new Error('Mappage incomplet pour « ' + g.title + ' ». Ouvrez la configuration.');
      if (!opts.dry && g.id !== ROOT && (gm.table === NEW || gm.linkCol === NEW)) {
        throw new Error('La table liée pour « ' + g.title + ' » n’a pas été créée (configuration > Mappage).');
      }
    });
    mapping[ROOT].table = rootTable;

    var colType = colTypeLookup();

    var ctx = { mapping: mapping, colType: colType, created: [], existing: opts.existing || {}, tok: null, dry: !!opts.dry };
    var tree = C.buildTree(rootG, data);
    await resolveAttachments(rootG, tree, ctx);

    if (opts.dry) return C.dryRun(rootG, tree, mapping, colType);

    try {
      if (opts.recordId) {
        // Mode « modifier » : mise à jour de la ligne racine, remplacement des lignes liées
        var rec = C.toRecord(rootG, tree.rec, mapping[ROOT], colType);
        // les champs vides doivent effacer la valeur existante
        rootG.fields.forEach(function (f) {
          var fm = mapping[ROOT].fields[f.key];
          if (fm && fm.col && fm.col !== NEW && !(fm.col in rec)) rec[fm.col] = null;
        });
        await applyUA([['UpdateRecord', rootTable, opts.recordId, rec]]);
        await deleteDescendants(rootG, opts.recordId, ctx);
        for (var k = 0; k < rootG.groups.length; k++) {
          var cg = rootG.groups[k];
          var kids = tree.kids[cg.id] || [];
          if (kids.length) await insertGroup(cg, kids, opts.recordId, ctx);
        }
        return opts.recordId;
      }
      var rootRec = C.toRecord(rootG, tree.rec, mapping[ROOT], colType);
      var rv = await applyUA([['AddRecord', rootTable, null, rootRec]]);
      var newId = rv[0];
      ctx.created.push({ table: rootTable, ids: [newId] });
      for (var j = 0; j < rootG.groups.length; j++) {
        var g2 = rootG.groups[j];
        var kids2 = tree.kids[g2.id] || [];
        if (kids2.length) await insertGroup(g2, kids2, newId, ctx);
      }
      return newId;
    } catch (e) {
      // Annulation au mieux de ce qui vient d'être créé
      if (!opts.recordId) {
        for (var i = ctx.created.length - 1; i >= 0; i--) {
          try { await applyUA([['BulkRemoveRecord', ctx.created[i].table, ctx.created[i].ids]]); } catch (e2) { /* ignoré */ }
        }
      }
      throw e;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Grist : chargement d'un enregistrement existant (mode « modifier »)  */
  /* ------------------------------------------------------------------ */

  async function loadObject(group, rec, ctx) {
    var gm = ctx.mapping[group.id];
    var obj = {};
    group.fields.forEach(function (f) {
      var fm = gm.fields[f.key];
      if (!fm || !fm.col || fm.col === NEW) return;
      var type = ctx.colType(gm.table, fm.col);
      var v;
      if (f.gType === 'Attachments') {
        var raw = C.unwrapList(rec[fm.col]);
        var ids;
        if (C.baseType(type) === 'Attachments') ids = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        else ids = String(raw == null ? '' : raw).split(/[,;\s]+/).filter(Boolean).map(Number).filter(function (n) { return isFinite(n); });
        if (!ids.length) return;
        v = ids.map(function (id) {
          var meta = ctx.attMeta[id] || {};
          var url = ctx.tok ? ctx.tok.baseUrl + '/attachments/' + id + '/download?auth=' + encodeURIComponent(ctx.tok.token) : '';
          ctx.existing[url] = id;
          return { name: meta.name || ('fichier-' + id), type: meta.type || 'application/octet-stream', content: url };
        });
      } else {
        v = C.fromGrist(rec[fm.col], type, f);
        if (v === undefined) return;
      }
      C.setPath(obj, f.path, v);
    });
    for (var k = 0; k < group.groups.length; k++) {
      var cg = group.groups[k];
      var cgm = ctx.mapping[cg.id];
      if (!cgm || cgm.table === NEW || !cgm.linkCol || cgm.linkCol === NEW) continue;
      var rows = await fetchChildRows(cgm.table, cgm.linkCol, rec.id);
      var arr = [];
      for (var i = 0; i < rows.length; i++) arr.push(await loadObject(cg, rows[i], ctx));
      if (cg.kind === 'matrixdropdown') {
        var o = {};
        arr.forEach(function (r) { var key = r.$row; delete r.$row; if (key !== undefined) o[key] = r; });
        obj[cg.key] = o;
      } else {
        obj[cg.key] = arr;
      }
    }
    return obj;
  }

  async function loadRecordData(rowId) {
    var cfg = S.config;
    var rootG = C.analyze(JSON.parse(cfg.jsonText));
    var rec = await grist.fetchSelectedRecord(rowId);
    var ctx = { mapping: cfg.mapping, existing: {}, tok: null, attMeta: {}, colType: colTypeLookup() };
    try {
      ctx.tok = await grist.docApi.getAccessToken({ readOnly: true });
      var att = await grist.docApi.fetchTable('_grist_Attachments');
      att.id.forEach(function (id, i) { ctx.attMeta[id] = { name: att.fileName[i], type: att.fileType[i] }; });
    } catch (e) { /* pièces jointes non affichables */ }
    var data = await loadObject(rootG, rec, ctx);
    return { data: data, existing: ctx.existing };
  }

  /* ------------------------------------------------------------------ */
  /* Rendu du formulaire SurveyJS                                        */
  /* ------------------------------------------------------------------ */

  function themeObject(cfg) {
    if (cfg.customTheme && typeof cfg.customTheme === 'object' && Object.keys(cfg.customTheme).length) return cfg.customTheme;
    var T = window.SurveyTheme || {};
    return T[cfg.theme] || T.DefaultLight || null;
  }

  function applyCustomCss(css) {
    var st = $('#custom-css');
    if (!st) { st = h('style', { id: 'custom-css' }); document.head.append(st); }
    st.textContent = css || '';
  }

  function createModel(cfg, data) {
    var json = JSON.parse(cfg.jsonText);
    var model = new Survey.Model(json);
    var opts = cfg.surveyOptions || {};
    Object.keys(opts).forEach(function (k) {
      try { model[k] = opts[k]; } catch (e) { console.warn('Option SurveyJS ignorée :', k, e); }
    });
    var th = themeObject(cfg);
    if (th) { try { model.applyTheme(th); } catch (e) { console.warn('Thème non appliqué', e); } }
    if (data) model.data = data;
    return model;
  }

  function disposeModel(m) {
    if (!m) return;
    try { m.dispose(); } catch (e) { /* ignoré */ }
  }

  var existingAttachments = {};

  async function renderForm() {
    var host = $('#survey');
    var msg = $('#message');
    var after = $('#after');
    disposeModel(S.model);
    S.model = null;
    host.innerHTML = '';
    after.hidden = true;
    msg.hidden = true;
    var cfg = S.config;
    applyCustomCss(cfg.customCss);

    if (!cfg.jsonText || !cfg.jsonText.trim()) {
      msg.hidden = false;
      msg.innerHTML = '';
      msg.append(
        h('h2', { text: 'Widget non configuré' }),
        h('p', { text: 'Ouvrez le panneau de création du widget dans Grist, puis « Ouvrir la configuration » pour coller le JSON de votre formulaire SurveyJS.' })
      );
      return;
    }

    var data = null;
    existingAttachments = {};
    var recordId = null;
    if (cfg.mode === 'edit') {
      recordId = S.record && S.record.id;
      if (!recordId) {
        msg.hidden = false;
        msg.innerHTML = '';
        msg.append(h('h2', { text: 'Sélectionnez une ligne' }), h('p', { text: 'Ce formulaire modifie la ligne sélectionnée.' }));
        return;
      }
      try {
        var loaded = await loadRecordData(recordId);
        data = loaded.data;
        existingAttachments = loaded.existing;
      } catch (e) {
        console.error(e);
        toast('Chargement de la ligne impossible : ' + e.message, 'error');
      }
    }

    var model;
    try {
      model = createModel(cfg, data);
    } catch (e) {
      msg.hidden = false;
      msg.innerHTML = '';
      msg.append(h('h2', { text: 'Formulaire invalide' }), h('p', { class: 'err', text: e.message }));
      return;
    }
    S.model = model;

    model.onComplete.add(async function (sender, options) {
      options.showSaveInProgress();
      try {
        await saveSurvey(sender.data, { recordId: recordId, existing: existingAttachments });
        options.showSaveSuccess();
        afterSubmit();
      } catch (e) {
        console.error(e);
        options.showSaveError(e.message || String(e));
      }
    });

    // conteneur neuf à chaque rendu : évite de réutiliser l'arbre interne d'un rendu précédent
    var holder = h('div');
    host.append(holder);
    model.render(holder);
  }

  function afterSubmit() {
    var mode = S.config.afterSubmit;
    var after = $('#after');
    if (S.config.mode === 'edit' || mode === 'none') return;
    if (mode === 'auto') {
      setTimeout(renderForm, 2000);
      return;
    }
    after.hidden = false;
    after.innerHTML = '';
    after.append(h('button', { class: 'btn primary', text: 'Nouvelle saisie', onclick: function () { renderForm(); } }));
  }

  /* ------------------------------------------------------------------ */
  /* Configuration : état brouillon                                      */
  /* ------------------------------------------------------------------ */

  function parseDraftJson() {
    S.parseError = null;
    S.analysis = null;
    var text = S.draft.jsonText;
    if (!text || !text.trim()) return;
    try {
      var json = JSON.parse(text);
      S.analysis = C.analyze(json);
    } catch (e) {
      S.parseError = e.message;
    }
  }

  function refreshMapping(keepPrev) {
    if (!S.analysis || !S.meta || !S.rootTableId) return;
    S.draft.mapping = C.suggestMapping(S.analysis, S.meta, S.rootTableId, keepPrev ? (S.draft.mapping || {}) : {});
  }

  async function openConfig() {
    S.configOpen = true;
    S.draft = C.clone(S.config);
    for (var k in DEFAULT_CONFIG) if (S.draft[k] === undefined) S.draft[k] = C.clone(DEFAULT_CONFIG[k]);
    $('#config').hidden = false;
    $('#view').hidden = true;
    parseDraftJson();
    renderConfig();
    try {
      await getRootTableId();
      await loadMeta();
      refreshMapping(true);
    } catch (e) {
      console.error(e);
      toast('Lecture des tables Grist impossible : ' + e.message, 'error');
    }
    renderConfig();
  }

  function closeConfig() {
    S.configOpen = false;
    disposeModel(S.previewModel);
    S.previewModel = null;
    $('#config').hidden = true;
    $('#view').hidden = false;
    renderForm();
  }

  function collectColTypes(mapping) {
    var out = {};
    if (!mapping || !S.meta) return out;
    var lookup = colTypeLookup();
    Object.keys(mapping).forEach(function (id) {
      var gm = mapping[id];
      if (!gm || !gm.table || gm.table === NEW) return;
      out[gm.table] = out[gm.table] || {};
      Object.keys(gm.fields).forEach(function (k) {
        var col = gm.fields[k].col;
        if (col && col !== NEW) out[gm.table][col] = lookup(gm.table, col);
      });
    });
    return out;
  }

  async function saveConfig() {
    if (S.parseError) { toast('Le JSON du formulaire est invalide : ' + S.parseError, 'error'); S.tab = 'form'; renderConfig(); return; }
    try {
      S.draft.colTypes = collectColTypes(S.draft.mapping);
      await grist.setOptions({ config: S.draft });
      S.config = C.clone(S.draft);
      toast('Configuration enregistrée', 'ok');
      closeConfig();
    } catch (e) {
      toast('Enregistrement impossible : ' + e.message, 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Configuration : rendu                                               */
  /* ------------------------------------------------------------------ */

  var TABS = [
    ['form', '1 · Formulaire'],
    ['mapping', '2 · Mappage des données'],
    ['look', '3 · Apparence'],
    ['behavior', '4 · Comportement']
  ];

  function renderConfig() {
    var root = $('#config');
    var keepScroll = $('#config-body') ? $('#config-body').scrollTop : 0;
    root.innerHTML = '';
    root.append(
      h('header', { class: 'cfg-head' },
        h('h1', { text: 'Configuration du formulaire SurveyJS' }),
        h('div', { class: 'cfg-actions' },
          h('button', { class: 'btn', text: 'Annuler', onclick: closeConfig }),
          h('button', { class: 'btn primary', text: 'Enregistrer', onclick: saveConfig }))),
      h('nav', { class: 'tabs' }, TABS.map(function (t) {
        return h('button', {
          class: 'tab' + (S.tab === t[0] ? ' active' : ''), text: t[1],
          onclick: function () { S.tab = t[0]; renderConfig(); }
        });
      })),
      h('div', { id: 'config-body', class: 'cfg-body' })
    );
    var body = $('#config-body');
    if (S.tab === 'form') renderFormTab(body);
    else if (S.tab === 'mapping') renderMappingTab(body);
    else if (S.tab === 'look') renderLookTab(body);
    else renderBehaviorTab(body);
    body.scrollTop = keepScroll;
  }

  /* ---- Onglet 1 : JSON ------------------------------------------------ */

  function renderFormTab(body) {
    var status = h('div', { class: 'status' });
    var ta = h('textarea', {
      id: 'json-editor', class: 'code', spellcheck: 'false',
      placeholder: '{\n  "pages": [ { "elements": [ { "type": "text", "name": "nom", "title": "Votre nom" } ] } ]\n}'
    });
    ta.value = S.draft.jsonText || '';

    function updateStatus() {
      status.className = 'status';
      if (!ta.value.trim()) { status.textContent = 'Collez le JSON de votre formulaire.'; return; }
      if (S.parseError) { status.classList.add('bad'); status.textContent = '✗ JSON invalide : ' + S.parseError; return; }
      var groups = C.flattenGroups(S.analysis);
      var nf = groups.reduce(function (n, g) { return n + g.fields.length; }, 0);
      status.classList.add('good');
      status.textContent = '✓ JSON valide — ' + nf + ' champ(s), ' + (groups.length - 1) + ' niveau(x) imbriqué(s) détecté(s).';
    }

    ta.addEventListener('input', function () {
      S.draft.jsonText = ta.value;
      parseDraftJson();
      updateStatus();
    });

    body.append(
      h('p', { class: 'hint', html: 'Collez le JSON de votre formulaire (généré par <a href="https://surveyjs.io/create-free-survey" target="_blank" rel="noopener">SurveyJS Creator</a> ou écrit à la main). Il est analysé automatiquement pour proposer le mappage avec les colonnes Grist.' }),
      h('div', { class: 'row' },
        h('button', { class: 'btn', text: 'Insérer un exemple', onclick: async function () {
          try {
            var r = await fetch('exemple-formulaire.json');
            ta.value = await r.text();
          } catch (e) { toast('Exemple indisponible (fichier exemple-formulaire.json introuvable).', 'error'); return; }
          ta.dispatchEvent(new Event('input'));
        } }),
        h('button', { class: 'btn', text: 'Formater', onclick: function () {
          try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); ta.dispatchEvent(new Event('input')); } catch (e) { /* statut déjà affiché */ }
        } }),
        h('button', { class: 'btn primary', text: 'Analyser et proposer le mappage →', onclick: function () {
          if (S.parseError || !S.analysis) { toast('Corrigez d’abord le JSON.', 'error'); return; }
          refreshMapping(true);
          S.tab = 'mapping';
          renderConfig();
        } })),
      ta, status
    );
    updateStatus();
  }

  /* ---- Onglet 2 : mappage ---------------------------------------------- */

  var QTYPE_LABEL = {
    text: 'Texte', comment: 'Zone de texte', radiogroup: 'Choix unique', dropdown: 'Liste déroulante',
    checkbox: 'Cases à cocher', tagbox: 'Étiquettes', ranking: 'Classement', boolean: 'Oui/Non', rating: 'Note',
    file: 'Fichier', signaturepad: 'Signature', imagepicker: 'Choix d’image', expression: 'Expression',
    matrix: 'Matrice', multipletext: 'Textes multiples', buttongroup: 'Boutons', slider: 'Curseur',
    row: 'Clé de ligne', calculatedValue: 'Valeur calculée'
  };

  function badge(kind, text) { return h('span', { class: 'badge ' + kind, text: text }); }

  function fieldStatus(f, fm, gm) {
    if (!fm || fm.col === null) return badge('muted', 'ignoré');
    if (fm.col === NEW) return badge('info', gm.table === NEW ? 'sera créé (nouvelle table)' : 'à créer');
    var type = colTypeLookup()(gm.table, fm.col);
    var c = C.typeCompat(f, type);
    if (c === 'ok') return badge('ok', 'OK');
    if (c === 'warn') return badge('warn', 'type différent (' + C.baseType(type) + ')');
    return badge('bad', 'incompatible (' + C.baseType(type) + ')');
  }

  function renderMappingTab(body) {
    if (S.parseError) { body.append(h('p', { class: 'status bad', text: 'Le JSON du formulaire est invalide : ' + S.parseError })); return; }
    if (!S.analysis) { body.append(h('p', { class: 'hint', text: 'Ajoutez d’abord le JSON du formulaire (onglet 1).' })); return; }
    if (!S.meta || !S.draft.mapping) { body.append(h('p', { class: 'hint', text: 'Lecture des tables et colonnes Grist…' })); return; }

    var mapping = S.draft.mapping;
    var missing = C.countMissing(S.analysis, mapping);
    var nMissing = missing.tables + missing.links + missing.columns;

    body.append(
      h('p', { class: 'hint', text: 'Chaque champ du formulaire est relié à une colonne de la table Grist. Les questions imbriquées (matrices et panneaux dynamiques) sont enregistrées dans des tables liées, y compris sur plusieurs niveaux.' }),
      h('div', { class: 'row' },
        h('button', { class: 'btn', text: 'Remise à zéro du mappage automatique', onclick: function () { refreshMapping(false); renderConfig(); } }),
        h('button', { class: 'btn', text: 'Relire les colonnes Grist', onclick: async function () {
          try { await loadMeta(); refreshMapping(true); renderConfig(); toast('Colonnes relues', 'ok'); } catch (e) { toast(e.message, 'error'); }
        } }),
        h('button', {
          class: 'btn primary', disabled: !nMissing || S.busy,
          text: nMissing
            ? 'Créer les éléments manquants (' + [
              missing.tables ? missing.tables + ' table(s)' : '',
              missing.links ? missing.links + ' liaison(s)' : '',
              missing.columns ? missing.columns + ' colonne(s)' : ''].filter(Boolean).join(', ') + ')'
            : 'Rien à créer',
          onclick: createMissing
        }))
    );

    C.flattenGroups(S.analysis).forEach(function (g) { body.append(renderGroupCard(g)); });
  }

  function tableOptions(selected, includeNew) {
    var opts = [];
    if (includeNew) opts.push(h('option', { value: NEW, text: '➕ Créer une nouvelle table', selected: selected === NEW }));
    Object.keys(S.meta.tables).sort().forEach(function (id) {
      opts.push(h('option', { value: id, text: id, selected: selected === id }));
    });
    return opts;
  }

  function renderGroupCard(g) {
    var mapping = S.draft.mapping;
    var gm = mapping[g.id];
    var isRoot = g.id === ROOT;
    var parentG = isRoot ? null : C.findGroup(S.analysis, g.parent);
    var parentTable = parentG ? mapping[parentG.id].table : null;
    var depth = g.id.split('/').length - (isRoot ? 1 : 0);

    var card = h('section', { class: 'card', style: 'margin-left:' + (isRoot ? 0 : depth * 14) + 'px' });
    card.append(h('header', { class: 'card-head' },
      badge(isRoot ? 'root' : 'nest', C.KIND_LABEL[g.kind] || g.kind),
      h('strong', { text: isRoot ? 'Table du widget' : g.title }),
      isRoot ? null : h('code', { text: g.id })));

    var grid = h('div', { class: 'grid2' });
    if (isRoot) {
      grid.append(h('label', { text: 'Table Grist' }), h('div', { class: 'static', text: S.rootTableId || '(sélectionnez une table de données pour le widget)' }));
    } else {
      var tSel = h('select', { onchange: function (e) {
        gm.table = e.target.value;
        if (gm.table === NEW) { gm.linkCol = NEW; Object.keys(gm.fields).forEach(function (k) { if (gm.fields[k].col !== null) gm.fields[k].col = NEW; }); }
        else { gm.linkCol = null; gm.fields = {}; mapping = C.suggestMapping(S.analysis, S.meta, S.rootTableId, mapping); S.draft.mapping = mapping; }
        renderConfig();
      } }, tableOptions(gm.table, true));
      grid.append(h('label', { text: 'Table liée' }), h('div', { class: 'inline' }, tSel,
        gm.table === NEW ? h('input', { type: 'text', value: gm.newTableName, placeholder: 'Nom de la nouvelle table',
          onchange: function (e) { gm.newTableName = e.target.value; } }) : null));

      var linkSel;
      if (gm.table === NEW) {
        linkSel = h('div', { class: 'inline' },
          h('span', { class: 'static', text: 'Créer' }),
          h('input', { type: 'text', value: gm.newLinkName, onchange: function (e) { gm.newLinkName = e.target.value; } }));
      } else {
        var refCols = S.meta.tables[gm.table].columns.filter(function (c) { return c.type === 'Ref:' + parentTable; });
        linkSel = h('div', { class: 'inline' },
          h('select', { onchange: function (e) { gm.linkCol = e.target.value; renderConfig(); } },
            refCols.map(function (c) { return h('option', { value: c.id, text: c.label + ' (' + c.id + ')', selected: gm.linkCol === c.id }); }),
            h('option', { value: NEW, text: '➕ Créer une colonne de liaison', selected: gm.linkCol === NEW })),
          gm.linkCol === NEW ? h('input', { type: 'text', value: gm.newLinkName, onchange: function (e) { gm.newLinkName = e.target.value; } }) : null);
      }
      grid.append(h('label', { text: 'Liaison vers « ' + (parentTable === NEW ? 'nouvelle table parente' : parentTable) + ' »' }), linkSel);
    }
    card.append(grid);

    // champs
    var tbl = h('table', { class: 'fields' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'Champ du formulaire' }), h('th', { text: 'Type' }),
        h('th', { text: 'Colonne Grist' }), h('th', { text: 'Type si création' }), h('th', { text: 'État' }))),
      h('tbody', {}, g.fields.map(function (f) { return fieldRow(f, gm); })));
    if (!g.fields.length) card.append(h('p', { class: 'hint', text: 'Aucun champ de données à ce niveau.' }));
    else card.append(tbl);
    return card;
  }

  function fieldRow(f, gm) {
    var fm = gm.fields[f.key];
    var cols = gm.table !== NEW && S.meta.tables[gm.table] ? S.meta.tables[gm.table].columns : [];
    var linkUsed = gm.linkCol;

    var colSel = h('select', { onchange: function (e) {
      var v = e.target.value;
      fm.col = v === '__ignore__' ? null : v;
      renderConfig();
    } },
      h('option', { value: '__ignore__', text: '— Ignorer —', selected: fm.col === null }),
      h('option', { value: NEW, text: '➕ Créer « ' + (fm.newName || f.key) + ' »', selected: fm.col === NEW }),
      cols.filter(function (c) { return c.id !== linkUsed; }).map(function (c) {
        return h('option', { value: c.id, text: c.label + ' · ' + C.baseType(c.type), selected: fm.col === c.id });
      }));

    var typeCell = h('td', {});
    if (fm.col === NEW) {
      typeCell.append(
        h('select', { onchange: function (e) { fm.type = e.target.value; } },
          C.GRIST_TYPES.map(function (t) { return h('option', { value: t, text: t, selected: (fm.type || f.gType) === t }); })),
        h('input', { type: 'text', value: fm.newName, title: 'Identifiant de la colonne à créer',
          onchange: function (e) { fm.newName = e.target.value; renderConfig(); } }));
    }

    return h('tr', {},
      h('td', {}, h('div', { class: 'f-title', text: f.title }), h('code', { class: 'f-key', text: f.key })),
      h('td', { text: QTYPE_LABEL[f.qType] || f.qType }),
      h('td', {}, colSel), typeCell,
      h('td', {}, fieldStatus(f, fm, gm)));
  }

  // Retire les colonnes des vues (champs de sections) : elles restent dans la table mais sont masquées.
  async function hideColumns(items) {
    var tabs = await grist.docApi.fetchTable('_grist_Tables');
    var cols = await grist.docApi.fetchTable('_grist_Tables_column');
    var fields = await grist.docApi.fetchTable('_grist_Views_section_field');
    var tref = {};
    tabs.id.forEach(function (id, i) { tref[tabs.tableId[i]] = id; });
    var refs = {};
    items.forEach(function (it) {
      cols.id.forEach(function (id, i) {
        if (cols.parentId[i] === tref[it.table] && cols.colId[i] === it.col) refs[id] = true;
      });
    });
    var rm = fields.id.filter(function (id, i) { return refs[fields.colRef[i]]; });
    if (rm.length) await applyUA([['BulkRemoveRecord', '_grist_Views_section_field', rm]]);
  }

  async function createMissing() {
    S.busy = true;
    renderConfig();
    var tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
    var mapping = S.draft.mapping;
    var pending = []; // champs Pièces jointes en mode « identifiants » : formule à ajouter, colonne à masquer
    var idsMode = S.draft.attachmentsMode !== 'direct';
    function mkSpec(f, gm) {
      var fm = gm.fields[f.key];
      var spec = C.colSpec(f, fm, tz);
      if (idsMode && (fm.type || f.gType) === 'Attachments') {
        pending.push({ gm: gm, key: f.key, name: spec.id, label: f.title || f.key });
        spec.id = C.sanitizeColId(spec.id + '_ids');
        spec.type = 'Text';
        spec.label = (f.title || f.key) + ' (id des documents)';
        delete spec.widgetOptions;
      }
      return spec;
    }
    try {
      await (async function rec(g, parentTable) {
        var gm = mapping[g.id];
        var toCreate = g.fields.filter(function (f) { return gm.fields[f.key] && gm.fields[f.key].col === NEW; });
        if (g.id !== ROOT && gm.table === NEW) {
          var specs = [{ id: C.sanitizeColId(gm.newLinkName || parentTable), type: 'Ref:' + parentTable, isFormula: false, label: gm.newLinkName || parentTable }];
          toCreate.forEach(function (f) { specs.push(mkSpec(f, gm)); });
          var rv = await applyUA([['AddTable', gm.newTableName || C.sanitizeTableId(g.key), specs]]);
          var info = rv[0];
          var ids = info.columns;
          gm.table = info.table_id;
          if (!Array.isArray(ids) || ids.length !== specs.length) {
            await loadMeta();
            var made = S.meta.tables[gm.table].columns;
            ids = specs.map(function (sp) {
              var c = made.filter(function (x) { return x.label === sp.label; })[0];
              return c && c.id;
            });
          }
          gm.linkCol = ids[0];
          toCreate.forEach(function (f, i) { gm.fields[f.key].col = ids[i + 1]; });
        } else {
          if (g.id !== ROOT && gm.linkCol === NEW) {
            var lr = await applyUA([['AddColumn', gm.table, C.sanitizeColId(gm.newLinkName || parentTable),
              { type: 'Ref:' + parentTable, isFormula: false, label: gm.newLinkName || parentTable }]]);
            gm.linkCol = lr[0].colId;
          }
          for (var i = 0; i < toCreate.length; i++) {
            var f = toCreate[i];
            var spec = mkSpec(f, gm);
            var id = spec.id;
            delete spec.id;
            var r = await applyUA([['AddColumn', gm.table, id, spec]]);
            gm.fields[f.key].col = r[0].colId;
          }
        }
        for (var k = 0; k < g.groups.length; k++) await rec(g.groups[k], gm.table);
      })(S.analysis, null);
      // colonnes formule « Pièces jointes » relisant les identifiants, puis masquage des colonnes d'identifiants
      var toHide = [];
      for (var pi = 0; pi < pending.length; pi++) {
        var pd = pending[pi];
        var idsCol = pd.gm.fields[pd.key].col;
        await applyUA([['AddColumn', pd.gm.table, pd.name,
          { type: 'Attachments', isFormula: true, formula: C.attachmentsFormula(idsCol), label: pd.label }]]);
        toHide.push({ table: pd.gm.table, col: idsCol });
      }
      if (toHide.length) {
        try { await hideColumns(toHide); } catch (eh) { console.warn('Masquage impossible', eh); toast('Colonnes d’identifiants créées mais non masquées : masquez-les manuellement.', 'error'); }
      }
      await loadMeta();
      toast('Tables et colonnes créées', 'ok');
    } catch (e) {
      console.error(e);
      toast('Création impossible : ' + (e.message || e), 'error');
      try { await loadMeta(); } catch (e2) { /* ignoré */ }
    }
    S.busy = false;
    renderConfig();
  }

  /* ---- Onglet 3 : apparence -------------------------------------------- */

  function renderLookTab(body) {
    var T = window.SurveyTheme || {};
    var names = Object.keys(T).filter(function (k) { return /^[A-Z]/.test(k) && T[k] && T[k].cssVariables; }).sort();

    var themeSel = h('select', { onchange: function (e) { S.draft.theme = e.target.value; renderPreview(); } },
      names.map(function (n) { return h('option', { value: n, text: n.replace(/([a-z])([A-Z])/g, '$1 $2'), selected: S.draft.theme === n }); }));

    var customTheme = h('textarea', { class: 'code small', spellcheck: 'false',
      placeholder: 'Optionnel : collez ici un thème exporté depuis l’éditeur de thèmes SurveyJS Creator (JSON). Il remplace le thème choisi ci-dessus.' });
    customTheme.value = S.draft.customTheme ? JSON.stringify(S.draft.customTheme, null, 2) : '';
    var customThemeStatus = h('div', { class: 'status' });
    customTheme.addEventListener('input', function () {
      var t = customTheme.value.trim();
      customThemeStatus.className = 'status';
      if (!t) { S.draft.customTheme = null; customThemeStatus.textContent = ''; renderPreview(); return; }
      try { S.draft.customTheme = JSON.parse(t); customThemeStatus.classList.add('good'); customThemeStatus.textContent = '✓ Thème personnalisé valide'; renderPreview(); }
      catch (e) { customThemeStatus.classList.add('bad'); customThemeStatus.textContent = '✗ ' + e.message; }
    });

    var optsTa = h('textarea', { class: 'code small', spellcheck: 'false',
      placeholder: '{\n  "locale": "fr",\n  "showProgressBar": "top",\n  "questionTitleLocation": "top",\n  "showQuestionNumbers": "off",\n  "completeText": "Envoyer"\n}' });
    optsTa.value = Object.keys(S.draft.surveyOptions || {}).length ? JSON.stringify(S.draft.surveyOptions, null, 2) : '';
    var optsStatus = h('div', { class: 'status' });
    optsTa.addEventListener('input', function () {
      var t = optsTa.value.trim();
      optsStatus.className = 'status';
      if (!t) { S.draft.surveyOptions = {}; optsStatus.textContent = ''; renderPreview(); return; }
      try { S.draft.surveyOptions = JSON.parse(t); optsStatus.classList.add('good'); optsStatus.textContent = '✓ Options valides'; renderPreview(); }
      catch (e) { optsStatus.classList.add('bad'); optsStatus.textContent = '✗ ' + e.message; }
    });

    var cssTa = h('textarea', { class: 'code small', spellcheck: 'false', placeholder: '.sd-root-modern { --sjs-primary-backcolor: #0a7d5a; }' });
    cssTa.value = S.draft.customCss || '';
    cssTa.addEventListener('input', function () { S.draft.customCss = cssTa.value; applyCustomCss(cssTa.value); });

    body.append(
      h('div', { class: 'grid2 wide' },
        h('label', { text: 'Thème SurveyJS' }), themeSel),
      h('details', {}, h('summary', { text: 'Thème personnalisé (JSON)' }), customTheme, customThemeStatus),
      h('details', { open: Object.keys(S.draft.surveyOptions || {}).length > 0 },
        h('summary', { text: 'Options SurveyJS (langue, barre de progression, libellés…)' }),
        h('p', { class: 'hint', html: 'Toute propriété du <a href="https://surveyjs.io/form-library/documentation/api-reference/survey-data-model" target="_blank" rel="noopener">modèle SurveyJS</a> peut être définie ici. Pour la langue, utilisez <code>"locale": "fr"</code>.' }),
        optsTa, optsStatus),
      h('details', {}, h('summary', { text: 'CSS personnalisé' }), cssTa),
      h('h3', { text: 'Aperçu (rien n’est enregistré)' }),
      h('div', { id: 'preview' }),
      h('pre', { id: 'preview-out', class: 'code out', hidden: true })
    );
    renderPreview();
  }

  function renderPreview() {
    var host = $('#preview');
    if (!host) return;
    disposeModel(S.previewModel);
    S.previewModel = null;
    host.innerHTML = '';
    var out = $('#preview-out');
    if (out) out.hidden = true;
    if (!S.draft.jsonText || S.parseError) { host.append(h('p', { class: 'hint', text: 'Ajoutez d’abord un JSON valide.' })); return; }
    try {
      applyCustomCss(S.draft.customCss);
      var m = createModel(S.draft, null);
      S.previewModel = m;
      m.onComplete.add(async function (sender, options) {
        options.showSaveInProgress();
        try {
          var res = S.draft.mapping ? await saveSurveyDry(sender.data) : sender.data;
          out.textContent = (S.draft.mapping ? 'Simulation — enregistrements qui seraient créés :\n' : 'Données du formulaire :\n') + JSON.stringify(res, null, 2);
          out.hidden = false;
          options.showSaveSuccess();
        } catch (e) { options.showSaveError(e.message); }
      });
      var holder = h('div');
      host.append(holder);
      m.render(holder);
    } catch (e) {
      host.append(h('p', { class: 'status bad', text: e.message }));
    }
  }

  async function saveSurveyDry(data) {
    var saved = S.config;
    S.config = S.draft;
    try { return await saveSurvey(data, { dry: true }); } finally { S.config = saved; }
  }

  /* ---- Onglet 4 : comportement ----------------------------------------- */

  function renderBehaviorTab(body) {
    function radio(name, value, label, desc) {
      return h('label', { class: 'radio' },
        h('input', { type: 'radio', name: name, value: value, checked: S.draft[name] === value,
          onchange: function () { S.draft[name] = value; renderConfig(); } }),
        h('span', {}, h('strong', { text: label }), desc ? h('small', { text: desc }) : null));
    }
    body.append(
      h('h3', { text: 'Que fait le formulaire ?' }),
      radio('mode', 'new', 'Créer une nouvelle ligne à chaque envoi', 'Mode « saisie » : idéal pour les utilisateurs externes (règles d’accès Grist).'),
      radio('mode', 'edit', 'Modifier la ligne sélectionnée', 'Les données de la ligne (et de ses tables liées) pré-remplissent le formulaire. Les lignes liées sont remplacées à l’envoi.'),
      S.draft.mode === 'new' ? h('div', {},
        h('h3', { text: 'Après l’envoi' }),
        radio('afterSubmit', 'again', 'Proposer « Nouvelle saisie »'),
        radio('afterSubmit', 'auto', 'Réinitialiser automatiquement après 2 secondes'),
        radio('afterSubmit', 'none', 'Afficher uniquement le message de remerciement')) : null,
      h('h3', { text: 'Pièces jointes' }),
      radio('attachmentsMode', 'ids', 'Identifiants + colonne formule (recommandé pour les non-propriétaires)', 'Les fichiers sont envoyés avec l’API des widgets ; leurs identifiants sont écrits dans une colonne texte masquée « id des documents », et une colonne formule de type Pièces jointes les relit.'),
      radio('attachmentsMode', 'direct', 'Écriture directe dans une colonne Pièces jointes', 'Fonctionne pour les propriétaires du document ; peut échouer pour les autres utilisateurs.'),
      h('p', { class: 'hint', html: 'Le message de fin se personnalise avec <code>completedHtml</code> dans le JSON du formulaire.' })
    );
  }

  /* ------------------------------------------------------------------ */
  /* Démarrage                                                           */
  /* ------------------------------------------------------------------ */

  function init() {
    grist.ready({ requiredAccess: 'full', onEditOptions: openConfig });

    grist.onOptions(function (options) {
      var c = (options && options.config) || {};
      S.config = Object.assign(C.clone(DEFAULT_CONFIG), c);
      if (!S.configOpen) renderForm();
    });

    grist.onRecord(function (rec) {
      var changed = !S.record || !rec || S.record.id !== rec.id;
      S.record = rec;
      if (S.config.mode === 'edit' && changed && !S.configOpen) renderForm();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

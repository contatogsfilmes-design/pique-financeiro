/* Versão iPad (artifact do claude.ai): imita a parte do Firebase que o app usa,
   guardando o estado no banco do próprio artifact (capability db). Sem db
   (ex: aberto fora do claude.ai), cai pro localStorage deste aparelho. */
(function () {
  const OWNER = { email: "contatogsfilmes@gmail.com", displayName: "Biel", photoURL: null };
  const DOC_PATH = "estado/dados";
  const LS_KEY = "financeiro-trec-ipad";
  const TS = { __serverTimestamp: true };
  let lsCb = null;
  let dbPromise = null;
  function getDb() {
    if (!dbPromise) dbPromise = (window.claude && window.claude.use ? window.claude.use("db") : Promise.resolve(null)).catch(() => null);
    return dbPromise;
  }
  const clean = d => JSON.parse(JSON.stringify(d, (k, v) => k === "__reload" ? undefined : (v && v.__serverTimestamp) ? new Date().toISOString() : v));
  function lsGet(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function status(msg, bad) { window.__ipadStatus && window.__ipadStatus(msg, bad); }

  const estadoRef = {
    async set(data) {
      const body = clean(data);
      const size = JSON.stringify(body).length;
      const db = await getDb();
      if (!db) { lsSet(LS_KEY, body); status("Salvo neste aparelho"); if (data.__reload && lsCb) lsCb({ exists: true, data: () => clean(body) }); return; }
      if (size > 240000) status("Atenção: os dados estão perto do limite de 256 KB. Me chama pra dividir o armazenamento.", true);
      try { await db.doc(DOC_PATH).set(body); status("Salvo"); }
      catch (e) { status("Não consegui salvar (" + (e && e.code || "erro") + "). Tente de novo em instantes.", true); throw e; }
    },
    onSnapshot(cb) {
      getDb().then(db => {
        if (!db) {
          status("Sem conexão com o banco do claude.ai: salvando só neste aparelho.", true);
          const d = lsGet(LS_KEY);
          lsCb = cb;
          cb({ exists: !!d, data: () => d ? JSON.parse(JSON.stringify(d)) : undefined });
          return;
        }
        db.doc(DOC_PATH).onSnapshot(snap => {
          const d = snap.exists ? JSON.parse(JSON.stringify(snap.data())) : null;
          cb({ exists: !!d, data: () => d || undefined });
        }, err => status("Conexão com o banco caiu (" + err.code + "). Recarregue a página.", true));
      });
    },
  };
  // Perfil (foto/nome) fica só neste aparelho.
  const perfilRef = id => ({
    async get() { const d = lsGet("perfil-" + id); return { exists: !!d, data: () => d }; },
    async set(d, opts) { lsSet("perfil-" + id, Object.assign(opts && opts.merge ? (lsGet("perfil-" + id) || {}) : {}, d)); },
  });
  const fs = {
    doc: p => p === "empresas/pique/estado/dados" ? estadoRef : perfilRef(p),
    collection: p => ({ doc: id => perfilRef(p + "/" + id) }),
  };
  const auth = {
    onAuthStateChanged(cb) { setTimeout(() => cb(OWNER), 0); },
    async signOut() {}, async signInWithPopup() {},
  };
  window.firebase = {
    initializeApp() {},
    auth: Object.assign(() => auth, { GoogleAuthProvider: function () {} }),
    firestore: Object.assign(() => fs, { FieldValue: { serverTimestamp: () => TS } }),
  };

  // Backup: exportar/importar o estado inteiro em JSON.
  window.__ipadExport = async function () {
    const db = await getDb();
    let data = null;
    if (db) { const s = await db.doc(DOC_PATH).get(); data = s.exists ? s.data() : null; } else data = lsGet(LS_KEY);
    if (!data) { status("Ainda não há dados pra exportar.", true); return; }
    const txt = JSON.stringify(data, null, 2);
    const dl = await (window.claude && window.claude.use ? window.claude.use("downloads") : null);
    const nome = "financeiro-trec-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    if (dl) { try { await dl.save({ filename: nome, data: txt }); status("Backup exportado"); return; } catch (e) { if (e && e.code === "declined") return; } }
    // Sem downloads: mostra o JSON pra copiar.
    const ta = document.getElementById("ipadBackupText");
    ta.value = txt; document.getElementById("ipadBackupBox").hidden = false; ta.select();
  };
  window.__ipadImport = async function (file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || !Array.isArray(data.bills || [])) throw new Error("formato");
      await estadoRef.set(Object.assign({}, data, { __reload: true }));
      status("Backup importado");
    } catch (e) { status("Esse arquivo não é um backup do Financeiro T-Rec.", true); }
  };
})();

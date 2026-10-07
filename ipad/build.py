"""Gera ipad/financeiro-trec-ipad.html: o app inteiro numa página só, pra
publicar como artifact do claude.ai (versão iPad). Rode: python3 ipad/build.py"""
import base64, re, pathlib, json
BM = "javascript:(function(){if(!window.firebase||!firebase.firestore){alert('Abra o site do Financeiro T-Rec, entre com o Google e toque neste favorito de novo.');return;}firebase.firestore().doc('empresas/pique/estado/dados').get().then(function(s){var t=JSON.stringify(s.data()||{});var a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;left:5%;top:5%;width:90%;height:70%;z-index:2147483647;font:12px monospace;background:#fff;color:#000;border:3px solid #ED703A;padding:8px';document.body.appendChild(a);a.focus();a.select();a.setSelectionRange(0,t.length);var ok=false;try{ok=document.execCommand('copy')}catch(e){}alert(ok?'Dados copiados! Agora cole no Financeiro iPad, em Importar dados.':'Toque no texto, Selecionar Tudo e Copiar. Depois cole no Financeiro iPad, em Importar dados.')}).catch(function(e){alert('Erro: '+e.message)})})()"
root = pathlib.Path(__file__).resolve().parent.parent
html = (root / "index.html").read_text()
app = (root / "app.js").read_text()
shim = (root / "ipad/shim.js").read_text()
logo = "data:image/png;base64," + base64.b64encode((root / "assets/trec-horizontal-paper.png").read_bytes()).decode()

style = re.search(r"<style>(.*?)</style>", html, re.S).group(1)
fonts = re.search(r'<link rel="stylesheet" href="https://fonts.googleapis.com[^>]+>', html).group(0)
body = html[html.index('<div class="app" id="appRoot"'):html.index('<script src="https://www.gstatic.com')]
body = body.replace('src="assets/trec-horizontal-paper.png"', f'src="{logo}"')
body = body.replace('<button class="signout-btn" id="btnSignOut" type="button">Sair da conta</button>', '''<button class="signout-btn" id="btnExport" type="button">Exportar backup</button>
      <button class="signout-btn" id="btnImportOpen" type="button">Importar dados</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
      <span class="ipad-status" id="ipadStatus" aria-live="polite"></span>
      <button id="btnSignOut" type="button" hidden></button>''')
body = body.replace('<main class="content">', '''<main class="content">
    <div class="ipad-backup" id="ipadImportBox" hidden>
      <h2 style="font-size:17px;">Trazer os dados do site antigo</h2>
      <ol class="ipad-steps">
        <li>Copie o código abaixo (botão “Copiar código”).</li>
        <li>No Safari, adicione qualquer página aos Favoritos. Depois edite esse favorito: troque o nome por <b>Exportar Financeiro</b> e apague o endereço, colando o código no lugar.</li>
        <li>Abra o site antigo (<span class="sel">contatogsfilmes-design.github.io/pique-financeiro</span>), entre com o Google e, já dentro do sistema, toque no favorito <b>Exportar Financeiro</b>. Os dados são copiados (se não copiar sozinho, toque no texto que aparece, Selecionar Tudo e Copiar).</li>
        <li>Volte aqui, cole no campo de baixo e toque em <b>Importar</b>.</li>
      </ol>
      <textarea id="ipadBookmarklet" rows="3" readonly></textarea>
      <div class="ipad-row"><button class="btn btn-sm" id="btnCopyBm" type="button">Copiar código</button></div>
      <label for="ipadImportText" class="stat-label">Cole aqui os dados copiados</label>
      <textarea id="ipadImportText" rows="5" placeholder='{"bills":[...],"clients":[...]}'></textarea>
      <label class="check-line"><input type="radio" name="impModo" value="juntar" checked> Juntar com o que já cadastrei aqui</label>
      <label class="check-line"><input type="radio" name="impModo" value="substituir"> Substituir tudo daqui pelos dados colados</label>
      <div class="ipad-row">
        <button class="btn btn-accent btn-sm" id="btnImportGo" type="button">Importar</button>
        <label class="btn btn-sm" for="importFile" style="cursor:pointer;">Escolher arquivo de backup</label>
        <button class="btn btn-sm" type="button" id="btnImportClose">Fechar</button>
      </div>
    </div>
    <div class="ipad-backup" id="ipadBackupBox" hidden>
      <p>Copie o texto abaixo e guarde (Notas, WhatsApp, e-mail). É o backup completo do financeiro.</p>
      <textarea id="ipadBackupText" rows="6" readonly></textarea>
      <button class="btn btn-sm" type="button" onclick="document.getElementById('ipadBackupBox').hidden = true">Fechar</button>
    </div>''')
login = '''<div id="loginScreen" hidden><button id="btnGoogleLogin" type="button" hidden></button><div id="loginStatus"></div></div>'''
extra_css = '''
  .ipad-status{ font-size:11.5px; color:#C7B790; min-height:14px; }
  .ipad-status.bad{ color:#FF8A7A; }
  .ipad-backup{ background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px; margin-bottom:18px; display:flex; flex-direction:column; gap:10px; }
  .ipad-backup p{ margin:0; font-size:13px; color:var(--ink-soft); }
  .ipad-backup textarea{ width:100%; font-family:"Space Mono",ui-monospace,monospace; font-size:11px; background:var(--surface-2); color:var(--ink); border:1px solid var(--border); border-radius:8px; padding:8px; }
  .ipad-backup .btn{ align-self:flex-start; }
  .ipad-steps{ margin:0; padding-left:20px; display:flex; flex-direction:column; gap:6px; font-size:13px; color:var(--ink-soft); line-height:1.5; max-width:70ch; }
  .ipad-steps .sel{ user-select:all; font-family:"Space Mono",ui-monospace,monospace; font-size:12px; color:var(--ink); word-break:break-all; }
  .ipad-row{ display:flex; gap:8px; flex-wrap:wrap; }
  @media (max-width:820px){
    .app{ grid-template-columns:minmax(0,1fr); }
    .sidebar{ min-width:0; }
    .sidebar{ position:static; height:auto; padding:14px 16px; gap:12px; }
    .brand{ padding:0 0 10px; }
    .nav{ flex-direction:row; overflow-x:auto; flex:none; }
    .nav-item{ flex:none; }
    .sidebar-foot{ flex-direction:row; flex-wrap:wrap; align-items:center; }
    .content{ padding:20px 16px 48px; }
    .stat-grid{ grid-template-columns:1fr 1fr; }
    .board{ grid-template-columns:1fr; }
    .cal-cell{ min-height:64px; }
  }
  @media (max-width:480px){ .stat-grid{ grid-template-columns:1fr; } }
'''
glue = '''
window.__ipadStatus = (msg, bad) => { const el = document.getElementById("ipadStatus"); if (!el) return; el.textContent = msg; el.classList.toggle("bad", !!bad); clearTimeout(window.__ipadT); if (!bad) window.__ipadT = setTimeout(() => { el.textContent = ""; }, 2500); };
document.getElementById("btnExport").addEventListener("click", () => window.__ipadExport());
const BOOKMARKLET = __BM__;
document.getElementById("ipadBookmarklet").value = BOOKMARKLET;
document.getElementById("btnImportOpen").addEventListener("click", () => { document.getElementById("ipadImportBox").hidden = false; window.scrollTo(0, 0); });
document.getElementById("btnImportClose").addEventListener("click", () => { document.getElementById("ipadImportBox").hidden = true; });
document.getElementById("btnCopyBm").addEventListener("click", () => {
  const ta = document.getElementById("ipadBookmarklet");
  const done = () => window.__ipadStatus("Código copiado");
  try { navigator.clipboard.writeText(BOOKMARKLET).then(done, () => { ta.select(); ta.setSelectionRange(0, BOOKMARKLET.length); window.__ipadStatus("Selecionei o código: toque em Copiar", false); }); }
  catch (e) { ta.select(); ta.setSelectionRange(0, BOOKMARKLET.length); }
});
document.getElementById("btnImportGo").addEventListener("click", async () => {
  const txt = document.getElementById("ipadImportText").value;
  if (!txt.trim()) { document.getElementById("ipadImportText").focus(); return; }
  const modo = document.querySelector('input[name="impModo"]:checked').value;
  if (modo === "substituir" && !await uiConfirm("Substituir tudo que está aqui pelos dados colados?")) return;
  if (await window.__ipadImportText(txt, modo)) { document.getElementById("ipadImportText").value = ""; document.getElementById("ipadImportBox").hidden = true; }
});
document.getElementById("importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (f && await uiConfirm("Importar este backup? Ele é juntado com o que já está aqui.")) { if (await window.__ipadImport(f)) document.getElementById("ipadImportBox").hidden = true; }
});
'''
glue = glue.replace("__BM__", json.dumps(BM))
out = f'''<title>Financeiro T-Rec</title>
{fonts}
<style>{style}{extra_css}</style>
{login}
{body}
<script>{shim}</script>
<script>{app}
{glue}</script>
'''
(root / "ipad/financeiro-trec-ipad.html").write_text(out)
print("ok", len(out))

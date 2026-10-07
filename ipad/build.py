"""Gera ipad/financeiro-trec-ipad.html: o app inteiro numa página só, pra
publicar como artifact do claude.ai (versão iPad). Rode: python3 ipad/build.py"""
import base64, re, pathlib
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
      <label class="signout-btn" for="importFile" style="cursor:pointer;">Importar backup</label>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
      <span class="ipad-status" id="ipadStatus" aria-live="polite"></span>
      <button id="btnSignOut" type="button" hidden></button>''')
body = body.replace('<main class="content">', '''<main class="content">
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
document.getElementById("importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (f && await uiConfirm("Importar este backup? Ele substitui todos os dados atuais do financeiro.")) window.__ipadImport(f);
});
'''
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

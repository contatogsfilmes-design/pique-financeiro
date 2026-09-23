/* Financeiro T-Rec — lógica do app.
   Fonte de verdade dos dados: Firestore, doc empresas/pique/estado/dados.
   Acesso: lista fixa de e-mails (ver ALLOWED_EMAILS abaixo E firestore.rules —
   as duas listas precisam ser iguais). Pra liberar mais alguém, adiciona o
   e-mail nas duas.
*/

const auth = firebase.auth();
const db = firebase.firestore();

const ALLOWED_EMAILS = [
  "contatogsfilmes@gmail.com",
  "henriqueronanc@gmail.com",
  "gabriel@pique.digital",
  "henrique@pique.digital",
];

const PAYMENT_METHODS = ["Pix", "Cartão de crédito", "Cartão de débito", "Transferência (TED/DOC)", "Boleto", "Dinheiro"];
const TAG_PALETTE = ["#B5652C", "#5B7FBF", "#C2519A", "#4F8A3D", "#C9A227", "#6E4A9E"];
const DEFAULT_TAGS = [
  { id: "assinatura-digital", label: "Assinatura Digital", color: "#EFA54D" },
  { id: "operacional", label: "Operacional", color: "#7A8A90" },
  { id: "investimento", label: "Investimento", color: "#ED703A" },
  { id: "custo-funcionario", label: "Custo Funcionário", color: "#2E7D9A" },
  { id: "salario", label: "Salário", color: "#8A5AC2" },
];

const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const TODAY_ISO = isoOf(TODAY);
let calYear = TODAY.getFullYear();
let calMonth = TODAY.getMonth();

let currentUser = null;
let currentMember = null;
let currentModalId = null;
let billFilter = "todos";
let saveTimer = null;

let freelaYear = TODAY.getFullYear();
let freelaMonth = TODAY.getMonth();

const state = { bills: [], tags: DEFAULT_TAGS.slice(), clients: [], employees: [], notas: [], freelas: [], caixaAtual: 0 };

// ---------------- helpers ----------------
function brl(n) { return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function parseBRL(s) { return Number(String(s).replace(/[^\d,-]/g, "").replace(",", ".")) || 0; }
function isoOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function fmtDate(iso) { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }); }
function fmtDateFull(iso) { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }); }
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); }
function slugify(s) { return s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function endOfMonthISO() { const y = TODAY.getFullYear(), m = TODAY.getMonth(); const last = new Date(y, m + 1, 0).getDate(); return `${y}-${String(m + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`; }
function nextDueISO(diaStr) {
  const dia = Math.min(28, Math.max(1, parseInt(diaStr, 10) || TODAY.getDate()));
  let y = TODAY.getFullYear(), m = TODAY.getMonth();
  if (dia < TODAY.getDate()) { m++; if (m > 11) { m = 0; y++; } }
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}
function tagById(id) { return state.tags.find(t => t.id === id); }
function tagOptionsHTML(selectedId) {
  return state.tags.map(t => `<option value="${t.id}" ${t.id === selectedId ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("") + '<option value="__new__">+ Nova tag…</option>';
}
function wireNewTagOption(selectEl, fallbackId) {
  selectEl.addEventListener("change", e => {
    if (e.target.value !== "__new__") return;
    const label = prompt("Nome da nova tag (ex: Marketing, Impostos):");
    const id = label && addTag(label);
    if (!id) { e.target.value = fallbackId || ""; return; }
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = label.trim();
    e.target.querySelector('option[value="__new__"]').insertAdjacentElement("beforebegin", opt);
    e.target.value = id;
    fallbackId = id;
    renderFilterChips();
    scheduleSave();
  });
}
function addTag(label) {
  const id = slugify(label);
  if (!id) return null;
  const existing = state.tags.find(t => t.id === id);
  if (existing) return existing.id;
  const idx = state.tags.length - DEFAULT_TAGS.length;
  state.tags.push({ id, label: label.trim(), color: TAG_PALETTE[((idx % TAG_PALETTE.length) + TAG_PALETTE.length) % TAG_PALETTE.length] });
  return id;
}
function requireAdmin() {
  if (!currentMember || currentMember.role !== "admin") {
    alert("Você está no modo Visualização — só administradores podem editar.");
    return false;
  }
  return true;
}
function bucket(b) {
  const due = new Date(b.due + "T00:00:00");
  const diff = Math.round((due - TODAY) / 86400000);
  if (diff < 0) return "atrasado";
  if (diff <= 7) return "soon";
  return "upcoming";
}
function payPillMeta(b) {
  if (!b) return { cls: "pendente", text: "Pendente" };
  if (b.status === "pago") return { cls: "pago", text: "Pago " + fmtDate(b.paidOn) };
  const bk = bucket(b);
  return bk === "atrasado" ? { cls: "atrasado", text: "Atrasado" } : { cls: "pendente", text: "Pendente" };
}
function displayTitle(b) { return (b.kind === "Parcelado" && b.parcelas) ? `${b.title} · ${b.parcelaAtual}/${b.parcelas}` : b.title; }
function getActiveRevenue() { return state.clients.filter(c => c.status === "ativo").reduce((s, c) => s + Number(c.valor || 0), 0); }
function monthKeyOf(y, m) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
function addMonthsISO(iso, k) {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(y, m - 1 + k, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return isoOf(new Date(target.getFullYear(), target.getMonth(), Math.min(d, last)));
}
// Receita de freelances num mês = soma das parcelas que vencem naquele mês
// (não do valor fechado), pra projeção refletir quando o dinheiro entra de fato.
function freelaParcelasDoMes(key) {
  const out = [];
  (state.freelas || []).forEach(f => (f.parcelas || []).forEach((p, idx) => { if (p.venc && p.venc.slice(0, 7) === key) out.push({ f, p, idx }); }));
  return out.sort((a, b) => a.p.venc.localeCompare(b.p.venc));
}
function freelaRevenue(key) { return freelaParcelasDoMes(key).reduce((s, x) => s + Number(x.p.valor || 0), 0); }
function empTotal(emp) { return Number(emp.base || 0) + (emp.despesas || []).reduce((s, d) => s + Number(d.valor || 0), 0); }

// ---------------- persistence ----------------
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 900);
}
function saveNow() {
  if (!currentMember || currentMember.role !== "admin") return;
  db.doc("empresas/pique/estado/dados").set({
    bills: state.bills, tags: state.tags, clients: state.clients, employees: state.employees,
    notas: state.notas, freelas: state.freelas, caixaAtual: state.caixaAtual,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: currentUser ? currentUser.email : null,
  }).catch(err => console.error("Erro ao salvar:", err));
}
function subscribeState() {
  db.doc("empresas/pique/estado/dados").onSnapshot(snap => {
    const data = snap.exists ? snap.data() : {};
    state.bills = data.bills || [];
    state.tags = (data.tags && data.tags.length) ? data.tags : DEFAULT_TAGS.slice();
    state.clients = data.clients || [];
    state.employees = data.employees || [];
    state.notas = data.notas || [];
    state.freelas = data.freelas || [];
    state.caixaAtual = data.caixaAtual || 0;
    renderAll();
  }, err => console.error("Erro ao ler estado:", err));
}

// ---------------- tabs ----------------
const titles = {
  dashboard: ["Dashboard", "Visão geral do caixa, contas e operação"],
  contas: ["Contas a Pagar", "Calendário e quadro de vencimentos de todas as contas da T-Rec"],
  custos: ["Custos Mensais", "Ferramentas, parcelamentos e folha de pagamento"],
  clientes: ["Clientes", "Cadastro, status e recorrência de pagamento"],
  freelas: ["Freelances", "Trabalhos avulsos do mês e quando cada pagamento entra no caixa"],
  notas: ["Notas Fiscais", "Arquivo de comprovantes por prestador de serviço"],
  equipe: ["Equipe & Acesso", "Quem pode entrar no financeiro da T-Rec e com qual permissão"],
};
document.querySelectorAll(".nav-item").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById("tab-" + tab).classList.add("active");
    document.getElementById("pageTitle").textContent = titles[tab][0];
    document.getElementById("pageSubtitle").textContent = titles[tab][1];
  });
});
document.querySelectorAll(".subtab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".subtab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".subpanel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("sub-" + btn.dataset.sub).classList.add("active");
  });
});

// ---------------- Contas a Pagar: filters, board, calendar ----------------
function currentFilteredBills() { return state.bills.filter(b => billFilter === "todos" || b.tagId === billFilter); }
function renderFilterChips() {
  const isAdmin = currentMember && currentMember.role === "admin";
  const chips = ['<button class="filter-chip ' + (billFilter === "todos" ? "active" : "") + '" data-filter="todos">Todos</button>']
    .concat(state.tags.map(t => `<button class="filter-chip ${billFilter === t.id ? "active" : ""}" data-filter="${t.id}"><span style="display:inline-block;width:7px;height:7px;border-radius:2px;background:${t.color};margin-right:5px;"></span>${escapeHtml(t.label)}</button>`));
  if (isAdmin) chips.push('<button class="filter-chip add" id="btnNewTag" type="button">+ Nova tag</button>');
  document.getElementById("billFilters").innerHTML = chips.join("");
}
function billCardHTML(b, cls) {
  const valCls = b.status === "pago" ? "pos" : "";
  const dateLabel = b.status === "pago" ? "pago " + fmtDate(b.paidOn) : (bucket(b) === "atrasado" ? "venceu " + fmtDate(b.due) : "vence " + fmtDate(b.due));
  const t = tagById(b.tagId);
  return `<div class="bill-card ${cls}" data-bill-id="${b.id}"><div class="bill-tag">${escapeHtml(b.kind)}${t ? " · " + escapeHtml(t.label) : ""}</div><div class="bill-title">${escapeHtml(displayTitle(b))}</div><div class="bill-foot"><span class="bill-value num ${valCls}">${brl(b.value)}</span><span class="bill-date">${dateLabel}</span></div></div>`;
}
function renderBoard() {
  const cols = { atrasado: [], soon: [], upcoming: [], pago: [] };
  currentFilteredBills().forEach(b => cols[b.status === "pago" ? "pago" : bucket(b)].push(b));
  const defs = [
    { key: "atrasado", label: "Atrasado", cls: "late" },
    { key: "soon", label: "Vence essa semana", cls: "soon" },
    { key: "upcoming", label: "A vencer", cls: "upcoming" },
    { key: "pago", label: "Pago", cls: "paid" },
  ];
  document.getElementById("boardGrid").innerHTML = defs.map(d => {
    const items = cols[d.key].sort((a, b) => a.due.localeCompare(b.due));
    const cards = items.map(b => billCardHTML(b, d.cls)).join("") || '<p class="empty-hint" style="padding:6px 4px;">Nada por aqui.</p>';
    return `<div class="board-col"><div class="board-col-head"><h3>${d.label}</h3><span class="board-count">${items.length}</span></div>${cards}</div>`;
  }).join("");
}
function renderCalendar() {
  const first = new Date(calYear, calMonth, 1);
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const startDow = first.getDay();
  document.getElementById("calTitle").textContent = first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const bills = currentFilteredBills();
  const dow = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  let html = dow.map(d => `<div class="cal-dow">${d}</div>`).join("");
  for (let i = 0; i < startDow; i++) html += `<div class="cal-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const isToday = iso === TODAY_ISO;
    const pills = bills.filter(b => b.due === iso).map(b => {
      const k = b.status === "pago" ? "pago" : bucket(b);
      const stCls = k === "atrasado" ? "st-atrasado" : k === "soon" ? "st-soon" : k === "pago" ? "st-pago" : "st-upcoming";
      const dt = displayTitle(b);
      const short = dt.length > 15 ? dt.slice(0, 14) + "…" : dt;
      return `<div class="cal-pill ${stCls}" data-bill-id="${b.id}" title="${escapeHtml(dt)} — ${brl(b.value)}"><span>${escapeHtml(short)}</span><span>${brl(b.value)}</span></div>`;
    }).join("");
    html += `<div class="cal-cell ${isToday ? "today" : ""}"><div class="cal-daynum">${day}</div>${pills}</div>`;
  }
  document.getElementById("calGrid").innerHTML = html;
}
document.getElementById("billFilters").addEventListener("click", e => {
  const btn = e.target.closest("button"); if (!btn) return;
  if (btn.id === "btnNewTag") {
    if (!requireAdmin()) return;
    const label = prompt("Nome da nova tag (ex: Marketing, Impostos):");
    if (!label) return;
    const id = addTag(label);
    if (!id) return;
    billFilter = id;
    renderFilterChips(); renderBoard(); renderCalendar(); updateChipEmAberto(); renderCostPie();
    scheduleSave();
    return;
  }
  if (!btn.dataset.filter) return;
  billFilter = btn.dataset.filter;
  renderFilterChips(); renderBoard(); renderCalendar(); updateChipEmAberto();
});
document.getElementById("btnNewTagDash").addEventListener("click", () => {
  if (!requireAdmin()) return;
  const label = prompt("Nome da nova tag (ex: Marketing, Impostos):");
  if (!label) return;
  addTag(label);
  renderFilterChips(); renderCostPie();
  scheduleSave();
});
document.getElementById("billView").addEventListener("click", e => {
  const btn = e.target.closest("button"); if (!btn) return;
  document.querySelectorAll("#billView button").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const v = btn.dataset.view;
  document.getElementById("view-calendario").classList.toggle("active", v === "calendario");
  document.getElementById("view-quadro").classList.toggle("active", v === "quadro");
});
document.getElementById("calPrev").addEventListener("click", () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); });
document.getElementById("calNext").addEventListener("click", () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); });
function updateChipEmAberto() {
  const total = currentFilteredBills().filter(b => b.status !== "pago").reduce((s, b) => s + b.value, 0);
  document.getElementById("chipEmAberto").textContent = brl(total);
}

// ---------------- Custos Mensais: tools / installments / employees ----------------
function renderToolsTable() {
  const rows = state.bills.filter(b => b.kind === "Ferramenta");
  document.getElementById("toolsBody").innerHTML = rows.length ? rows.map(b => {
    const pm = payPillMeta(b);
    return `<tr class="row-click" data-bill-id="${b.id}"><td>${escapeHtml(b.title)}</td><td>${escapeHtml(b.categoria || "")}</td><td class="num">${brl(b.value)}</td><td>${b.due.split("-")[2]}</td><td><span class="badge ativo">Ativo</span></td><td><button class="pay-pill ${pm.cls}">${pm.text}</button></td></tr>`;
  }).join("") : '<tr><td colspan="6" class="empty-hint">Nenhuma ferramenta cadastrada.</td></tr>';
}
function renderInstallmentsTable() {
  const rows = state.bills.filter(b => b.kind === "Parcelado");
  document.getElementById("installBody").innerHTML = rows.length ? rows.map(b => {
    const pm = payPillMeta(b);
    const restam = (b.parcelas || 1) - (b.parcelaAtual || 1);
    return `<tr class="row-click" data-bill-id="${b.id}"><td>${escapeHtml(b.title)}</td><td class="num">${brl(b.valorTotal || b.value)}</td><td>${b.parcelaAtual || 1}/${b.parcelas || 1}</td><td class="num">${brl(b.value)}</td><td>${fmtDateFull(b.due)}</td><td>${restam} parcelas</td><td><button class="pay-pill ${pm.cls}">${pm.text}</button></td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty-hint">Nenhum parcelamento cadastrado.</td></tr>';
}
function empCardEl(emp) {
  const div = document.createElement("div");
  div.className = "emp-card";
  div.dataset.id = emp.id;
  div.dataset.billId = emp.billId;
  const initials = emp.nome.trim().split(/\s+/).slice(0, 2).map(s => s[0].toUpperCase()).join("");
  const expHtml = (emp.despesas || []).map((d, i) => `<li data-idx="${i}" data-action="emp-edit-exp"><span>${escapeHtml(d.tipo)}${d.desc ? " · " + escapeHtml(d.desc) : ""} · ${fmtDate(d.data)}</span><span class="num">${brl(d.valor)}</span><button class="btn-ghost" data-action="emp-del-exp" title="Excluir gasto" type="button">✕</button></li>`).join("");
  const bill = state.bills.find(b => b.id === emp.billId);
  const pm = payPillMeta(bill);
  div.innerHTML = `
    <div class="emp-top">
      <div class="emp-avatar">${initials}</div>
      <div class="emp-info" data-action="emp-edit" title="Editar funcionário/prestador"><div class="emp-name">${escapeHtml(emp.nome)}</div><div class="emp-role">${escapeHtml(emp.funcao || "")}</div></div>
      <div class="emp-base" data-action="emp-edit" title="Editar funcionário/prestador"><div class="stat-label">Base</div><div class="num">${brl(emp.base)}</div></div>
      <button class="btn-ghost" data-action="emp-del" title="Excluir funcionário/prestador" type="button">✕</button>
    </div>
    <ul class="exp-list">${expHtml}</ul>
    <div class="add-exp-row">
      <select name="tipo"><option>Vale</option><option>Uber</option><option>Reembolso</option><option>Outro</option></select>
      <input name="desc" type="text" placeholder="Descrição do gasto">
      <input name="valor" type="text" placeholder="R$ 0,00">
      <button class="btn btn-sm" data-action="emp-add-exp" type="button">+</button>
    </div>
    <div class="emp-total"><span>Total a pagar <b class="num">${brl(empTotal(emp))}</b></span><button class="pay-pill ${pm.cls}">${pm.text}</button></div>`;
  return div;
}
function renderEmployees() {
  const grid = document.getElementById("empGrid");
  const addBtn = document.getElementById("btnAddEmp");
  grid.querySelectorAll(".emp-card").forEach(el => el.remove());
  state.employees.forEach(emp => grid.insertBefore(empCardEl(emp), addBtn));
  const total = state.employees.reduce((s, e) => s + empTotal(e), 0);
  document.getElementById("payrollTotal").textContent = brl(total);
}
function syncEmployeeBill(emp) {
  const bill = state.bills.find(b => b.id === emp.billId);
  if (bill) bill.value = empTotal(emp);
}
document.getElementById("empGrid").addEventListener("click", e => {
  const addBtn = e.target.closest('[data-action="emp-add-exp"]');
  if (addBtn) {
    if (!requireAdmin()) return;
    const card = addBtn.closest(".emp-card");
    const row = addBtn.closest(".add-exp-row");
    const emp = state.employees.find(x => x.id === card.dataset.id);
    if (!emp) return;
    const tipo = row.querySelector('[name="tipo"]').value;
    const desc = row.querySelector('[name="desc"]').value.trim();
    const valor = parseBRL(row.querySelector('[name="valor"]').value);
    if (!valor) return;
    emp.despesas = emp.despesas || [];
    emp.despesas.push({ tipo, desc, valor, data: TODAY_ISO });
    syncEmployeeBill(emp);
    renderAll();
    scheduleSave();
    return;
  }
  const delExpBtn = e.target.closest('[data-action="emp-del-exp"]');
  if (delExpBtn) {
    if (!requireAdmin()) return;
    const card = delExpBtn.closest(".emp-card");
    const emp = state.employees.find(x => x.id === card.dataset.id);
    if (!emp) return;
    const idx = Number(delExpBtn.closest("li").dataset.idx);
    if (!confirm("Excluir este gasto?")) return;
    emp.despesas.splice(idx, 1);
    syncEmployeeBill(emp);
    renderAll();
    scheduleSave();
    return;
  }
  const delBtn = e.target.closest('[data-action="emp-del"]');
  if (delBtn) {
    if (!requireAdmin()) return;
    const card = delBtn.closest(".emp-card");
    const emp = state.employees.find(x => x.id === card.dataset.id);
    if (!emp) return;
    if (!confirm(`Excluir ${emp.nome}? Isso também remove a conta de pagamento dele. Essa ação não pode ser desfeita.`)) return;
    state.employees = state.employees.filter(x => x.id !== emp.id);
    state.bills = state.bills.filter(b => b.id !== emp.billId);
    renderAll();
    scheduleSave();
    return;
  }
  const editExpBtn = e.target.closest('[data-action="emp-edit-exp"]');
  if (editExpBtn) {
    if (!requireAdmin()) return;
    const card = editExpBtn.closest(".emp-card");
    const emp = state.employees.find(x => x.id === card.dataset.id);
    if (!emp) return;
    const idx = Number(editExpBtn.dataset.idx);
    const d = (emp.despesas || [])[idx];
    if (!d) return;
    const tipo = prompt("Tipo (Vale, Uber, Reembolso, Outro):", d.tipo) || d.tipo;
    const desc = prompt("Descrição:", d.desc || "") || "";
    const valor = parseBRL(prompt("Valor (R$):", String(d.valor).replace(".", ",")) || "0");
    if (!valor) return;
    d.tipo = tipo; d.desc = desc; d.valor = valor;
    syncEmployeeBill(emp);
    renderAll();
    scheduleSave();
    return;
  }
  const editBtn = e.target.closest('[data-action="emp-edit"]');
  if (editBtn) {
    if (!requireAdmin()) return;
    const card = editBtn.closest(".emp-card");
    const emp = state.employees.find(x => x.id === card.dataset.id);
    if (!emp) return;
    openEmployeeForm(emp);
  }
});
document.getElementById("btnAddEmp").addEventListener("click", () => {
  if (!requireAdmin()) return;
  openEmployeeForm(null);
});
document.getElementById("btnAddTool").addEventListener("click", () => {
  if (!requireAdmin()) return;
  openToolForm(null);
});
document.getElementById("btnAddInstallment").addEventListener("click", () => {
  if (!requireAdmin()) return;
  openInstallmentForm(null);
});

// ---------------- Custos Mensais: form modal (create/edit ferramenta, parcelamento, funcionário) ----------------
function closeFormModal() { document.getElementById("formModalOverlay").classList.remove("open"); }
document.getElementById("formModalClose").addEventListener("click", closeFormModal);
document.getElementById("formModalOverlay").addEventListener("click", e => { if (e.target.id === "formModalOverlay") closeFormModal(); });
function openToolForm(bill) {
  const isEdit = !!bill;
  const readOnly = !currentMember || currentMember.role !== "admin";
  document.getElementById("formModalTitle").textContent = isEdit ? "Editar ferramenta" : "Nova ferramenta";
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field full"><label>Nome da ferramenta</label><input type="text" id="tfNome" value="${isEdit ? escapeHtml(bill.title) : ""}" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Categoria</label><input type="text" id="tfCategoria" value="${isEdit ? escapeHtml(bill.categoria || "") : ""}" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Tag</label><select id="tfTag" ${readOnly ? "disabled" : ""}>${tagOptionsHTML(isEdit ? bill.tagId : (state.tags[0] && state.tags[0].id))}</select></div>
      <div class="modal-field"><label>Valor mensal</label><input type="text" id="tfValor" value="${isEdit ? brl(bill.value) : ""}" placeholder="R$ 0,00" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Dia de cobrança</label><input type="number" id="tfDia" min="1" max="28" value="${isEdit ? bill.due.split("-")[2] : TODAY.getDate()}" ${readOnly ? "disabled" : ""}></div>
    </div>`;
  document.getElementById("formModalFoot").innerHTML = `
    ${(isEdit && !readOnly) ? '<button class="btn btn-ghost" id="tfDelete" type="button" style="color:var(--negative);">Excluir ferramenta</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;">
      <button class="btn" id="tfCancel" type="button">${readOnly ? "Fechar" : "Cancelar"}</button>
      ${readOnly ? "" : '<button class="btn btn-accent" id="tfSave" type="button">Salvar</button>'}
    </div>`;
  document.getElementById("tfCancel").addEventListener("click", closeFormModal);
  if (!readOnly) {
    wireNewTagOption(document.getElementById("tfTag"), isEdit ? bill.tagId : null);
    document.getElementById("tfSave").addEventListener("click", () => {
      const nome = document.getElementById("tfNome").value.trim();
      if (!nome) return;
      const categoria = document.getElementById("tfCategoria").value.trim();
      const valor = parseBRL(document.getElementById("tfValor").value);
      const dia = document.getElementById("tfDia").value || String(TODAY.getDate());
      const tagId = document.getElementById("tfTag").value;
      if (isEdit) {
        bill.title = nome; bill.categoria = categoria; bill.value = valor; bill.tagId = tagId; bill.due = nextDueISO(dia);
      } else {
        state.bills.push({ id: "tool-" + uid(), title: nome, kind: "Ferramenta", categoria, tagId, value: valor, due: nextDueISO(dia), status: "pendente" });
      }
      closeFormModal();
      renderFilterChips();
      renderAll();
      scheduleSave();
    });
    if (isEdit) document.getElementById("tfDelete").addEventListener("click", () => {
      if (!confirm("Excluir esta ferramenta? Essa ação não pode ser desfeita.")) return;
      state.bills = state.bills.filter(x => x.id !== bill.id);
      closeFormModal();
      renderFilterChips();
      renderAll();
      scheduleSave();
    });
  }
  document.getElementById("formModalOverlay").classList.add("open");
}
function openInstallmentForm(bill) {
  const isEdit = !!bill;
  const readOnly = !currentMember || currentMember.role !== "admin";
  document.getElementById("formModalTitle").textContent = isEdit ? "Editar parcelamento" : "Novo parcelamento";
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field full"><label>Descrição</label><input type="text" id="ifDesc" value="${isEdit ? escapeHtml(bill.title) : ""}" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Valor total</label><input type="text" id="ifTotal" value="${isEdit ? brl(bill.valorTotal || bill.value) : ""}" placeholder="R$ 0,00" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Nº de parcelas</label><input type="number" id="ifParcelas" min="1" value="${isEdit ? (bill.parcelas || 1) : 12}" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Parcela atual</label><input type="number" id="ifAtual" min="1" value="${isEdit ? (bill.parcelaAtual || 1) : 1}" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Valor da parcela</label><input type="text" id="ifValor" value="${isEdit ? brl(bill.value) : ""}" placeholder="R$ 0,00" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Próxima parcela</label><input type="date" id="ifDue" value="${isEdit ? bill.due : nextDueISO(15)}" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field full"><label>Tag</label><select id="ifTag" ${readOnly ? "disabled" : ""}>${tagOptionsHTML(isEdit ? bill.tagId : (tagById("investimento") ? "investimento" : (state.tags[0] && state.tags[0].id)))}</select></div>
    </div>`;
  document.getElementById("formModalFoot").innerHTML = `
    ${(isEdit && !readOnly) ? '<button class="btn btn-ghost" id="ifDelete" type="button" style="color:var(--negative);">Excluir parcelamento</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;">
      <button class="btn" id="ifCancel" type="button">${readOnly ? "Fechar" : "Cancelar"}</button>
      ${readOnly ? "" : '<button class="btn btn-accent" id="ifSave" type="button">Salvar</button>'}
    </div>`;
  document.getElementById("ifCancel").addEventListener("click", closeFormModal);
  if (!readOnly) {
    wireNewTagOption(document.getElementById("ifTag"), isEdit ? bill.tagId : null);
    if (!isEdit) {
      const autoFillValor = () => {
        const total = parseBRL(document.getElementById("ifTotal").value);
        const parcelas = Number(document.getElementById("ifParcelas").value) || 1;
        document.getElementById("ifValor").value = brl(total / parcelas);
      };
      document.getElementById("ifTotal").addEventListener("input", autoFillValor);
      document.getElementById("ifParcelas").addEventListener("input", autoFillValor);
    }
    document.getElementById("ifSave").addEventListener("click", () => {
      const desc = document.getElementById("ifDesc").value.trim();
      if (!desc) return;
      const total = parseBRL(document.getElementById("ifTotal").value);
      const parcelas = Number(document.getElementById("ifParcelas").value) || 1;
      const atual = Number(document.getElementById("ifAtual").value) || 1;
      const valor = parseBRL(document.getElementById("ifValor").value);
      const due = document.getElementById("ifDue").value;
      const tagId = document.getElementById("ifTag").value;
      if (isEdit) {
        bill.title = desc; bill.valorTotal = total; bill.parcelas = parcelas; bill.parcelaAtual = atual; bill.value = valor; bill.due = due; bill.tagId = tagId;
      } else {
        state.bills.push({ id: "inst-" + uid(), title: desc, kind: "Parcelado", tagId, value: valor, valorTotal: total, parcelas, parcelaAtual: atual, due, status: "pendente" });
      }
      closeFormModal();
      renderFilterChips();
      renderAll();
      scheduleSave();
    });
    if (isEdit) document.getElementById("ifDelete").addEventListener("click", () => {
      if (!confirm("Excluir este parcelamento? Essa ação não pode ser desfeita.")) return;
      state.bills = state.bills.filter(x => x.id !== bill.id);
      closeFormModal();
      renderFilterChips();
      renderAll();
      scheduleSave();
    });
  }
  document.getElementById("formModalOverlay").classList.add("open");
}
function openEmployeeForm(emp) {
  const isEdit = !!emp;
  const readOnly = !currentMember || currentMember.role !== "admin";
  document.getElementById("formModalTitle").textContent = isEdit ? "Editar funcionário/prestador" : "Novo funcionário/prestador";
  const bill = isEdit ? state.bills.find(b => b.id === emp.billId) : null;
  const tipoAtual = bill ? bill.kind : "Funcionário";
  const dueAtual = bill ? bill.due : endOfMonthISO();
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field full"><label>Nome</label><input type="text" id="efNome" value="${isEdit ? escapeHtml(emp.nome) : ""}" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Função</label><input type="text" id="efFuncao" value="${isEdit ? escapeHtml(emp.funcao || "") : ""}" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Tipo</label><select id="efTipo" ${readOnly ? "disabled" : ""}>
        <option value="Funcionário" ${tipoAtual === "Funcionário" ? "selected" : ""}>Funcionário</option>
        <option value="Prestador" ${tipoAtual === "Prestador" ? "selected" : ""}>Prestador</option>
      </select></div>
      <div class="modal-field"><label>Valor base mensal</label><input type="text" id="efBase" value="${isEdit ? brl(emp.base) : ""}" placeholder="R$ 0,00" ${readOnly ? "disabled" : ""}></div>
      <div class="modal-field"><label>Dia de pagamento</label><input type="date" id="efDue" value="${dueAtual}" ${readOnly ? "disabled" : ""}></div>
    </div>
    ${isEdit ? '<div class="modal-note">Vales, reembolsos e outros gastos do mês são adicionados direto no card, em Funcionários &amp; Prestadores.</div>' : ""}`;
  document.getElementById("formModalFoot").innerHTML = `
    ${(isEdit && !readOnly) ? '<button class="btn btn-ghost" id="efDelete" type="button" style="color:var(--negative);">Excluir</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;">
      <button class="btn" id="efCancel" type="button">${readOnly ? "Fechar" : "Cancelar"}</button>
      ${readOnly ? "" : '<button class="btn btn-accent" id="efSave" type="button">Salvar</button>'}
    </div>`;
  document.getElementById("efCancel").addEventListener("click", closeFormModal);
  if (!readOnly) {
    document.getElementById("efSave").addEventListener("click", () => {
      const nome = document.getElementById("efNome").value.trim();
      if (!nome) return;
      const funcao = document.getElementById("efFuncao").value.trim();
      const tipo = document.getElementById("efTipo").value;
      const base = parseBRL(document.getElementById("efBase").value);
      const due = document.getElementById("efDue").value || endOfMonthISO();
      if (isEdit) {
        emp.nome = nome; emp.funcao = funcao; emp.base = base;
        syncEmployeeBill(emp);
        const b = state.bills.find(x => x.id === emp.billId);
        if (b) { b.title = "Pagamento · " + nome; b.kind = tipo; b.due = due; }
      } else {
        const billId = "emp-" + uid();
        const empId = "person-" + uid();
        state.bills.push({ id: billId, title: "Pagamento · " + nome, kind: tipo, tagId: "custo-funcionario", value: base, due, status: "pendente" });
        state.employees.push({ id: empId, nome, funcao, base, despesas: [], billId });
      }
      closeFormModal();
      renderAll();
      scheduleSave();
    });
    if (isEdit) document.getElementById("efDelete").addEventListener("click", () => {
      if (!confirm(`Excluir ${emp.nome}? Isso também remove a conta de pagamento dele. Essa ação não pode ser desfeita.`)) return;
      state.employees = state.employees.filter(x => x.id !== emp.id);
      state.bills = state.bills.filter(b => b.id !== emp.billId);
      closeFormModal();
      renderAll();
      scheduleSave();
    });
  }
  document.getElementById("formModalOverlay").classList.add("open");
}

// ---------------- Bill detail / payment / delete modal ----------------
function openBillModal(id) {
  const b = state.bills.find(x => x.id === id);
  if (!b) return;
  currentModalId = id;
  const isPayroll = b.kind === "Funcionário" || b.kind === "Prestador";
  document.getElementById("modalTitle").textContent = displayTitle(b);
  const tagOptions = tagOptionsHTML(b.tagId);
  const methodOptions = PAYMENT_METHODS.map(m => `<option value="${m}" ${b.method === m ? "selected" : ""}>${m}</option>`).join("");
  let body = "";
  const readOnly = !currentMember || currentMember.role !== "admin";
  if (isPayroll) body += `<div class="modal-note">O valor soma automaticamente base + vales/reembolsos do mês em Custos Mensais → Funcionários &amp; Prestadores. Pra mudar o valor, edite por lá.</div>`;
  if (readOnly) body += `<div class="modal-note">Você está no modo Visualização — só pode consultar.</div>`;
  body += `
    <div class="modal-field"><label>Título</label><input type="text" id="mfTitle" value="${escapeHtml(b.title)}" ${isPayroll || readOnly ? "disabled" : ""}></div>
    <div class="modal-field"><label>Valor</label><input type="text" id="mfValue" value="${brl(b.value)}" ${isPayroll || readOnly ? "disabled" : ""}></div>
    <div class="modal-field"><label>Vencimento</label><input type="date" id="mfDue" value="${b.due}" ${readOnly ? "disabled" : ""}></div>
    <div class="modal-field"><label>Tag</label><select id="mfTag" ${readOnly ? "disabled" : ""}>${tagOptions}</select></div>
    <div class="modal-field"><label>Status</label>
      <div class="modal-status-toggle" id="mfStatusToggle">
        <button type="button" data-st="pendente" class="${b.status !== "pago" ? "on" : ""}" ${readOnly ? "disabled" : ""}>Pendente</button>
        <button type="button" data-st="pago" class="${b.status === "pago" ? "on" : ""}" ${readOnly ? "disabled" : ""}>Pago</button>
      </div>
    </div>
    <div class="modal-field" id="mfPaidWrap" style="${b.status === "pago" ? "" : "display:none;"}">
      <label>Forma de pagamento</label><select id="mfMethod" ${readOnly ? "disabled" : ""}>${methodOptions}</select>
    </div>
    <div class="modal-field" id="mfPaidOnWrap" style="${b.status === "pago" ? "" : "display:none;"}">
      <label>Data do pagamento</label><input type="date" id="mfPaidOn" value="${b.paidOn || TODAY_ISO}" ${readOnly ? "disabled" : ""}>
    </div>`;
  document.getElementById("modalBody").innerHTML = body;
  document.getElementById("modalFoot").innerHTML = `
    ${(!isPayroll && !readOnly) ? '<button class="btn btn-ghost" id="mfDelete" type="button" style="color:var(--negative);">Excluir conta</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;">
      <button class="btn" id="mfCancel" type="button">${readOnly ? "Fechar" : "Cancelar"}</button>
      ${readOnly ? "" : '<button class="btn btn-accent" id="mfSave" type="button">Salvar</button>'}
    </div>`;
  if (!readOnly) {
    document.querySelectorAll("#mfStatusToggle button").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#mfStatusToggle button").forEach(x => x.classList.remove("on"));
        btn.classList.add("on");
        const show = btn.dataset.st === "pago";
        document.getElementById("mfPaidWrap").style.display = show ? "" : "none";
        document.getElementById("mfPaidOnWrap").style.display = show ? "" : "none";
      });
    });
    wireNewTagOption(document.getElementById("mfTag"), b.tagId);
    document.getElementById("mfSave").addEventListener("click", saveBillModal);
    if (!isPayroll) document.getElementById("mfDelete").addEventListener("click", deleteBillModal);
  }
  document.getElementById("mfCancel").addEventListener("click", closeBillModal);
  document.getElementById("billModalOverlay").classList.add("open");
}
function closeBillModal() { document.getElementById("billModalOverlay").classList.remove("open"); currentModalId = null; }
function saveBillModal() {
  const b = state.bills.find(x => x.id === currentModalId);
  if (!b) return;
  const isPayroll = b.kind === "Funcionário" || b.kind === "Prestador";
  if (!isPayroll) {
    const titleVal = document.getElementById("mfTitle").value.trim();
    if (titleVal) b.title = titleVal;
    b.value = parseBRL(document.getElementById("mfValue").value);
  }
  const dueVal = document.getElementById("mfDue").value;
  if (dueVal) b.due = dueVal;
  b.tagId = document.getElementById("mfTag").value;
  const wantPago = document.querySelector("#mfStatusToggle button.on").dataset.st === "pago";
  if (wantPago) { b.status = "pago"; b.method = document.getElementById("mfMethod").value; b.paidOn = document.getElementById("mfPaidOn").value || TODAY_ISO; }
  else { b.status = "pendente"; delete b.method; delete b.paidOn; }
  closeBillModal();
  renderFilterChips();
  renderAll();
  scheduleSave();
}
function deleteBillModal() {
  if (!confirm("Excluir esta conta? Essa ação não pode ser desfeita.")) return;
  const idx = state.bills.findIndex(x => x.id === currentModalId);
  if (idx > -1) state.bills.splice(idx, 1);
  closeBillModal();
  renderFilterChips();
  renderAll();
  scheduleSave();
}
document.addEventListener("click", e => {
  const payTrigger = e.target.closest(".bill-card, .cal-pill, .pay-pill");
  if (payTrigger) {
    const host = payTrigger.closest("[data-bill-id]");
    if (host && host.dataset.billId) openBillModal(host.dataset.billId);
    return;
  }
  const rowTrigger = e.target.closest("tr.row-click[data-bill-id]");
  if (rowTrigger) {
    const b = state.bills.find(x => x.id === rowTrigger.dataset.billId);
    if (!b) return;
    if (b.kind === "Ferramenta") openToolForm(b);
    else if (b.kind === "Parcelado") openInstallmentForm(b);
  }
});
document.getElementById("modalClose").addEventListener("click", closeBillModal);
document.getElementById("billModalOverlay").addEventListener("click", e => { if (e.target.id === "billModalOverlay") closeBillModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeBillModal(); closeFormModal(); } });

// ---------------- Clientes ----------------
function clientRowHTML(c) {
  const payLabel = c.status !== "ativo" ? "—" : (c.pago ? "Pago" : "Pendente");
  return `<tr data-id="${c.id}">
    <td>${escapeHtml(c.nome)}</td><td class="num">${brl(c.valor)}</td><td>${escapeHtml(c.dia)}</td>
    <td><select class="status-select ${c.status}" data-action="client-status">
      <option value="ativo" ${c.status === "ativo" ? "selected" : ""}>Ativo</option>
      <option value="pausado" ${c.status === "pausado" ? "selected" : ""}>Pausado</option>
      <option value="novo" ${c.status === "novo" ? "selected" : ""}>Não gravou ainda</option>
    </select></td>
    <td><label class="pay-toggle"><input type="checkbox" data-action="client-pago" ${c.status !== "ativo" ? "disabled" : ""} ${c.pago ? "checked" : ""}><span class="pay-dot"></span>${payLabel}</label></td>
    <td><button class="btn-ghost" data-action="client-del" title="Excluir cliente">✕</button></td>
  </tr>`;
}
function renderClients() {
  document.getElementById("clientsBody").innerHTML = state.clients.length
    ? state.clients.map(clientRowHTML).join("")
    : '<tr><td colspan="6" class="empty-hint">Nenhum cliente cadastrado ainda.</td></tr>';
  const ativos = state.clients.filter(c => c.status === "ativo");
  document.getElementById("chipAtivos").textContent = ativos.length;
  document.getElementById("chipReceita").textContent = brl(getActiveRevenue());
}
document.getElementById("btnNewClient").addEventListener("click", () => {
  if (!requireAdmin()) return;
  document.getElementById("newClientForm").classList.toggle("open");
});
document.getElementById("newClientForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!requireAdmin()) return;
  const f = e.target;
  const nome = f.nome.value.trim();
  const valor = parseBRL(f.valor.value);
  const dia = f.dia.value.trim();
  const status = f.status.value;
  if (!nome || !valor) return;
  state.clients.push({ id: "client-" + uid(), nome, valor, dia, status, pago: false });
  f.reset();
  document.getElementById("newClientForm").classList.remove("open");
  renderAll();
  scheduleSave();
});
document.getElementById("clientsBody").addEventListener("click", e => {
  const btn = e.target.closest('[data-action="client-del"]');
  if (!btn) return;
  if (!requireAdmin()) return;
  const id = btn.closest("tr").dataset.id;
  if (!confirm("Excluir este cliente?")) return;
  state.clients = state.clients.filter(c => c.id !== id);
  renderAll();
  scheduleSave();
});
document.getElementById("clientsBody").addEventListener("change", e => {
  const id = e.target.closest("tr") ? e.target.closest("tr").dataset.id : null;
  const c = state.clients.find(x => x.id === id);
  if (!c) return;
  if (e.target.dataset.action === "client-status") {
    if (!requireAdmin()) { renderClients(); return; }
    c.status = e.target.value;
    if (c.status !== "ativo") c.pago = false;
    renderAll();
    scheduleSave();
  }
  if (e.target.dataset.action === "client-pago") {
    if (!requireAdmin()) { renderClients(); return; }
    c.pago = e.target.checked;
    renderAll();
    scheduleSave();
  }
});

// ---------------- Freelances ----------------
// Trabalhos avulsos (captação, aftermovie, edição…). Cada freela guarda a lista
// de parcelas com vencimento — é por ela que a receita cai no mês certo.
const FREELA_TIPOS = ["Captação de evento", "Aftermovie", "Edição", "Fotografia", "Vídeo institucional", "Outro"];
const FREELA_FORMAS = { avista: "À vista", parcelado: "Parcelado", entrada: "Entrada + restante" };
function freelaPagamentoLabel(f) {
  const n = (f.parcelas || []).length;
  const forma = f.forma === "parcelado" ? `${n}x` : f.forma === "entrada" ? `Entrada + ${Math.max(0, n - 1)}x` : "À vista";
  return forma + (f.metodo ? " · " + f.metodo : "");
}
function freelaStatusBadge(f) {
  const ps = f.parcelas || [];
  const pagas = ps.filter(p => p.pago).length;
  if (ps.length && pagas === ps.length) return '<span class="badge ativo">Recebido</span>';
  if (ps.some(p => !p.pago && p.venc && p.venc < TODAY_ISO)) return `<span class="badge atrasado">Atrasado · ${pagas}/${ps.length}</span>`;
  if (pagas) return `<span class="badge parcial">${pagas}/${ps.length} recebidas</span>`;
  return '<span class="badge pausado">A receber</span>';
}
function renderFreelas() {
  const key = monthKeyOf(freelaYear, freelaMonth);
  document.getElementById("freelaMonthTitle").textContent = new Date(freelaYear, freelaMonth, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const doMes = (state.freelas || []).filter(f => (f.data || "").slice(0, 7) === key).sort((a, b) => (a.data || "").localeCompare(b.data || ""));
  document.getElementById("freelasBody").innerHTML = doMes.length ? doMes.map(f => `
    <tr class="row-click" data-freela-id="${f.id}">
      <td>${escapeHtml(f.titulo)}${f.cliente ? `<span class="freela-sub">${escapeHtml(f.cliente)}</span>` : ""}</td>
      <td>${escapeHtml(f.tipo || "")}</td><td>${fmtDate(f.data)}</td><td class="num">${brl(f.valor)}</td>
      <td>${escapeHtml(freelaPagamentoLabel(f))}</td><td>${freelaStatusBadge(f)}</td>
    </tr>`).join("") : '<tr><td colspan="6" class="empty-hint">Nenhum freela lançado neste mês.</td></tr>';
  const receb = freelaParcelasDoMes(key);
  document.getElementById("freelaRecebBody").innerHTML = receb.length ? receb.map(({ f, p, idx }) => `
    <tr data-freela-id="${f.id}" data-idx="${idx}">
      <td>${escapeHtml(f.titulo)}${f.cliente ? `<span class="freela-sub">${escapeHtml(f.cliente)}</span>` : ""}</td>
      <td>${f.parcelas.length > 1 ? (f.forma === "entrada" && idx === 0 ? "Entrada" : `${idx + 1}/${f.parcelas.length}`) : "Única"}</td>
      <td class="${!p.pago && p.venc < TODAY_ISO ? "neg" : ""}">${fmtDateFull(p.venc)}</td><td class="num">${brl(p.valor)}</td>
      <td><label class="pay-toggle"><input type="checkbox" data-action="freela-pago" ${p.pago ? "checked" : ""}><span class="pay-dot"></span>${p.pago ? "Recebido " + fmtDate(p.pagoEm) : "Pendente"}</label></td>
    </tr>`).join("") : '<tr><td colspan="5" class="empty-hint">Nenhum recebimento de freela previsto neste mês.</td></tr>';
  document.getElementById("chipFreelaQtd").textContent = doMes.length;
  document.getElementById("chipFreelaFechado").textContent = brl(doMes.reduce((s, f) => s + Number(f.valor || 0), 0));
  document.getElementById("chipFreelaEntra").textContent = brl(receb.reduce((s, x) => s + Number(x.p.valor || 0), 0));
  document.getElementById("chipFreelaRecebido").textContent = brl(receb.filter(x => x.p.pago).reduce((s, x) => s + Number(x.p.valor || 0), 0));
}
document.getElementById("freelaPrev").addEventListener("click", () => { freelaMonth--; if (freelaMonth < 0) { freelaMonth = 11; freelaYear--; } renderFreelas(); });
document.getElementById("freelaNext").addEventListener("click", () => { freelaMonth++; if (freelaMonth > 11) { freelaMonth = 0; freelaYear++; } renderFreelas(); });
document.getElementById("btnNewFreela").addEventListener("click", () => { if (!requireAdmin()) return; openFreelaForm(null); });
document.getElementById("freelasBody").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-freela-id]");
  const f = tr && state.freelas.find(x => x.id === tr.dataset.freelaId);
  if (f) openFreelaForm(f);
});
document.getElementById("freelaRecebBody").addEventListener("change", e => {
  if (e.target.dataset.action !== "freela-pago") return;
  if (!requireAdmin()) { renderFreelas(); return; }
  const tr = e.target.closest("tr");
  const f = state.freelas.find(x => x.id === tr.dataset.freelaId);
  const p = f && f.parcelas[Number(tr.dataset.idx)];
  if (!p) return;
  p.pago = e.target.checked;
  if (p.pago) p.pagoEm = TODAY_ISO; else delete p.pagoEm;
  renderAll();
  scheduleSave();
});
// Gera as parcelas a partir da forma de pagamento. Mantém o "recebido" das
// parcelas que já existiam na mesma posição, pra não perder o que já foi marcado.
function buildFreelaParcelas(forma, total, n, primeiro, entrada, anteriores) {
  const cents = Math.round(total * 100);
  let valores = [];
  if (forma === "avista") valores = [cents];
  else if (forma === "parcelado") {
    const base = Math.floor(cents / n);
    valores = Array.from({ length: n }, (_, i) => base + (i < cents - base * n ? 1 : 0));
  } else {
    const ent = Math.min(cents, Math.round(entrada * 100));
    const resto = cents - ent;
    const base = Math.floor(resto / n);
    valores = [ent].concat(Array.from({ length: n }, (_, i) => base + (i < resto - base * n ? 1 : 0)));
  }
  return valores.map((v, i) => {
    const old = (anteriores || [])[i] || {};
    const p = { valor: v / 100, venc: addMonthsISO(primeiro, i), pago: !!old.pago };
    if (old.pago) p.pagoEm = old.pagoEm || TODAY_ISO;
    return p;
  });
}
function openFreelaForm(f) {
  const isEdit = !!f;
  const readOnly = !currentMember || currentMember.role !== "admin";
  const dis = readOnly ? "disabled" : "";
  const defaultData = (freelaYear === TODAY.getFullYear() && freelaMonth === TODAY.getMonth()) ? TODAY_ISO : `${monthKeyOf(freelaYear, freelaMonth)}-01`;
  const forma = isEdit ? f.forma : "avista";
  const ps = isEdit ? f.parcelas : [];
  let parcelas = ps.map(p => Object.assign({}, p));
  const nInicial = isEdit ? Math.max(1, forma === "entrada" ? ps.length - 1 : ps.length) : 2;
  document.getElementById("formModalTitle").textContent = isEdit ? "Editar freela" : "Novo freela";
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field full"><label>Trabalho</label><input type="text" id="ffTitulo" placeholder="Ex: Aftermovie casamento Ana &amp; Leo" value="${isEdit ? escapeHtml(f.titulo) : ""}" ${dis}></div>
      <div class="modal-field"><label>Cliente</label><input type="text" id="ffCliente" value="${isEdit ? escapeHtml(f.cliente || "") : ""}" ${dis}></div>
      <div class="modal-field"><label>Tipo</label><input type="text" id="ffTipo" list="ffTipos" value="${isEdit ? escapeHtml(f.tipo || "") : ""}" placeholder="Escolha ou escreva" ${dis}>
        <datalist id="ffTipos">${FREELA_TIPOS.map(t => `<option value="${t}">`).join("")}</datalist></div>
      <div class="modal-field"><label>Data do trabalho</label><input type="date" id="ffData" value="${isEdit ? f.data : defaultData}" ${dis}></div>
      <div class="modal-field"><label>Valor total</label><input type="text" id="ffValor" value="${isEdit ? brl(f.valor) : ""}" placeholder="R$ 0,00" ${dis}></div>
      <div class="modal-field"><label>Forma de pagamento</label><select id="ffForma" ${dis}>${Object.entries(FREELA_FORMAS).map(([k, v]) => `<option value="${k}" ${forma === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      <div class="modal-field"><label>Meio</label><select id="ffMetodo" ${dis}>${PAYMENT_METHODS.map(m => `<option value="${m}" ${isEdit && f.metodo === m ? "selected" : ""}>${m}</option>`).join("")}</select></div>
      <div class="modal-field" id="ffEntradaWrap"><label>Valor da entrada</label><input type="text" id="ffEntrada" value="${isEdit && forma === "entrada" && ps[0] ? brl(ps[0].valor) : ""}" placeholder="R$ 0,00 (padrão 50%)" ${dis}></div>
      <div class="modal-field" id="ffNWrap"><label id="ffNLabel">Nº de parcelas</label><input type="number" id="ffN" min="1" max="24" value="${nInicial}" ${dis}></div>
      <div class="modal-field"><label id="ffPrimeiroLabel">Primeiro recebimento</label><input type="date" id="ffPrimeiro" value="${isEdit && ps[0] ? ps[0].venc : (isEdit ? f.data : defaultData)}" ${dis}></div>
      <div class="modal-field full"><label>Parcelas</label><div class="parc-list" id="ffParcelas"></div><div class="parc-sum" id="ffParcSum"></div></div>
      <div class="modal-field full"><label>Observação</label><input type="text" id="ffObs" value="${isEdit ? escapeHtml(f.obs || "") : ""}" ${dis}></div>
    </div>`;
  document.getElementById("formModalFoot").innerHTML = `
    ${(isEdit && !readOnly) ? '<button class="btn btn-ghost" id="ffDelete" type="button" style="color:var(--negative);">Excluir freela</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;">
      <button class="btn" id="ffCancel" type="button">${readOnly ? "Fechar" : "Cancelar"}</button>
      ${readOnly ? "" : '<button class="btn btn-accent" id="ffSave" type="button">Salvar</button>'}
    </div>`;
  const $ = id => document.getElementById(id);
  const syncVisibility = () => {
    const fm = $("ffForma").value;
    $("ffEntradaWrap").style.display = fm === "entrada" ? "" : "none";
    $("ffNWrap").style.display = fm === "avista" ? "none" : "";
    $("ffNLabel").textContent = fm === "entrada" ? "Restante em quantas vezes" : "Nº de parcelas";
    $("ffPrimeiroLabel").textContent = fm === "avista" ? "Data do recebimento" : fm === "entrada" ? "Data da entrada" : "Primeira parcela";
  };
  const renderParcelas = () => {
    $("ffParcelas").innerHTML = parcelas.map((p, i) => `
      <div class="parc-row" data-idx="${i}">
        <span class="parc-n">${$("ffForma").value === "entrada" && i === 0 ? "Ent." : (i + 1) + "ª"}</span>
        <input type="text" data-k="valor" value="${brl(p.valor)}" ${dis}>
        <input type="date" data-k="venc" value="${p.venc}" ${dis}>
        <label class="pay-toggle"><input type="checkbox" data-k="pago" ${p.pago ? "checked" : ""} ${dis}><span class="pay-dot"></span>${p.pago ? "Recebido" : "Pendente"}</label>
      </div>`).join("");
    const soma = parcelas.reduce((s, p) => s + Number(p.valor || 0), 0);
    const total = parseBRL($("ffValor").value);
    const diff = Math.abs(soma - total) > 0.009;
    $("ffParcSum").className = "parc-sum" + (diff ? " warn" : "");
    $("ffParcSum").textContent = parcelas.length ? `Soma das parcelas: ${brl(soma)}${diff ? ` — diferente do valor total (${brl(total)})` : ""}` : "Preencha o valor total pra gerar as parcelas.";
  };
  const regenerate = () => {
    const total = parseBRL($("ffValor").value);
    const fm = $("ffForma").value;
    const n = Math.min(24, Math.max(1, parseInt($("ffN").value, 10) || 1));
    const entradaTxt = $("ffEntrada").value.trim();
    const entrada = entradaTxt ? parseBRL(entradaTxt) : total / 2;
    const primeiro = $("ffPrimeiro").value || $("ffData").value || TODAY_ISO;
    parcelas = total ? buildFreelaParcelas(fm, total, n, primeiro, entrada, parcelas) : [];
    renderParcelas();
  };
  syncVisibility();
  if (isEdit) renderParcelas(); else regenerate();
  $("ffCancel").addEventListener("click", closeFormModal);
  if (!readOnly) {
    $("ffForma").addEventListener("change", () => { syncVisibility(); regenerate(); });
    ["ffValor", "ffN", "ffEntrada", "ffPrimeiro"].forEach(id => $(id).addEventListener("change", regenerate));
    let primeiroTocado = isEdit;
    $("ffPrimeiro").addEventListener("input", () => { primeiroTocado = true; });
    $("ffData").addEventListener("change", () => { if (!primeiroTocado) { $("ffPrimeiro").value = $("ffData").value; regenerate(); } });
    $("ffParcelas").addEventListener("change", e => {
      const row = e.target.closest(".parc-row"); if (!row) return;
      const p = parcelas[Number(row.dataset.idx)];
      const k = e.target.dataset.k;
      if (k === "valor") p.valor = parseBRL(e.target.value);
      else if (k === "venc") p.venc = e.target.value || p.venc;
      else if (k === "pago") { p.pago = e.target.checked; if (p.pago) p.pagoEm = TODAY_ISO; else delete p.pagoEm; }
      renderParcelas();
    });
    $("ffSave").addEventListener("click", () => {
      const titulo = $("ffTitulo").value.trim();
      if (!titulo) { $("ffTitulo").focus(); return; }
      const valor = parseBRL($("ffValor").value);
      if (!valor) { $("ffValor").focus(); return; }
      if (!parcelas.length) regenerate();
      const dados = {
        titulo, cliente: $("ffCliente").value.trim(), tipo: $("ffTipo").value.trim(),
        data: $("ffData").value || TODAY_ISO, valor, forma: $("ffForma").value, metodo: $("ffMetodo").value,
        parcelas, obs: $("ffObs").value.trim(),
      };
      if (isEdit) Object.assign(f, dados);
      else state.freelas.push(Object.assign({ id: "freela-" + uid(), criadoPor: currentUser ? currentUser.email : null }, dados));
      const [y, m] = dados.data.split("-").map(Number);
      freelaYear = y; freelaMonth = m - 1;
      closeFormModal();
      renderAll();
      scheduleSave();
    });
    if (isEdit) $("ffDelete").addEventListener("click", () => {
      if (!confirm("Excluir este freela? Essa ação não pode ser desfeita.")) return;
      state.freelas = state.freelas.filter(x => x.id !== f.id);
      closeFormModal();
      renderAll();
      scheduleSave();
    });
  }
  document.getElementById("formModalOverlay").classList.add("open");
}

// ---------------- Notas Fiscais ----------------
// Sem Storage pago: o arquivo em si fica guardado onde você já usa (Drive, etc.)
// e aqui a gente só arquiva o link junto com prestador/descrição/valor/data.
function renderInvoices() {
  const wrap = document.getElementById("invoiceGroups");
  const notas = state.notas || [];
  if (!notas.length) { wrap.innerHTML = '<p class="empty-hint">Nenhuma nota fiscal registrada ainda.</p>'; return; }
  const groups = {};
  notas.forEach(n => { (groups[n.prestador] = groups[n.prestador] || []).push(n); });
  wrap.innerHTML = Object.keys(groups).sort().map(prestador => {
    const rows = groups[prestador].map(n => `
      <a class="invoice-row" href="${escapeHtml(n.url)}" target="_blank" rel="noopener" style="text-decoration:none; color:inherit;">
        <div class="invoice-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2.5h7l3.5 3.5V17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z"/></svg></div>
        <div><div class="invoice-name">${escapeHtml(n.desc)}</div><div class="invoice-desc">Abrir arquivo ↗</div></div>
        <div class="invoice-meta">${n.valor ? `<span class="num">${brl(n.valor)}</span>` : ""}<span class="invoice-date">${fmtDateFull(n.data)}</span></div>
      </a>`).join("");
    return `<div class="invoice-group"><h3>${escapeHtml(prestador)}</h3>${rows}</div>`;
  }).join("");
}
document.getElementById("uploadForm").addEventListener("submit", e => {
  e.preventDefault();
  if (!requireAdmin()) return;
  const f = e.target;
  const prestador = f.prestador.value.trim();
  const desc = f.desc.value.trim();
  const valor = parseBRL(f.valor.value || "0");
  const link = f.link.value.trim();
  if (!prestador || !desc || !link) return;
  state.notas = state.notas || [];
  state.notas.unshift({ id: "nf-" + uid(), prestador, desc, valor, url: link, data: TODAY_ISO, enviadoPor: currentUser.email });
  renderInvoices();
  scheduleSave();
  f.reset();
});

// ---------------- Dashboard ----------------
function renderChart() {
  const receita = getActiveRevenue() + freelaRevenue(TODAY_ISO.slice(0, 7));
  const custos = state.bills.filter(b => b.status !== "pago").reduce((s, b) => s + b.value, 0);
  const max = Math.max(receita, custos, 1);
  document.getElementById("chart").innerHTML = `
    <div class="chart-col"><div class="chart-bars"><div class="bar in" style="height:${(receita / max * 118).toFixed(0)}px"></div></div><span>${brl(receita)}</span></div>
    <div class="chart-col"><div class="chart-bars"><div class="bar out" style="height:${(custos / max * 118).toFixed(0)}px"></div></div><span>${brl(custos)}</span></div>`;
}
function updateDashboardStats() {
  const freelaMes = freelaParcelasDoMes(TODAY_ISO.slice(0, 7));
  const receber = getActiveRevenue() + freelaMes.reduce((s, x) => s + Number(x.p.valor || 0), 0);
  const pagar = state.bills.filter(b => b.status !== "pago").reduce((s, b) => s + b.value, 0);
  const saldo = receber - pagar;
  document.getElementById("statCaixa").textContent = brl(state.caixaAtual);
  document.getElementById("statReceber").textContent = brl(receber);
  document.getElementById("statPagar").textContent = brl(pagar);
  const saldoEl = document.getElementById("statSaldo");
  saldoEl.textContent = (saldo < 0 ? "−" : "") + brl(Math.abs(saldo));
  saldoEl.className = "stat-value num " + (saldo > 0 ? "pos" : saldo < 0 ? "neg" : "zero-c");
  const nFreelas = new Set(freelaMes.map(x => x.f.id)).size;
  document.getElementById("statReceberSub").textContent = state.clients.filter(c => c.status === "ativo").length + " clientes ativos" + (nFreelas ? ` · ${nFreelas} freela${nFreelas > 1 ? "s" : ""}` : "");
  document.getElementById("statPagarSub").textContent = state.bills.filter(b => b.status !== "pago").length + " contas em aberto";
}
function renderCostPie() {
  const sums = {}; let total = 0;
  state.bills.forEach(b => { sums[b.tagId] = (sums[b.tagId] || 0) + b.value; total += b.value; });
  const active = state.tags.filter(t => sums[t.id]);
  if (!active.length) {
    document.getElementById("pieChart").style.background = "var(--surface-2)";
    document.getElementById("pieLegend").innerHTML = '<p class="pie-empty">Sem custos cadastrados ainda.</p>';
    document.getElementById("costBreakdownSub").textContent = "Composição dos custos mensais fixos";
    return;
  }
  let acc = 0;
  const stops = active.map(t => {
    const pct = total ? (sums[t.id] / total * 100) : 0;
    const start = acc; acc += pct;
    return `${t.color} ${start.toFixed(2)}% ${acc.toFixed(2)}%`;
  }).join(", ");
  document.getElementById("pieChart").style.background = `conic-gradient(${stops})`;
  document.getElementById("pieLegend").innerHTML = active.map(t => {
    const v = sums[t.id]; const pct = total ? (v / total * 100) : 0;
    return `<div class="pie-legend-row"><span class="pie-dot" style="background:${t.color}"></span><span class="pie-label">${escapeHtml(t.label)}</span><span class="pie-pct">${pct.toFixed(0)}%</span><span class="pie-value num">${brl(v)}</span></div>`;
  }).join("");
  document.getElementById("costBreakdownSub").textContent = "Composição dos " + brl(total) + " em custos mensais fixos";
}
function renderProjection() {
  const receita = getActiveRevenue();
  const nonPayroll = state.bills.filter(b => b.tagId !== "custo-funcionario" && b.tagId !== "salario").reduce((s, b) => s + b.value, 0);
  const empBaseTotal = state.employees.reduce((s, e) => s + Number(e.base || 0), 0);
  const recurring = nonPayroll + empBaseTotal;
  const months = [0, 1, 2, 3].map(delta => {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() + delta, 1);
    return { label: d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }), key: monthKeyOf(d.getFullYear(), d.getMonth()) };
  });
  document.getElementById("projBody").innerHTML = months.map(m => {
    const freela = freelaRevenue(m.key);
    const lucro = receita + freela - recurring;
    return `<tr><td style="text-transform:capitalize;">${m.label}</td><td class="num">${brl(receita)}</td><td class="num">${brl(freela)}</td><td class="num">${brl(recurring)}</td><td class="num ${lucro > 0 ? "pos" : lucro < 0 ? "neg" : "zero-c"}">${lucro < 0 ? "−" : ""}${brl(Math.abs(lucro))}</td></tr>`;
  }).join("");
}
function renderAvisos() {
  const items = [];
  state.bills.forEach(b => {
    if (b.status === "pago") return;
    const bk = bucket(b);
    if (bk === "atrasado") items.push({ c: "var(--negative)", t: `${escapeHtml(b.title)} está atrasada — ${brl(b.value)}` });
    else if (bk === "soon") items.push({ c: "var(--accent)", t: `${escapeHtml(b.title)} vence em breve (${fmtDate(b.due)}) — ${brl(b.value)}` });
  });
  state.clients.forEach(c => {
    if (c.status === "ativo" && !c.pago) items.push({ c: "var(--accent)", t: `${escapeHtml(c.nome)} ainda não pagou este mês` });
    else if (c.status === "novo") items.push({ c: "var(--zero)", t: `${escapeHtml(c.nome)} está cadastrado mas ainda não gravou nada` });
  });
  (state.freelas || []).forEach(f => (f.parcelas || []).forEach((p, i) => {
    if (p.pago || !p.venc) return;
    const label = f.parcelas.length > 1 ? ` (parcela ${i + 1}/${f.parcelas.length})` : "";
    if (p.venc < TODAY_ISO) items.push({ c: "var(--negative)", t: `Freela ${escapeHtml(f.titulo)}${label}: recebimento atrasado desde ${fmtDate(p.venc)} — ${brl(p.valor)}` });
  }));
  document.getElementById("alertList").innerHTML = items.length
    ? items.map(i => `<li><span class="alert-dot" style="background:${i.c}"></span>${i.t}</li>`).join("")
    : '<li style="color:var(--ink-faint);">Tudo em dia por aqui.</li>';
}
document.getElementById("tileCaixa").addEventListener("click", () => {
  if (!requireAdmin()) return;
  const val = prompt("Saldo atual em conta (R$):", String(state.caixaAtual).replace(".", ","));
  if (val === null) return;
  state.caixaAtual = parseBRL(val);
  updateDashboardStats();
  scheduleSave();
});

// ---------------- master render ----------------
function renderAll() {
  renderBoard(); renderCalendar(); renderToolsTable(); renderInstallmentsTable(); renderEmployees();
  renderClients(); renderFreelas(); renderInvoices();
  updateChipEmAberto(); updateDashboardStats(); renderChart(); renderCostPie(); renderAvisos(); renderProjection();
}

// ---------------- Equipe & Acesso ----------------
// Sem membros/convites no Firestore: acesso é liberado por uma lista fixa
// de e-mails direto na regra de segurança (ALLOWED_EMAILS abaixo espelha
// essa lista só pra mensagens amigáveis na tela).
function renderProfile() {
  const fotoURL = (currentMember && currentMember.fotoURL) || currentUser.photoURL;
  const initials = (currentUser.displayName || currentUser.email || "?")[0].toUpperCase();
  document.getElementById("profileName").textContent = currentUser.displayName || currentUser.email;
  document.getElementById("profileEmail").textContent = currentUser.email;
  document.getElementById("profileAvatar").innerHTML = fotoURL ? `<img src="${fotoURL}" alt="">` : initials;
  document.getElementById("sidebarUserName").textContent = currentUser.displayName || currentUser.email;
  document.getElementById("sidebarAvatar").innerHTML = fotoURL ? `<img src="${fotoURL}" alt="">` : initials;
}
// Sem Storage pago: a foto é redimensionada no navegador e guardada como
// imagem pequena (data URL) direto no documento de perfil no Firestore.
function resizeImageToDataURL(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("Não consegui ler essa imagem."));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Não consegui ler o arquivo."));
    reader.readAsDataURL(file);
  });
}
document.getElementById("avatarInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("avatarStatus");
  statusEl.textContent = "Processando foto…";
  try {
    const dataUrl = await resizeImageToDataURL(file, 200);
    if (dataUrl.length > 900000) { statusEl.textContent = "Essa foto ficou grande demais mesmo reduzida — tenta outra."; return; }
    await db.collection("empresas/pique/perfis").doc(currentUser.email).set({ nome: currentUser.displayName || currentUser.email, fotoURL: dataUrl }, { merge: true });
    currentMember.fotoURL = dataUrl;
    renderProfile();
    statusEl.textContent = "Foto atualizada.";
  } catch (err) {
    statusEl.textContent = "Erro ao processar: " + err.message;
  }
});
function renderAccessList() {
  document.getElementById("accessList").innerHTML = ALLOWED_EMAILS.map(email => {
    const isYou = currentUser && email === currentUser.email;
    return `<div class="member-row"><div class="member-avatar">${email[0].toUpperCase()}</div><div class="member-info"><div class="member-name">${escapeHtml(email)}${isYou ? " (você)" : ""}</div></div></div>`;
  }).join("");
}
function applyRoleGating() {
  document.body.classList.toggle("read-only", false);
}

// ---------------- Auth ----------------
function setLoginStatus(msg, isErr) {
  const el = document.getElementById("loginStatus");
  el.textContent = msg || "";
  el.classList.toggle("err", !!isErr);
}
function showLogin() {
  document.getElementById("loginScreen").hidden = false;
  document.getElementById("appRoot").hidden = true;
  document.getElementById("btnGoogleLogin").disabled = false;
}
function showApp() {
  document.getElementById("loginScreen").hidden = true;
  document.getElementById("appRoot").hidden = false;
  document.getElementById("topbarDate").textContent = TODAY.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  renderProfile();
  applyRoleGating();
  renderFilterChips();
}
document.getElementById("btnGoogleLogin").addEventListener("click", () => {
  const provider = new firebase.auth.GoogleAuthProvider();
  document.getElementById("btnGoogleLogin").disabled = true;
  setLoginStatus("Abrindo login do Google…");
  auth.signInWithPopup(provider).catch(err => {
    setLoginStatus("Não foi possível entrar: " + err.message, true);
    document.getElementById("btnGoogleLogin").disabled = false;
  });
});
document.getElementById("btnSignOut").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async user => {
  if (!user) { currentUser = null; currentMember = null; showLogin(); return; }
  if (!ALLOWED_EMAILS.includes(user.email)) {
    setLoginStatus("Essa conta (" + user.email + ") ainda não tem acesso liberado. Peça pra alguém adicionar seu e-mail.", true);
    await auth.signOut();
    return;
  }
  setLoginStatus("Entrando…");
  try {
    currentUser = user;
    const profRef = db.collection("empresas/pique/perfis").doc(user.email);
    const profSnap = await profRef.get();
    if (!profSnap.exists) await profRef.set({ nome: user.displayName || user.email, fotoURL: user.photoURL || null });
    const profData = profSnap.exists ? profSnap.data() : { nome: user.displayName || user.email, fotoURL: user.photoURL || null };
    currentMember = { email: user.email, role: "admin", nome: profData.nome, fotoURL: profData.fotoURL };
    showApp();
    subscribeState();
    renderAccessList();
  } catch (err) {
    console.error(err);
    setLoginStatus("Erro ao entrar: " + err.message, true);
  }
});

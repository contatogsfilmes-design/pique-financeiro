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

let caixaYear = TODAY.getFullYear();
let caixaMonth = TODAY.getMonth();
let caixaFiltroConta = "todas";

const CUR_KEY = TODAY_ISO.slice(0, 7);
const state = { bills: [], tags: DEFAULT_TAGS.slice(), clients: [], employees: [], notas: [], freelas: [], contas: [], movs: [], caixaAtual: 0 };

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
  // Conta recorrente já paga neste mês: o vencimento já andou pro mês que vem.
  const up = b.ultimoPagamento;
  if (up && (up.data || "").slice(0, 7) === CUR_KEY && b.due.slice(0, 7) > CUR_KEY) return { cls: "pago", text: "Pago " + fmtDate(up.data) };
  const bk = bucket(b);
  return bk === "atrasado" ? { cls: "atrasado", text: "Atrasado" } : { cls: "pendente", text: "Pendente" };
}
function displayTitle(b) { return (b.kind === "Parcelado" && b.parcelas) ? `${b.title} · ${b.parcelaAtual}/${b.parcelas}` : b.title; }
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
function monthsBetween(fromKey, toKey) {
  const [y1, m1] = fromKey.split("-").map(Number), [y2, m2] = toKey.split("-").map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}
function monthLabel(key, opts) { const [y, m] = key.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", opts || { month: "long", year: "numeric" }); }
// Dia de pagamento (texto livre, ex "10") aplicado a um mês "YYYY-MM".
function diaNoMes(key, diaStr) {
  const [y, m] = key.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const dia = Math.min(last, Math.max(1, parseInt(diaStr, 10) || 1));
  return `${key}-${String(dia).padStart(2, "0")}`;
}

// ---------------- Funcionários: custo, vales e valor a pagar ----------------
// Vale = adiantamento: o dinheiro sai do caixa na hora e é descontado do
// pagamento do fim do mês. Uber/Reembolso/Bônus/Outro somam no pagamento.
// (Vales antigos, lançados antes dessa regra, não têm a flag adiantamento e
// continuam somando, como era antes.)
function isAdiantamento(d) { return !!d.adiantamento; }
function empAjuste(emp) { return emp.ajusteMes ? Number(emp.ajusteMes.valor || 0) : 0; }
function empCusto(emp) { return Number(emp.base || 0) + empAjuste(emp) + (emp.despesas || []).filter(d => !isAdiantamento(d)).reduce((s, d) => s + Number(d.valor || 0), 0); }
function empVales(emp) { return (emp.despesas || []).filter(isAdiantamento).reduce((s, d) => s + Number(d.valor || 0), 0); }
function empAPagar(emp) { return Math.max(0, empCusto(emp) - empVales(emp)); }
function empByBill(b) { return state.employees.find(e => e.billId === b.id); }

// ---------------- Caixa: contas, cartões e lançamentos ----------------
// Cada lançamento (mov) é uma entrada ou saída numa conta. Saldo da conta
// bancária = saldo inicial + entradas − saídas. No cartão de crédito as
// compras acumulam na fatura, e o pagamento da fatura é uma saída da conta
// bancária marcada com pagaFatura (não conta como gasto de novo).
function contaById(id) { return state.contas.find(c => c.id === id); }
function contaPadrao() { return state.contas.find(c => c.tipo === "banco") || state.contas[0]; }
function cartaoPadrao() { return state.contas.find(c => c.tipo === "credito"); }
function contaOptionsHTML(selId, soBanco) {
  return state.contas.filter(c => !soBanco || c.tipo === "banco")
    .map(c => `<option value="${c.id}" ${c.id === selId ? "selected" : ""}>${escapeHtml(c.nome)}${c.tipo === "credito" ? " (crédito)" : ""}</option>`).join("");
}
function saldoConta(c) {
  const ms = state.movs.filter(m => m.contaId === c.id);
  const ent = ms.filter(m => m.tipo === "entrada").reduce((s, m) => s + Number(m.valor || 0), 0);
  const sai = ms.filter(m => m.tipo === "saida").reduce((s, m) => s + Number(m.valor || 0), 0);
  if (c.tipo === "credito") {
    const pagos = state.movs.filter(m => m.pagaFatura === c.id).reduce((s, m) => s + Number(m.valor || 0), 0);
    return sai - ent - pagos; // fatura em aberto
  }
  return Number(c.saldoInicial || 0) + ent - sai;
}
function caixaAtual() { return state.contas.filter(c => c.tipo === "banco").reduce((s, c) => s + saldoConta(c), 0); }
function faturasAbertas() { return state.contas.filter(c => c.tipo === "credito").reduce((s, c) => s + Math.max(0, saldoConta(c)), 0); }
// Pagamento de fatura e ajuste de saldo mexem no saldo, mas não são receita nem gasto.
function movContaComoResultado(m) { return !m.pagaFatura && !(m.origem && m.origem.tipo === "ajuste"); }
function addMov(m) {
  const mov = Object.assign({ id: "mov-" + uid(), criadoPor: currentUser ? currentUser.email : null }, m);
  state.movs.push(mov);
  return mov;
}
function removeMovById(id) { state.movs = state.movs.filter(m => m.id !== id); }
function movById(id) { return id ? state.movs.find(m => m.id === id) : null; }
function tagLabel(id) { const t = tagById(id); return t ? t.label : ""; }

// ---------------- Clientes mensais: primeiro pagamento e recebimentos ----------------
// Cliente novo só paga no mês seguinte à entrada (primeiroVenc). Clientes
// antigos (sem primeiroVenc) pagam todo mês. recebimentos["YYYY-MM"] guarda
// o lançamento no caixa daquele mês.
function primeiroVencPadrao(inicioISO, dia) { return diaNoMes(addMonthsISO(inicioISO, 1).slice(0, 7), dia || inicioISO.slice(8, 10)); }
function clientePagaNoMes(c, key) { return c.status === "ativo" && (!c.primeiroVenc || c.primeiroVenc.slice(0, 7) <= key); }
function clienteRecebimento(c, key) { return c.recebimentos ? c.recebimentos[key] : null; }
function clienteVencNoMes(c, key) { return (c.primeiroVenc && c.primeiroVenc.slice(0, 7) === key) ? c.primeiroVenc : diaNoMes(key, c.dia); }
// Ciclo do cliente: depois de pagar, fica "em dia" até perto do próximo
// vencimento; a partir de DIAS_AVISO_CLIENTE dias antes volta a ficar pendente.
const DIAS_AVISO_CLIENTE = 5;
const INICIO_CONTROLE = "2026-10"; // antes disso não havia controle por mês, então não cobra atrasado
function clienteSituacao(c) {
  // Mês anterior em aberto continua aparecendo como atrasado até ser pago.
  const prevKey = addMonthsISO(CUR_KEY + "-01", -1).slice(0, 7);
  if (prevKey >= INICIO_CONTROLE && clientePagaNoMes(c, prevKey) && !clienteRecebimento(c, prevKey)) return { st: "atrasado", venc: clienteVencNoMes(c, prevKey), key: prevKey };
  const rec = clienteRecebimento(c, CUR_KEY);
  const venc = clienteVencNoMes(c, CUR_KEY);
  if (rec) return { st: "pago", rec, prox: clienteVencNoMes(c, addMonthsISO(CUR_KEY + "-01", 1).slice(0, 7)) };
  if (venc < TODAY_ISO) return { st: "atrasado", venc, key: CUR_KEY };
  const limiteAviso = isoOf(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + DIAS_AVISO_CLIENTE));
  return { st: venc <= limiteAviso ? "pendente" : "emdia", venc, key: CUR_KEY };
}
function getActiveRevenue() { return state.clients.filter(c => clientePagaNoMes(c, CUR_KEY)).reduce((s, c) => s + Number(c.valor || 0), 0); }

// ---------------- Projeção mês a mês ----------------
function isRecurringBill(b) { return ["Ferramenta", "Parcelado", "Funcionário", "Prestador"].includes(b.kind); }
// Quanto da conta b ainda falta pagar no mês key. Conta atrasada cai no mês atual.
function contaPendenteNoMes(b, key) {
  if (b.status === "pago" || !b.due) return 0;
  let dk = b.due.slice(0, 7);
  if (dk < CUR_KEY) dk = CUR_KEY;
  if (key < dk) return 0;
  if (key === dk) return Number(b.value || 0);
  if (!isRecurringBill(b)) return 0;
  const k = monthsBetween(dk, key);
  if (b.kind === "Parcelado") return (b.parcelaAtual || 1) + k <= (b.parcelas || 1) ? Number(b.value || 0) : 0;
  const emp = empByBill(b);
  return emp ? Number(emp.base || 0) : Number(b.value || 0);
}
function aPagarNoMes(key) { return state.bills.reduce((s, b) => s + contaPendenteNoMes(b, key), 0); }
// Recebimentos ainda não feitos no mês key (no mês atual inclui os atrasados).
function clientesPendentesNoMes(key) {
  const out = state.clients.filter(c => clientePagaNoMes(c, key) && !clienteRecebimento(c, key));
  if (key === CUR_KEY) state.clients.forEach(c => { const s = c.status === "ativo" && clienteSituacao(c); if (s && s.key && s.key !== CUR_KEY) out.push(c); });
  return out;
}
function freelaParcelasPendentes(key) {
  const out = [];
  (state.freelas || []).forEach(f => (f.parcelas || []).forEach((p, idx) => {
    if (p.pago || !p.venc) return;
    const vk = p.venc.slice(0, 7);
    if (vk === key || (key === CUR_KEY && vk < CUR_KEY)) out.push({ f, p, idx });
  }));
  return out;
}
function soma(arr, fn) { return arr.reduce((s, x) => s + Number(fn(x) || 0), 0); }
function projecaoMes(key) {
  const movsMes = state.movs.filter(m => (m.data || "").slice(0, 7) === key && movContaComoResultado(m));
  const ent = movsMes.filter(m => m.tipo === "entrada");
  const origemTipo = m => m.origem && m.origem.tipo;
  const cliPend = soma(clientesPendentesNoMes(key), c => c.valor);
  const freePend = soma(freelaParcelasPendentes(key), x => x.p.valor);
  // Recebimento marcado antes desta versão (sem lançamento no caixa) ainda conta como receita do mês.
  const cliLegado = soma(state.clients.filter(c => { const r = clienteRecebimento(c, key); return r && r.legado; }), c => clienteRecebimento(c, key).valor);
  const clientes = soma(ent.filter(m => origemTipo(m) === "cliente"), m => m.valor) + cliLegado + cliPend;
  const freelas = soma(ent.filter(m => origemTipo(m) === "freela"), m => m.valor) + freePend;
  const outras = soma(ent.filter(m => !["cliente", "freela"].includes(origemTipo(m))), m => m.valor);
  const pagarPend = aPagarNoMes(key);
  const custos = soma(movsMes.filter(m => m.tipo === "saida"), m => m.valor) + pagarPend;
  return { clientes, freelas, outras, custos, lucro: clientes + freelas + outras - custos, receberPend: cliPend + freePend, pagarPend };
}

// ---------------- persistence ----------------
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 900);
}
function saveNow() {
  if (!currentMember || currentMember.role !== "admin") return;
  db.doc("empresas/pique/estado/dados").set({
    bills: state.bills, tags: state.tags, clients: state.clients, employees: state.employees,
    notas: state.notas, freelas: state.freelas, contas: state.contas, movs: state.movs, caixaAtual: caixaAtual(),
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
    state.contas = data.contas || [];
    state.movs = data.movs || [];
    state.caixaAtual = data.caixaAtual || 0;
    migrateState();
    renderAll();
  }, err => console.error("Erro ao ler estado:", err));
}
// Ajusta dados salvos antes do controle de caixa. Roda em memória a cada
// leitura; vai pro Firestore no próximo salvamento.
function migrateState() {
  if (!state.contas.length) {
    // O "Caixa atual" digitado à mão vira o saldo inicial da conta Inter.
    state.contas = [
      { id: "inter", nome: "Inter · conta T-Rec", tipo: "banco", saldoInicial: Number(state.caixaAtual || 0) },
      { id: "inter-credito", nome: "Cartão Inter", tipo: "credito", limite: 0, vencimento: 10 },
    ];
  }
  state.clients.forEach(c => {
    // "Pago este mês" antigo era só um sim/não sem mês: vale pro mês atual, sem lançamento no caixa.
    // O pagamento vale pro último vencimento que já passou (ex: dia 17, hoje 07/10 → o de 17/09).
    if (!c.recebimentos) {
      c.recebimentos = {};
      if (c.pago) {
        const key = diaNoMes(CUR_KEY, c.dia) <= TODAY_ISO ? CUR_KEY : addMonthsISO(CUR_KEY + "-01", -1).slice(0, 7);
        c.recebimentos[key] = { legado: true, valor: Number(c.valor || 0), data: TODAY_ISO };
      }
    }
    delete c.pago;
  });
  // Antes, conta mensal paga ficava "Pago" pra sempre. Agora ela anda pro
  // próximo vencimento (sem lançamento no caixa, que ainda não existia).
  state.bills.forEach(b => {
    if (b.status !== "pago" || b.ultimoPagamento || !isRecurringBill(b)) return;
    if (b.kind === "Parcelado" && (b.parcelaAtual || 1) >= (b.parcelas || 1)) return;
    const up = { legado: true, data: b.paidOn || b.due, valor: Number(b.value || 0), prev: { due: b.due, status: "pago", parcelaAtual: b.parcelaAtual } };
    let due = addMonthsISO(b.due, 1);
    if (b.kind === "Parcelado") b.parcelaAtual = (b.parcelaAtual || 1) + 1;
    else if (due.slice(0, 7) < CUR_KEY) due = diaNoMes(CUR_KEY, b.due.slice(8, 10)); // não inventa meses atrasados que ninguém controlava
    const emp = empByBill(b);
    if (emp) {
      up.empPrev = { despesas: emp.despesas || [], ajusteMes: emp.ajusteMes || null };
      emp.historico = (emp.historico || []).concat([{ mes: b.due.slice(0, 7), base: emp.base, despesas: emp.despesas || [], pago: up.valor, data: up.data }]);
      emp.despesas = [];
    }
    b.due = due; b.status = "pendente"; delete b.paidOn;
    b.ultimoPagamento = up;
  });
  state.employees.forEach(syncEmployeeBill);
}

// ---------------- tabs ----------------
const titles = {
  dashboard: ["Dashboard", "Visão geral do caixa, contas e operação"],
  caixa: ["Caixa", "Saldo da conta Inter, fatura do cartão e todas as entradas e saídas"],
  contas: ["Contas a Pagar", "Calendário e quadro de vencimentos de todas as contas da T-Rec"],
  custos: ["Custos Mensais", "Ferramentas, parcelamentos e folha de pagamento"],
  clientes: ["Clientes", "Cadastro, status e recorrência de pagamento"],
  freelas: ["Freelances", "Trabalhos avulsos do mês e quando cada pagamento entra no caixa"],
  notas: ["Notas Fiscais", "Arquivo de comprovantes por prestador de serviço"],
  equipe: ["Equipe & Acesso", "Quem pode entrar no financeiro da T-Rec e com qual permissão"],
};
function goToTab(tab) {
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.getElementById("tab-" + tab).classList.add("active");
  document.getElementById("pageTitle").textContent = titles[tab][0];
  document.getElementById("pageSubtitle").textContent = titles[tab][1];
}
document.querySelectorAll(".nav-item").forEach(btn => btn.addEventListener("click", () => goToTab(btn.dataset.tab)));
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
const EXP_TIPOS = [
  { v: "Vale", label: "Vale (adiantamento)" },
  { v: "Uber", label: "Uber" },
  { v: "Reembolso", label: "Reembolso" },
  { v: "Bônus", label: "Bônus / extra" },
  { v: "Outro", label: "Outro" },
];
function expLabel(d) { return isAdiantamento(d) ? "Vale · adiantamento" : d.tipo; }
function empCardEl(emp) {
  const div = document.createElement("div");
  div.className = "emp-card";
  div.dataset.id = emp.id;
  div.dataset.billId = emp.billId;
  const initials = emp.nome.trim().split(/\s+/).slice(0, 2).map(s => s[0].toUpperCase()).join("");
  const expHtml = (emp.despesas || []).map((d, i) => `<li data-idx="${i}" data-action="emp-edit-exp" title="${isAdiantamento(d) ? "Já saiu do caixa e é descontado do pagamento" : "Soma no pagamento"}"><span>${escapeHtml(expLabel(d))}${d.desc ? " · " + escapeHtml(d.desc) : ""} · ${fmtDate(d.data)}</span><span class="num ${isAdiantamento(d) ? "neg" : ""}">${isAdiantamento(d) ? "−" : "+"}${brl(d.valor)}</span><button class="btn-ghost" data-action="emp-del-exp" title="Excluir" type="button">✕</button></li>`).join("");
  const bill = state.bills.find(b => b.id === emp.billId);
  const pm = payPillMeta(bill);
  const aj = emp.ajusteMes;
  const ajHtml = aj && aj.valor ? `<li data-action="emp-ajuste" title="Ajuste só deste pagamento"><span>Ajuste do mês${aj.motivo ? " · " + escapeHtml(aj.motivo) : ""}</span><span class="num ${aj.valor < 0 ? "neg" : ""}">${aj.valor < 0 ? "−" : "+"}${brl(Math.abs(aj.valor))}</span><span style="width:22px"></span></li>` : "";
  const vales = empVales(emp);
  div.innerHTML = `
    <div class="emp-top">
      <div class="emp-avatar">${initials}</div>
      <div class="emp-info" data-action="emp-edit" title="Editar funcionário/prestador"><div class="emp-name">${escapeHtml(emp.nome)}</div><div class="emp-role">${escapeHtml(emp.funcao || "")}${bill ? " · paga " + fmtDate(bill.due) : ""}</div></div>
      <div class="emp-base" data-action="emp-edit" title="Editar funcionário/prestador"><div class="stat-label">Base</div><div class="num">${brl(emp.base)}</div></div>
      <button class="btn-ghost" data-action="emp-del" title="Excluir funcionário/prestador" type="button">✕</button>
    </div>
    <ul class="exp-list">${ajHtml}${expHtml}${(ajHtml || expHtml) ? "" : '<li class="exp-empty">Sem vales ou extras neste mês.</li>'}</ul>
    <div class="add-exp-row">
      <select name="tipo">${EXP_TIPOS.map(t => `<option value="${t.v}">${t.label}</option>`).join("")}</select>
      <input name="desc" type="text" placeholder="Descrição">
      <input name="valor" type="text" placeholder="R$ 0,00">
      <button class="btn btn-sm" data-action="emp-add-exp" type="button">+</button>
    </div>
    <button class="btn btn-sm emp-ajuste-btn" data-action="emp-ajuste" type="button">Ajustar valor deste mês</button>
    <div class="emp-sum">
      <div><span>Custo do mês</span><b class="num">${brl(empCusto(emp))}</b></div>
      ${vales ? `<div><span>Vales já pagos</span><b class="num neg">−${brl(vales)}</b></div>` : ""}
    </div>
    <div class="emp-total"><span>Falta pagar <b class="num">${brl(empAPagar(emp))}</b></span><button class="pay-pill ${pm.cls}">${pm.text}</button></div>`;
  return div;
}
function renderEmployees() {
  const grid = document.getElementById("empGrid");
  const addBtn = document.getElementById("btnAddEmp");
  grid.querySelectorAll(".emp-card").forEach(el => el.remove());
  state.employees.forEach(emp => grid.insertBefore(empCardEl(emp), addBtn));
  const total = state.employees.reduce((s, e) => s + empCusto(e), 0);
  document.getElementById("payrollTotal").textContent = brl(total);
}
function syncEmployeeBill(emp) {
  const bill = state.bills.find(b => b.id === emp.billId);
  if (bill) bill.value = empAPagar(emp);
}
function openAjusteForm(emp) {
  const atual = Number(emp.base || 0) + empAjuste(emp);
  document.getElementById("formModalTitle").textContent = "Ajustar pagamento · " + emp.nome;
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field"><label>Valor base</label><input type="text" value="${brl(emp.base)}" disabled></div>
      <div class="modal-field"><label>Valor deste mês</label><input type="text" id="ajValor" value="${brl(atual)}"></div>
      <div class="modal-field full"><label>Motivo</label><input type="text" id="ajMotivo" value="${escapeHtml((emp.ajusteMes && emp.ajusteMes.motivo) || "")}" placeholder="Ex: aumento, mais diárias, bônus"></div>
      <label class="check-line full"><input type="checkbox" id="ajPerm"> Vale pros próximos meses também (vira o novo valor base)</label>
    </div>
    <div class="modal-note">Vales e extras continuam sendo lançados no card. Aqui é só o valor do pagamento em si.</div>`;
  document.getElementById("formModalFoot").innerHTML = `
    ${emp.ajusteMes ? '<button class="btn btn-ghost" id="ajLimpar" type="button">Remover ajuste</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;"><button class="btn" id="ajCancel" type="button">Cancelar</button><button class="btn btn-accent" id="ajSave" type="button">Salvar</button></div>`;
  document.getElementById("ajCancel").addEventListener("click", closeFormModal);
  if (emp.ajusteMes) document.getElementById("ajLimpar").addEventListener("click", () => {
    emp.ajusteMes = null; syncEmployeeBill(emp); closeFormModal(); renderAll(); scheduleSave();
  });
  document.getElementById("ajSave").addEventListener("click", () => {
    const novo = parseBRL(document.getElementById("ajValor").value);
    const motivo = document.getElementById("ajMotivo").value.trim();
    if (document.getElementById("ajPerm").checked) { emp.base = novo; emp.ajusteMes = null; }
    else emp.ajusteMes = (novo - Number(emp.base || 0)) ? { valor: novo - Number(emp.base || 0), motivo } : null;
    syncEmployeeBill(emp); closeFormModal(); renderAll(); scheduleSave();
  });
  document.getElementById("formModalOverlay").classList.add("open");
}
// Vale sai do caixa na hora: cria/atualiza/remove o lançamento junto.
function syncValeMov(emp, d) {
  if (!isAdiantamento(d)) return;
  const mov = movById(d.movId);
  if (mov) { mov.valor = d.valor; mov.desc = `Vale · ${emp.nome}${d.desc ? " · " + d.desc : ""}`; return; }
  const conta = contaPadrao();
  d.movId = addMov({ tipo: "saida", valor: d.valor, data: d.data || TODAY_ISO, desc: `Vale · ${emp.nome}${d.desc ? " · " + d.desc : ""}`, contaId: conta ? conta.id : null, tagId: "custo-funcionario", origem: { tipo: "vale", ref: emp.id } }).id;
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
    const d = { tipo, desc, valor, data: TODAY_ISO };
    if (tipo === "Vale") d.adiantamento = true;
    emp.despesas.push(d);
    syncValeMov(emp, d);
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
    const d = emp.despesas[idx];
    if (!confirm(isAdiantamento(d) ? "Excluir este vale? O lançamento dele no caixa também é removido." : "Excluir este gasto?")) return;
    if (d.movId) removeMovById(d.movId);
    emp.despesas.splice(idx, 1);
    syncEmployeeBill(emp);
    renderAll();
    scheduleSave();
    return;
  }
  const ajBtn = e.target.closest('[data-action="emp-ajuste"]');
  if (ajBtn) {
    if (!requireAdmin()) return;
    const emp = state.employees.find(x => x.id === ajBtn.closest(".emp-card").dataset.id);
    if (emp) openAjusteForm(emp);
    return;
  }
  const delBtn = e.target.closest('[data-action="emp-del"]');
  if (delBtn) {
    if (!requireAdmin()) return;
    const card = delBtn.closest(".emp-card");
    const emp = state.employees.find(x => x.id === card.dataset.id);
    if (!emp) return;
    if (!confirm(`Excluir ${emp.nome}? Isso também remove a conta de pagamento dele. Os lançamentos já feitos no caixa continuam. Essa ação não pode ser desfeita.`)) return;
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
    const desc = prompt("Descrição:", d.desc || "");
    if (desc === null) return;
    const valor = parseBRL(prompt("Valor (R$):", String(d.valor).replace(".", ",")) || "0");
    if (!valor) return;
    d.desc = desc.trim(); d.valor = valor;
    syncValeMov(emp, d);
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
      <div class="modal-field full"><label>Cobrado em</label><select id="tfConta" ${readOnly ? "disabled" : ""}>${contaOptionsHTML(isEdit && bill.contaId ? bill.contaId : ((cartaoPadrao() || contaPadrao() || {}).id))}</select></div>
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
      const contaId = document.getElementById("tfConta").value;
      if (isEdit) {
        bill.title = nome; bill.categoria = categoria; bill.value = valor; bill.tagId = tagId; bill.contaId = contaId;
        // Mantém o mês do vencimento atual (pode já ter andado por causa de um pagamento); só troca o dia.
        bill.due = diaNoMes(bill.due.slice(0, 7), dia);
      } else {
        state.bills.push({ id: "tool-" + uid(), title: nome, kind: "Ferramenta", categoria, tagId, contaId, value: valor, due: nextDueISO(dia), status: "pendente" });
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
      <div class="modal-field"><label>Tag</label><select id="ifTag" ${readOnly ? "disabled" : ""}>${tagOptionsHTML(isEdit ? bill.tagId : (tagById("investimento") ? "investimento" : (state.tags[0] && state.tags[0].id)))}</select></div>
      <div class="modal-field"><label>Cobrado em</label><select id="ifConta" ${readOnly ? "disabled" : ""}>${contaOptionsHTML(isEdit && bill.contaId ? bill.contaId : ((contaPadrao() || {}).id))}</select></div>
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
      const contaId = document.getElementById("ifConta").value;
      if (isEdit) {
        bill.title = desc; bill.valorTotal = total; bill.parcelas = parcelas; bill.parcelaAtual = atual; bill.value = valor; bill.due = due; bill.tagId = tagId; bill.contaId = contaId;
      } else {
        state.bills.push({ id: "inst-" + uid(), title: desc, kind: "Parcelado", tagId, contaId, value: valor, valorTotal: total, parcelas, parcelaAtual: atual, due, status: "pendente" });
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
    <div class="modal-note">${isEdit ? "Mudar o valor base aqui vale pra todos os meses. Pra mudar só o pagamento deste mês, use “Ajustar valor deste mês” no card. " : ""}Vales (adiantamentos) e extras são lançados direto no card, em Funcionários &amp; Prestadores.</div>`;
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
        const b = state.bills.find(x => x.id === emp.billId);
        syncEmployeeBill(emp);
        if (b) { b.title = "Pagamento · " + nome; b.kind = tipo; b.due = due; }
      } else {
        const billId = "emp-" + uid();
        const empId = "person-" + uid();
        state.bills.push({ id: billId, title: "Pagamento · " + nome, kind: tipo, tagId: "custo-funcionario", contaId: (contaPadrao() || {}).id, value: base, due, status: "pendente" });
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

// ---------------- Pagar conta: lança a saída no caixa ----------------
// Conta recorrente (ferramenta, parcela, folha) paga anda pro próximo mês;
// conta avulsa fica como "Pago". ultimoPagamento guarda o que precisa pra desfazer.
function pagarConta(b, { data, contaId, valor, method }) {
  const emp = empByBill(b);
  const mov = addMov({ tipo: "saida", valor, data, desc: displayTitle(b), contaId, tagId: b.tagId, origem: { tipo: "conta", ref: b.id } });
  const prev = { due: b.due, parcelaAtual: b.parcelaAtual, status: b.status };
  const up = { movId: mov.id, data, valor, contaId, prev };
  b.method = method;
  if (emp) {
    up.empPrev = { despesas: emp.despesas || [], ajusteMes: emp.ajusteMes || null };
    emp.historico = emp.historico || [];
    emp.historico.push({ mes: b.due.slice(0, 7), base: emp.base, ajusteMes: emp.ajusteMes || null, despesas: emp.despesas || [], pago: valor, data });
    emp.despesas = []; emp.ajusteMes = null;
  }
  const ultimaParcela = b.kind === "Parcelado" && (b.parcelaAtual || 1) >= (b.parcelas || 1);
  if (isRecurringBill(b) && !ultimaParcela) {
    b.due = addMonthsISO(b.due, 1);
    if (b.kind === "Parcelado") b.parcelaAtual = (b.parcelaAtual || 1) + 1;
    b.status = "pendente"; delete b.paidOn;
  } else {
    b.status = "pago"; b.paidOn = data;
  }
  b.ultimoPagamento = up;
  if (emp) syncEmployeeBill(emp);
}
function desfazerPagamento(b) {
  const up = b.ultimoPagamento;
  if (!up) { b.status = "pendente"; delete b.paidOn; return; }
  removeMovById(up.movId);
  b.due = up.prev.due; b.status = up.prev.status || "pendente";
  if (up.prev.parcelaAtual != null) b.parcelaAtual = up.prev.parcelaAtual;
  if (b.status !== "pago") delete b.paidOn;
  const emp = empByBill(b);
  if (emp && up.empPrev) {
    emp.despesas = up.empPrev.despesas; emp.ajusteMes = up.empPrev.ajusteMes;
    if (emp.historico && emp.historico.length) emp.historico.pop();
    syncEmployeeBill(emp);
  }
  delete b.ultimoPagamento;
}

// ---------------- Bill detail / payment / delete modal ----------------
function openBillModal(id) {
  const b = state.bills.find(x => x.id === id);
  if (!b) return;
  currentModalId = id;
  const isPayroll = b.kind === "Funcionário" || b.kind === "Prestador";
  const recorrente = isRecurringBill(b);
  document.getElementById("modalTitle").textContent = displayTitle(b);
  const tagOptions = tagOptionsHTML(b.tagId);
  const methodOptions = PAYMENT_METHODS.map(m => `<option value="${m}" ${b.method === m ? "selected" : ""}>${m}</option>`).join("");
  const readOnly = !currentMember || currentMember.role !== "admin";
  const up = b.ultimoPagamento;
  const contaSel = (up && b.status === "pago" && up.contaId) || b.contaId || (contaPadrao() || {}).id;
  let body = "";
  if (isPayroll) body += `<div class="modal-note">O valor é base + ajuste + extras do mês, menos os vales já pagos (Custos Mensais → Funcionários &amp; Prestadores). Pra mudar o valor, edite por lá.</div>`;
  if (recorrente && b.status !== "pago") body += `<div class="modal-note">Conta mensal: ao marcar como paga, a saída entra no caixa e o vencimento passa pro mês seguinte.</div>`;
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
    <div id="mfPaidWrap" style="display:${b.status === "pago" ? "flex" : "none"}; flex-direction:column; gap:14px;">
      <div class="modal-field"><label>Pago com (sai de qual conta)</label><select id="mfConta" ${readOnly ? "disabled" : ""}>${contaOptionsHTML(contaSel)}</select></div>
      <div class="modal-field"><label>Forma de pagamento</label><select id="mfMethod" ${readOnly ? "disabled" : ""}>${methodOptions}</select></div>
      <div class="modal-field"><label>Data do pagamento</label><input type="date" id="mfPaidOn" value="${b.paidOn || TODAY_ISO}" ${readOnly ? "disabled" : ""}></div>
    </div>`;
  if (up && b.status !== "pago") {
    const c = contaById(up.contaId);
    body += `<div class="modal-note">Último pagamento: ${fmtDateFull(up.data)} · ${brl(up.valor)}${c ? " · " + escapeHtml(c.nome) : ""}${readOnly ? "" : ' — <button class="link-btn" id="mfUndo" type="button">desfazer</button>'}</div>`;
  }
  document.getElementById("modalBody").innerHTML = body;
  document.getElementById("modalFoot").innerHTML = `
    ${(!isPayroll && !readOnly) ? '<button class="btn btn-ghost" id="mfDelete" type="button" style="color:var(--negative);">Excluir conta</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;">
      <button class="btn" id="mfCancel" type="button">${readOnly ? "Fechar" : "Cancelar"}</button>
      ${readOnly ? "" : '<button class="btn btn-accent" id="mfSave" type="button">Salvar</button>'}
    </div>`;
  if (!readOnly) {
    const contaEl = document.getElementById("mfConta");
    const methodEl = document.getElementById("mfMethod");
    const syncMethod = () => { const c = contaById(contaEl.value); if (c && c.tipo === "credito") methodEl.value = "Cartão de crédito"; else if (methodEl.value === "Cartão de crédito") methodEl.value = "Pix"; };
    contaEl.addEventListener("change", syncMethod);
    if (b.status !== "pago") syncMethod();
    document.querySelectorAll("#mfStatusToggle button").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#mfStatusToggle button").forEach(x => x.classList.remove("on"));
        btn.classList.add("on");
        document.getElementById("mfPaidWrap").style.display = btn.dataset.st === "pago" ? "flex" : "none";
      });
    });
    wireNewTagOption(document.getElementById("mfTag"), b.tagId);
    document.getElementById("mfSave").addEventListener("click", saveBillModal);
    if (!isPayroll) document.getElementById("mfDelete").addEventListener("click", deleteBillModal);
    const undo = document.getElementById("mfUndo");
    if (undo) undo.addEventListener("click", () => {
      if (!confirm("Desfazer o último pagamento? O lançamento sai do caixa e a conta volta pro vencimento anterior.")) return;
      desfazerPagamento(b);
      closeBillModal(); renderAll(); scheduleSave();
    });
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
  b.tagId = document.getElementById("mfTag").value;
  const wantPago = document.querySelector("#mfStatusToggle button.on").dataset.st === "pago";
  const pay = {
    data: document.getElementById("mfPaidOn").value || TODAY_ISO,
    contaId: document.getElementById("mfConta").value,
    method: document.getElementById("mfMethod").value,
  };
  if (wantPago && b.status !== "pago") {
    if (dueVal) b.due = dueVal;
    pagarConta(b, Object.assign(pay, { valor: Number(b.value || 0) }));
  } else if (!wantPago && b.status === "pago") {
    desfazerPagamento(b);
    if (dueVal) b.due = dueVal;
  } else {
    if (dueVal) b.due = dueVal;
    if (b.status === "pago") {
      // Conta já paga: mantém o lançamento do caixa igual ao que está no formulário.
      b.paidOn = pay.data; b.method = pay.method;
      const mov = movById(b.ultimoPagamento && b.ultimoPagamento.movId);
      if (mov) Object.assign(mov, { valor: Number(b.value || 0), data: pay.data, contaId: pay.contaId, desc: displayTitle(b), tagId: b.tagId });
      if (b.ultimoPagamento) Object.assign(b.ultimoPagamento, { valor: Number(b.value || 0), data: pay.data, contaId: pay.contaId });
    }
  }
  closeBillModal();
  renderFilterChips();
  renderAll();
  scheduleSave();
}
function deleteBillModal() {
  if (!confirm("Excluir esta conta? Os pagamentos já lançados no caixa continuam lá. Essa ação não pode ser desfeita.")) return;
  const idx = state.bills.findIndex(x => x.id === currentModalId);
  if (idx > -1) state.bills.splice(idx, 1);
  closeBillModal();
  renderFilterChips();
  renderAll();
  scheduleSave();
}
// Conta avulsa (não recorrente): imposto, equipamento à vista, etc.
function openAvulsaForm() {
  document.getElementById("formModalTitle").textContent = "Nova conta a pagar";
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field full"><label>Descrição</label><input type="text" id="afDesc" placeholder="Ex: DAS do MEI, lente nova"></div>
      <div class="modal-field"><label>Valor</label><input type="text" id="afValor" placeholder="R$ 0,00"></div>
      <div class="modal-field"><label>Vencimento</label><input type="date" id="afDue" value="${TODAY_ISO}"></div>
      <div class="modal-field"><label>Tag</label><select id="afTag">${tagOptionsHTML(tagById("operacional") ? "operacional" : (state.tags[0] && state.tags[0].id))}</select></div>
      <div class="modal-field"><label>Pagar com</label><select id="afConta">${contaOptionsHTML((contaPadrao() || {}).id)}</select></div>
    </div>
    <div class="modal-note">Pra gasto que já foi pago, use “+ Saída” na aba Caixa. Assinaturas e parcelamentos ficam em Custos Mensais.</div>`;
  document.getElementById("formModalFoot").innerHTML = `<span></span><div style="display:flex; gap:8px;"><button class="btn" id="afCancel" type="button">Cancelar</button><button class="btn btn-accent" id="afSave" type="button">Salvar</button></div>`;
  wireNewTagOption(document.getElementById("afTag"), null);
  document.getElementById("afCancel").addEventListener("click", closeFormModal);
  document.getElementById("afSave").addEventListener("click", () => {
    const title = document.getElementById("afDesc").value.trim();
    const value = parseBRL(document.getElementById("afValor").value);
    if (!title || !value) return;
    state.bills.push({ id: "bill-" + uid(), title, kind: "Conta avulsa", tagId: document.getElementById("afTag").value, contaId: document.getElementById("afConta").value, value, due: document.getElementById("afDue").value || TODAY_ISO, status: "pendente" });
    closeFormModal(); renderFilterChips(); renderAll(); scheduleSave();
  });
  document.getElementById("formModalOverlay").classList.add("open");
}
document.getElementById("btnNewBill").addEventListener("click", () => { if (requireAdmin()) openAvulsaForm(); });
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

// ---------------- Receber: modal genérico que lança a entrada no caixa ----------------
function openReceberModal({ titulo, valor, data, nota, onConfirm }) {
  document.getElementById("formModalTitle").textContent = titulo;
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field"><label>Valor recebido</label><input type="text" id="rcValor" value="${brl(valor)}"></div>
      <div class="modal-field"><label>Data</label><input type="date" id="rcData" value="${data || TODAY_ISO}"></div>
      <div class="modal-field full"><label>Entrou na conta</label><select id="rcConta">${contaOptionsHTML((contaPadrao() || {}).id, true)}</select></div>
    </div>
    ${nota ? `<div class="modal-note">${nota}</div>` : ""}`;
  document.getElementById("formModalFoot").innerHTML = `<span></span><div style="display:flex; gap:8px;"><button class="btn" id="rcCancel" type="button">Cancelar</button><button class="btn btn-accent" id="rcSave" type="button">Confirmar recebimento</button></div>`;
  document.getElementById("rcCancel").addEventListener("click", () => { closeFormModal(); renderAll(); });
  document.getElementById("rcSave").addEventListener("click", () => {
    const v = parseBRL(document.getElementById("rcValor").value);
    if (!v) return;
    onConfirm({ valor: v, data: document.getElementById("rcData").value || TODAY_ISO, contaId: document.getElementById("rcConta").value });
    closeFormModal(); renderAll(); scheduleSave();
  });
  document.getElementById("formModalOverlay").classList.add("open");
}

// ---------------- Clientes ----------------
function receberCliente(c, key, { valor, data, contaId }) {
  const mov = addMov({ tipo: "entrada", valor, data, desc: `Mensalidade · ${c.nome}`, contaId, cat: "Cliente mensal", origem: { tipo: "cliente", ref: c.id, mes: key } });
  c.recebimentos = c.recebimentos || {};
  c.recebimentos[key] = { movId: mov.id, valor, data };
  return mov;
}
function desfazerRecebimentoCliente(c, key) {
  const r = clienteRecebimento(c, key);
  if (r && r.movId) removeMovById(r.movId);
  if (c.recebimentos) delete c.recebimentos[key];
}
function clientRowHTML(c) {
  const rec = clienteRecebimento(c, CUR_KEY);
  const sit0 = c.status === "ativo" ? clienteSituacao(c) : null;
  let payCell;
  if (rec && !(sit0 && sit0.key && sit0.key !== CUR_KEY)) {
    payCell = `<label class="pay-toggle"><input type="checkbox" data-action="client-pago" checked><span class="pay-dot"></span>Pago ${fmtDate(rec.data)} · próximo ${fmtDate(clienteSituacao(c).prox)}</label>`;
  } else if (c.status !== "ativo") {
    payCell = "—";
  } else if (!clientePagaNoMes(c, CUR_KEY)) {
    payCell = `<span class="badge pausado" title="Entrou agora: o primeiro pagamento é no mês seguinte">1º pgto ${fmtDateFull(c.primeiroVenc)}</span>`;
  } else {
    const sit = clienteSituacao(c);
    const txt = sit.st === "atrasado" ? `Atrasado · venceu ${fmtDate(sit.venc)}`
      : sit.st === "pendente" ? `Pendente · vence ${fmtDate(sit.venc)}`
      : `Em dia · próximo ${fmtDate(sit.venc)}`;
    const cls = sit.st === "atrasado" ? "neg" : sit.st === "pendente" ? "warn-txt" : "pos";
    payCell = `<label class="pay-toggle" title="Marque quando o cliente pagar: o valor entra no caixa"><input type="checkbox" data-action="client-pago"><span class="pay-dot"></span><span class="${cls}">${txt}</span></label>`;
  }
  return `<tr data-id="${c.id}">
    <td class="client-name" data-action="client-edit" title="Editar cliente">${escapeHtml(c.nome)}${c.inicio ? `<span class="freela-sub">desde ${fmtDateFull(c.inicio)}</span>` : ""}</td>
    <td class="num">${brl(c.valor)}</td><td>${escapeHtml(c.dia)}</td>
    <td><select class="status-select ${c.status}" data-action="client-status">
      <option value="ativo" ${c.status === "ativo" ? "selected" : ""}>Ativo</option>
      <option value="pausado" ${c.status === "pausado" ? "selected" : ""}>Pausado</option>
      <option value="novo" ${c.status === "novo" ? "selected" : ""}>Não gravou ainda</option>
    </select></td>
    <td>${payCell}</td>
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
  const recebido = soma(state.clients, c => { const r = clienteRecebimento(c, CUR_KEY); return r ? r.valor : 0; });
  document.getElementById("chipRecebidoMes").textContent = brl(recebido);
}
function openClientForm(c) {
  const isEdit = !!c;
  const inicio = isEdit ? (c.inicio || "") : TODAY_ISO;
  document.getElementById("formModalTitle").textContent = isEdit ? "Editar cliente" : "Novo cliente mensal";
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field full"><label>Nome do cliente</label><input type="text" id="cfNome" value="${isEdit ? escapeHtml(c.nome) : ""}" placeholder="Ex: Studio X"></div>
      <div class="modal-field"><label>Valor mensal</label><input type="text" id="cfValor" value="${isEdit ? brl(c.valor) : ""}" placeholder="R$ 0,00"></div>
      <div class="modal-field"><label>Dia de pagamento</label><input type="number" id="cfDia" min="1" max="31" value="${isEdit ? escapeHtml(c.dia) : TODAY.getDate()}"></div>
      <div class="modal-field"><label>Entrou em</label><input type="date" id="cfInicio" value="${inicio}"></div>
      <div class="modal-field"><label>1º pagamento</label><input type="date" id="cfPrimeiro" value="${isEdit ? (c.primeiroVenc || "") : primeiroVencPadrao(TODAY_ISO, String(TODAY.getDate()))}"></div>
      <div class="modal-field full"><label>Status</label><select id="cfStatus">
        <option value="ativo" ${!isEdit || c.status === "ativo" ? "selected" : ""}>Ativo</option>
        <option value="pausado" ${isEdit && c.status === "pausado" ? "selected" : ""}>Pausado</option>
        <option value="novo" ${isEdit && c.status === "novo" ? "selected" : ""}>Não gravou ainda</option>
      </select></div>
    </div>
    <div class="modal-note">Cliente mensal começa a pagar no mês seguinte ao que entrou (o 1º pagamento é calculado sozinho, mas dá pra mudar). Trabalho avulso que pode pagar antes ou depois vai na aba Freelances.</div>`;
  document.getElementById("formModalFoot").innerHTML = `
    ${isEdit ? '<button class="btn btn-ghost" id="cfDelete" type="button" style="color:var(--negative);">Excluir cliente</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;"><button class="btn" id="cfCancel" type="button">Cancelar</button><button class="btn btn-accent" id="cfSave" type="button">Salvar</button></div>`;
  const $ = id => document.getElementById(id);
  let primeiroTocado = isEdit && !!c.primeiroVenc;
  $("cfPrimeiro").addEventListener("input", () => { primeiroTocado = true; });
  const recalc = () => { if (!primeiroTocado && $("cfInicio").value) $("cfPrimeiro").value = primeiroVencPadrao($("cfInicio").value, $("cfDia").value); };
  $("cfInicio").addEventListener("change", recalc);
  $("cfDia").addEventListener("change", recalc);
  $("cfCancel").addEventListener("click", closeFormModal);
  if (isEdit) $("cfDelete").addEventListener("click", () => {
    if (!confirm(`Excluir ${c.nome}? Os recebimentos já lançados no caixa continuam lá.`)) return;
    state.clients = state.clients.filter(x => x.id !== c.id);
    closeFormModal(); renderAll(); scheduleSave();
  });
  $("cfSave").addEventListener("click", () => {
    const nome = $("cfNome").value.trim();
    const valor = parseBRL($("cfValor").value);
    if (!nome) { $("cfNome").focus(); return; }
    if (!valor) { $("cfValor").focus(); return; }
    const dados = { nome, valor, dia: $("cfDia").value.trim(), status: $("cfStatus").value, inicio: $("cfInicio").value || null, primeiroVenc: $("cfPrimeiro").value || null };
    if (isEdit) Object.assign(c, dados);
    else state.clients.push(Object.assign({ id: "client-" + uid(), recebimentos: {} }, dados));
    closeFormModal(); renderAll(); scheduleSave();
  });
  document.getElementById("formModalOverlay").classList.add("open");
}
document.getElementById("btnNewClient").addEventListener("click", () => {
  if (!requireAdmin()) return;
  openClientForm(null);
});
document.getElementById("clientsBody").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const c = state.clients.find(x => x.id === tr.dataset.id);
  if (!c) return;
  if (e.target.closest('[data-action="client-edit"]')) { if (requireAdmin()) openClientForm(c); return; }
  if (!e.target.closest('[data-action="client-del"]')) return;
  if (!requireAdmin()) return;
  if (!confirm(`Excluir ${c.nome}? Os recebimentos já lançados no caixa continuam lá.`)) return;
  state.clients = state.clients.filter(x => x.id !== c.id);
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
    renderAll();
    scheduleSave();
  }
  if (e.target.dataset.action === "client-pago") {
    if (!requireAdmin()) { renderClients(); return; }
    if (e.target.checked) {
      const sit = clienteSituacao(c);
      const key = sit.key || CUR_KEY;
      openReceberModal({
        titulo: "Recebimento · " + c.nome, valor: c.valor, data: TODAY_ISO,
        nota: `Mensalidade de ${monthLabel(key)} (vencimento ${fmtDateFull(clienteVencNoMes(c, key))}). O valor entra no saldo da conta escolhida.`,
        onConfirm: dados => receberCliente(c, key, dados),
      });
    } else {
      if (!confirm(`Desmarcar o recebimento de ${c.nome}? O lançamento sai do caixa.`)) { renderClients(); return; }
      desfazerRecebimentoCliente(c, CUR_KEY);
      renderAll();
      scheduleSave();
    }
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
  const idx = Number(tr.dataset.idx);
  const p = f && f.parcelas[idx];
  if (!p) return;
  if (e.target.checked) {
    openReceberModal({
      titulo: "Recebimento · " + f.titulo, valor: p.valor, data: TODAY_ISO,
      nota: f.parcelas.length > 1 ? `Parcela ${idx + 1} de ${f.parcelas.length}.` : "",
      onConfirm: ({ valor, data, contaId }) => {
        p.pago = true; p.pagoEm = data;
        p.movId = addMov({ tipo: "entrada", valor, data, desc: freelaMovDesc(f, idx), contaId, cat: "Freelance", origem: { tipo: "freela", ref: f.id } }).id;
      },
    });
    return;
  }
  if (!confirm("Desmarcar este recebimento? O lançamento sai do caixa.")) { renderFreelas(); return; }
  if (p.movId) removeMovById(p.movId);
  p.pago = false; delete p.pagoEm; delete p.movId;
  renderAll();
  scheduleSave();
});
function freelaMovDesc(f, idx) { return `Freela · ${f.titulo}${f.parcelas.length > 1 ? ` (${idx + 1}/${f.parcelas.length})` : ""}`; }
// Depois de salvar o freela pelo formulário: parcela marcada como recebida
// ganha lançamento no caixa; desmarcada ou removida perde o dela.
function syncFreelaMovs(f, anteriores) {
  const vivos = new Set();
  f.parcelas.forEach((p, idx) => {
    const mov = movById(p.movId);
    if (p.pago) {
      if (mov) Object.assign(mov, { data: p.pagoEm || mov.data, desc: freelaMovDesc(f, idx) });
      else {
        const conta = contaPadrao();
        p.movId = addMov({ tipo: "entrada", valor: p.valor, data: p.pagoEm || TODAY_ISO, desc: freelaMovDesc(f, idx), contaId: conta ? conta.id : null, cat: "Freelance", origem: { tipo: "freela", ref: f.id } }).id;
      }
      vivos.add(p.movId);
    } else if (p.movId) { removeMovById(p.movId); delete p.movId; }
  });
  (anteriores || []).forEach(p => { if (p.movId && !vivos.has(p.movId)) removeMovById(p.movId); });
}
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
    if (old.movId) p.movId = old.movId;
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
      const anteriores = isEdit ? (f.parcelas || []) : [];
      let alvo = f;
      if (isEdit) Object.assign(f, dados);
      else { alvo = Object.assign({ id: "freela-" + uid(), criadoPor: currentUser ? currentUser.email : null }, dados); state.freelas.push(alvo); }
      syncFreelaMovs(alvo, anteriores);
      const [y, m] = dados.data.split("-").map(Number);
      freelaYear = y; freelaMonth = m - 1;
      closeFormModal();
      renderAll();
      scheduleSave();
    });
    if (isEdit) $("ffDelete").addEventListener("click", () => {
      const recebidas = (f.parcelas || []).filter(p => p.movId);
      if (!confirm("Excluir este freela?" + (recebidas.length ? " Os recebimentos dele lançados no caixa também saem." : "") + " Essa ação não pode ser desfeita.")) return;
      recebidas.forEach(p => removeMovById(p.movId));
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

// ---------------- Caixa ----------------
function movOrigemLabel(m) {
  const o = m.origem || {};
  if (m.pagaFatura) return "Fatura do cartão";
  return { cliente: "Cliente mensal", freela: "Freelance", conta: "Conta paga", vale: "Vale", ajuste: "Ajuste de saldo" }[o.tipo] || "";
}
function movCategoria(m) { return m.tipo === "saida" ? (tagLabel(m.tagId) || m.cat || "") : (m.cat || movOrigemLabel(m)); }
function renderContas() {
  const cards = state.contas.map(c => {
    const v = saldoConta(c);
    if (c.tipo === "credito") {
      const disp = Number(c.limite || 0) ? `<div class="stat-sub">Limite disponível ${brl(Number(c.limite) - Math.max(0, v))}</div>` : "";
      return `<div class="conta-card credito" data-conta-id="${c.id}">
        <div class="conta-head"><span class="stat-label">Cartão de crédito</span><button class="btn-ghost" data-action="conta-edit" type="button" title="Editar">✎</button></div>
        <div class="conta-nome">${escapeHtml(c.nome)}</div>
        <div class="stat-value num ${v > 0 ? "neg" : ""}">${brl(Math.max(0, v))}</div>
        <div class="stat-sub">Fatura em aberto${c.vencimento ? " · vence dia " + c.vencimento : ""}</div>${disp}
        <div class="conta-actions admin-only"><button class="btn btn-sm" data-action="conta-fatura" type="button">Pagar fatura</button></div>
      </div>`;
    }
    return `<div class="conta-card" data-conta-id="${c.id}">
      <div class="conta-head"><span class="stat-label">Conta bancária</span><button class="btn-ghost" data-action="conta-edit" type="button" title="Editar">✎</button></div>
      <div class="conta-nome">${escapeHtml(c.nome)}</div>
      <div class="stat-value num ${v < 0 ? "neg" : ""}">${v < 0 ? "−" : ""}${brl(Math.abs(v))}</div>
      <div class="stat-sub">Saldo calculado pelos lançamentos</div>
      <div class="conta-actions admin-only"><button class="btn btn-sm" data-action="conta-ajuste" type="button">Conferir saldo com o banco</button></div>
    </div>`;
  }).join("");
  document.getElementById("contaGrid").innerHTML = cards + '<button class="add-emp-card admin-only" id="btnAddConta" type="button" style="min-height:120px;">+ Conta ou cartão</button>';
  const sel = document.getElementById("caixaFiltro");
  sel.innerHTML = '<option value="todas">Todas as contas</option>' + contaOptionsHTML(caixaFiltroConta);
  sel.value = state.contas.some(c => c.id === caixaFiltroConta) ? caixaFiltroConta : "todas";
}
function renderExtrato() {
  const key = monthKeyOf(caixaYear, caixaMonth);
  document.getElementById("caixaMonthTitle").textContent = monthLabel(key);
  const doMes = state.movs.filter(m => (m.data || "").slice(0, 7) === key);
  const lista = doMes.filter(m => caixaFiltroConta === "todas" || m.contaId === caixaFiltroConta || m.pagaFatura === caixaFiltroConta)
    .sort((a, b) => (b.data || "").localeCompare(a.data || ""));
  document.getElementById("extratoBody").innerHTML = lista.length ? lista.map(m => {
    const c = contaById(m.contaId);
    const ent = m.tipo === "entrada";
    const origem = movOrigemLabel(m);
    return `<tr class="row-click" data-mov-id="${m.id}">
      <td>${fmtDate(m.data)}</td>
      <td>${escapeHtml(m.desc || "")}${origem && !movContaComoResultado(m) ? `<span class="freela-sub">${origem} · não conta como ${ent ? "receita" : "gasto"}</span>` : ""}</td>
      <td>${escapeHtml(movCategoria(m))}</td>
      <td>${c ? escapeHtml(c.nome) : "—"}</td>
      <td class="num ${ent ? "pos" : "neg"}" style="text-align:right;">${ent ? "+" : "−"}${brl(m.valor)}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="5" class="empty-hint">Nenhum lançamento neste mês.</td></tr>';
  const res = doMes.filter(movContaComoResultado);
  const ent = soma(res.filter(m => m.tipo === "entrada"), m => m.valor);
  const sai = soma(res.filter(m => m.tipo === "saida"), m => m.valor);
  document.getElementById("chipCxEntradas").textContent = brl(ent);
  document.getElementById("chipCxSaidas").textContent = brl(sai);
  const r = document.getElementById("chipCxResultado");
  r.textContent = (ent - sai < 0 ? "−" : "") + brl(Math.abs(ent - sai));
  r.className = ent - sai > 0 ? "pos" : ent - sai < 0 ? "neg" : "";
}
function renderCaixa() { renderContas(); renderExtrato(); }
document.getElementById("caixaPrev").addEventListener("click", () => { caixaMonth--; if (caixaMonth < 0) { caixaMonth = 11; caixaYear--; } renderExtrato(); });
document.getElementById("caixaNext").addEventListener("click", () => { caixaMonth++; if (caixaMonth > 11) { caixaMonth = 0; caixaYear++; } renderExtrato(); });
document.getElementById("caixaFiltro").addEventListener("change", e => { caixaFiltroConta = e.target.value; renderExtrato(); });
document.getElementById("btnNovaEntrada").addEventListener("click", () => { if (requireAdmin()) openMovForm(null, "entrada"); });
document.getElementById("btnNovaSaida").addEventListener("click", () => { if (requireAdmin()) openMovForm(null, "saida"); });
document.getElementById("extratoBody").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-mov-id]");
  const m = tr && movById(tr.dataset.movId);
  if (m && requireAdmin()) openMovForm(m, m.tipo);
});
document.getElementById("contaGrid").addEventListener("click", e => {
  if (e.target.closest("#btnAddConta")) { if (requireAdmin()) openContaForm(null); return; }
  const card = e.target.closest("[data-conta-id]");
  const c = card && contaById(card.dataset.contaId);
  if (!c || !requireAdmin()) return;
  const act = e.target.closest("[data-action]");
  if (!act) return;
  if (act.dataset.action === "conta-edit") openContaForm(c);
  if (act.dataset.action === "conta-fatura") openPagarFatura(c);
  if (act.dataset.action === "conta-ajuste") ajustarSaldo(c);
});

// Lançamento manual (ou edição de qualquer lançamento). Entrada pode ser
// marcada como mensalidade de um cliente: aí o cliente fica como recebido no mês.
function openMovForm(m, tipo) {
  const isEdit = !!m;
  const o = (m && m.origem) || {};
  const linked = isEdit && (o.tipo || m.pagaFatura);
  const clientesAtivos = state.clients.filter(c => c.status === "ativo" || (isEdit && o.tipo === "cliente" && o.ref === c.id));
  document.getElementById("formModalTitle").textContent = (isEdit ? "Editar " : "Nova ") + (tipo === "entrada" ? "entrada" : "saída");
  const catField = tipo === "saida"
    ? `<div class="modal-field"><label>Categoria (tag)</label><select id="mvTag">${tagOptionsHTML(isEdit ? m.tagId : (tagById("operacional") ? "operacional" : (state.tags[0] && state.tags[0].id)))}</select></div>`
    : `<div class="modal-field"><label>Categoria</label><input type="text" id="mvCat" list="mvCats" value="${isEdit ? escapeHtml(m.cat || "") : ""}" placeholder="Ex: Aporte, Reembolso"><datalist id="mvCats"><option value="Cliente mensal"><option value="Freelance"><option value="Aporte dos sócios"><option value="Reembolso"><option value="Rendimento"></datalist></div>`;
  const clienteField = (tipo === "entrada" && (!isEdit || o.tipo === "cliente")) ? `
      <div class="modal-field full"><label>Recebido de cliente mensal?</label><select id="mvCliente" ${isEdit ? "disabled" : ""}>
        <option value="">Não — outra entrada</option>
        ${clientesAtivos.map(c => `<option value="${c.id}" ${o.ref === c.id ? "selected" : ""}>${escapeHtml(c.nome)} · ${brl(c.valor)}</option>`).join("")}
      </select></div>` : "";
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      ${clienteField}
      <div class="modal-field full"><label>Descrição</label><input type="text" id="mvDesc" value="${isEdit ? escapeHtml(m.desc || "") : ""}" placeholder="${tipo === "entrada" ? "Ex: Aporte, devolução" : "Ex: Mercado pro set, Uber, combustível"}"></div>
      <div class="modal-field"><label>Valor</label><input type="text" id="mvValor" value="${isEdit ? brl(m.valor) : ""}" placeholder="R$ 0,00"></div>
      <div class="modal-field"><label>Data</label><input type="date" id="mvData" value="${isEdit ? m.data : TODAY_ISO}"></div>
      <div class="modal-field"><label>${tipo === "entrada" ? "Entrou em" : "Saiu de"}</label><select id="mvConta">${contaOptionsHTML(isEdit ? m.contaId : (contaPadrao() || {}).id, tipo === "entrada")}</select></div>
      ${catField}
    </div>
    ${linked ? `<div class="modal-note">Lançamento automático (${movOrigemLabel(m)}). Excluir aqui também desfaz a marcação de origem.</div>` : ""}`;
  document.getElementById("formModalFoot").innerHTML = `
    ${isEdit ? '<button class="btn btn-ghost" id="mvDelete" type="button" style="color:var(--negative);">Excluir lançamento</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;"><button class="btn" id="mvCancel" type="button">Cancelar</button><button class="btn btn-accent" id="mvSave" type="button">Salvar</button></div>`;
  const $ = id => document.getElementById(id);
  if (tipo === "saida") wireNewTagOption($("mvTag"), isEdit ? m.tagId : null);
  if ($("mvCliente") && !isEdit) $("mvCliente").addEventListener("change", e => {
    const c = state.clients.find(x => x.id === e.target.value);
    if (!c) return;
    $("mvValor").value = brl(c.valor);
    $("mvDesc").value = "Mensalidade · " + c.nome;
    $("mvCat").value = "Cliente mensal";
  });
  $("mvCancel").addEventListener("click", closeFormModal);
  if (isEdit) $("mvDelete").addEventListener("click", () => {
    if (!confirm("Excluir este lançamento? O saldo da conta é recalculado.")) return;
    deleteMov(m);
    closeFormModal(); renderAll(); scheduleSave();
  });
  $("mvSave").addEventListener("click", () => {
    const valor = parseBRL($("mvValor").value);
    if (!valor) { $("mvValor").focus(); return; }
    const data = $("mvData").value || TODAY_ISO;
    const dados = { tipo, valor, data, desc: $("mvDesc").value.trim() || (tipo === "entrada" ? "Entrada" : "Saída"), contaId: $("mvConta").value };
    if (tipo === "saida") dados.tagId = $("mvTag").value; else dados.cat = $("mvCat").value.trim();
    const cliente = !isEdit && $("mvCliente") ? state.clients.find(x => x.id === $("mvCliente").value) : null;
    if (cliente) {
      const key = data.slice(0, 7);
      if (clienteRecebimento(cliente, key) && !confirm(`${cliente.nome} já está como recebido em ${monthLabel(key)}. Lançar mesmo assim (substitui o anterior)?`)) return;
      desfazerRecebimentoCliente(cliente, key);
      const mov = receberCliente(cliente, key, { valor, data, contaId: dados.contaId });
      mov.desc = dados.desc; mov.cat = dados.cat || mov.cat;
    } else if (isEdit) {
      const mesAntes = (m.data || "").slice(0, 7);
      Object.assign(m, dados);
      syncOrigemAposEdicao(m, mesAntes);
    } else addMov(dados);
    closeFormModal(); renderAll(); scheduleSave();
  });
  document.getElementById("formModalOverlay").classList.add("open");
}
// Mantém a origem (cliente/freela/vale/conta) coerente quando o lançamento é editado.
function syncOrigemAposEdicao(m, mesAntes) {
  const o = m.origem || {};
  if (o.tipo === "cliente") {
    const c = state.clients.find(x => x.id === o.ref);
    if (!c) return;
    c.recebimentos = c.recebimentos || {};
    const mes = m.data.slice(0, 7);
    if (mesAntes !== mes && c.recebimentos[mesAntes] && c.recebimentos[mesAntes].movId === m.id) delete c.recebimentos[mesAntes];
    c.recebimentos[mes] = { movId: m.id, valor: m.valor, data: m.data };
    o.mes = mes;
  } else if (o.tipo === "freela") {
    const f = state.freelas.find(x => x.id === o.ref);
    const p = f && f.parcelas.find(x => x.movId === m.id);
    if (p) p.pagoEm = m.data;
  } else if (o.tipo === "vale") {
    const emp = state.employees.find(x => x.id === o.ref);
    const d = emp && (emp.despesas || []).find(x => x.movId === m.id);
    if (d) { d.valor = m.valor; d.data = m.data; syncEmployeeBill(emp); }
  } else if (o.tipo === "conta") {
    const b = state.bills.find(x => x.id === o.ref);
    if (b && b.ultimoPagamento && b.ultimoPagamento.movId === m.id) {
      Object.assign(b.ultimoPagamento, { valor: m.valor, data: m.data, contaId: m.contaId });
      if (b.status === "pago") b.paidOn = m.data;
    }
  }
}
// Excluir lançamento desfaz a marcação de onde ele veio.
function deleteMov(m) {
  const o = m.origem || {};
  if (o.tipo === "cliente") {
    const c = state.clients.find(x => x.id === o.ref);
    if (c && c.recebimentos) Object.keys(c.recebimentos).forEach(k => { if (c.recebimentos[k].movId === m.id) delete c.recebimentos[k]; });
  } else if (o.tipo === "freela") {
    const f = state.freelas.find(x => x.id === o.ref);
    const p = f && f.parcelas.find(x => x.movId === m.id);
    if (p) { p.pago = false; delete p.pagoEm; delete p.movId; }
  } else if (o.tipo === "vale") {
    const emp = state.employees.find(x => x.id === o.ref);
    if (emp) { emp.despesas = (emp.despesas || []).filter(d => d.movId !== m.id); syncEmployeeBill(emp); }
  } else if (o.tipo === "conta") {
    const b = state.bills.find(x => x.id === o.ref);
    if (b && b.ultimoPagamento && b.ultimoPagamento.movId === m.id) { desfazerPagamento(b); return; }
  }
  removeMovById(m.id);
}
function openContaForm(c) {
  const isEdit = !!c;
  const tipo = isEdit ? c.tipo : "banco";
  document.getElementById("formModalTitle").textContent = isEdit ? "Editar " + c.nome : "Nova conta ou cartão";
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field full"><label>Nome</label><input type="text" id="ctNome" value="${isEdit ? escapeHtml(c.nome) : ""}" placeholder="Ex: Inter, Nubank, Cartão Inter"></div>
      <div class="modal-field"><label>Tipo</label><select id="ctTipo" ${isEdit ? "disabled" : ""}><option value="banco" ${tipo === "banco" ? "selected" : ""}>Conta bancária</option><option value="credito" ${tipo === "credito" ? "selected" : ""}>Cartão de crédito</option></select></div>
      <div class="modal-field" id="ctSaldoWrap"><label>Saldo inicial</label><input type="text" id="ctSaldo" value="${isEdit ? brl(c.saldoInicial || 0) : ""}" placeholder="R$ 0,00"></div>
      <div class="modal-field" id="ctLimiteWrap"><label>Limite</label><input type="text" id="ctLimite" value="${isEdit ? brl(c.limite || 0) : ""}" placeholder="R$ 0,00"></div>
      <div class="modal-field" id="ctVencWrap"><label>Dia de vencimento da fatura</label><input type="number" id="ctVenc" min="1" max="31" value="${isEdit ? (c.vencimento || "") : ""}"></div>
    </div>
    <div class="modal-note" id="ctNota"></div>`;
  const temMovs = isEdit && state.movs.some(m => m.contaId === c.id || m.pagaFatura === c.id);
  document.getElementById("formModalFoot").innerHTML = `
    ${isEdit && !temMovs && state.contas.length > 1 ? '<button class="btn btn-ghost" id="ctDelete" type="button" style="color:var(--negative);">Excluir</button>' : "<span></span>"}
    <div style="display:flex; gap:8px;"><button class="btn" id="ctCancel" type="button">Cancelar</button><button class="btn btn-accent" id="ctSave" type="button">Salvar</button></div>`;
  const $ = id => document.getElementById(id);
  const sync = () => {
    const cred = $("ctTipo").value === "credito";
    $("ctSaldoWrap").style.display = cred ? "none" : "";
    $("ctLimiteWrap").style.display = cred ? "" : "none";
    $("ctVencWrap").style.display = cred ? "" : "none";
    $("ctNota").textContent = cred
      ? "Compras no cartão entram na fatura (contam como gasto na data da compra). Quando pagar a fatura, use “Pagar fatura”: o dinheiro sai da conta bancária sem contar o gasto duas vezes."
      : "Saldo inicial = quanto tinha na conta antes do primeiro lançamento aqui. Depois disso o saldo é calculado sozinho pelas entradas e saídas.";
  };
  sync();
  $("ctTipo").addEventListener("change", sync);
  $("ctCancel").addEventListener("click", closeFormModal);
  if ($("ctDelete")) $("ctDelete").addEventListener("click", () => {
    if (!confirm(`Excluir ${c.nome}?`)) return;
    state.contas = state.contas.filter(x => x.id !== c.id);
    closeFormModal(); renderAll(); scheduleSave();
  });
  $("ctSave").addEventListener("click", () => {
    const nome = $("ctNome").value.trim();
    if (!nome) { $("ctNome").focus(); return; }
    const dados = { nome, tipo: $("ctTipo").value };
    if (dados.tipo === "banco") dados.saldoInicial = parseBRL($("ctSaldo").value);
    else { dados.limite = parseBRL($("ctLimite").value); dados.vencimento = parseInt($("ctVenc").value, 10) || null; }
    if (isEdit) Object.assign(c, dados); else state.contas.push(Object.assign({ id: "conta-" + uid() }, dados));
    closeFormModal(); renderAll(); scheduleSave();
  });
  document.getElementById("formModalOverlay").classList.add("open");
}
function openPagarFatura(cartao) {
  const aberto = Math.max(0, saldoConta(cartao));
  document.getElementById("formModalTitle").textContent = "Pagar fatura · " + cartao.nome;
  document.getElementById("formModalBody").innerHTML = `
    <div class="form-grid">
      <div class="modal-field"><label>Valor pago</label><input type="text" id="pfValor" value="${brl(aberto)}"></div>
      <div class="modal-field"><label>Data</label><input type="date" id="pfData" value="${TODAY_ISO}"></div>
      <div class="modal-field full"><label>Pago com a conta</label><select id="pfConta">${contaOptionsHTML((contaPadrao() || {}).id, true)}</select></div>
    </div>
    <div class="modal-note">Fatura em aberto: ${brl(aberto)}. Os gastos já foram contados quando cada compra foi lançada no cartão; aqui só sai o dinheiro da conta.</div>`;
  document.getElementById("formModalFoot").innerHTML = `<span></span><div style="display:flex; gap:8px;"><button class="btn" id="pfCancel" type="button">Cancelar</button><button class="btn btn-accent" id="pfSave" type="button">Pagar</button></div>`;
  document.getElementById("pfCancel").addEventListener("click", closeFormModal);
  document.getElementById("pfSave").addEventListener("click", () => {
    const valor = parseBRL(document.getElementById("pfValor").value);
    if (!valor) return;
    addMov({ tipo: "saida", valor, data: document.getElementById("pfData").value || TODAY_ISO, desc: "Pagamento da fatura · " + cartao.nome, contaId: document.getElementById("pfConta").value, cat: "Fatura do cartão", pagaFatura: cartao.id, origem: { tipo: "fatura", ref: cartao.id } });
    closeFormModal(); renderAll(); scheduleSave();
  });
  document.getElementById("formModalOverlay").classList.add("open");
}
function ajustarSaldo(c) {
  const atual = saldoConta(c);
  const val = prompt(`Quanto o app do ${c.nome} mostra de saldo agora? (R$)\nSaldo calculado aqui: ${brl(atual)}`, String(atual.toFixed(2)).replace(".", ","));
  if (val === null) return;
  const diff = Math.round((parseBRL(val) - atual) * 100) / 100;
  if (!diff) { alert("Bateu certinho, nada pra ajustar."); return; }
  addMov({ tipo: diff > 0 ? "entrada" : "saida", valor: Math.abs(diff), data: TODAY_ISO, desc: "Ajuste de saldo (conferência com o banco)", contaId: c.id, cat: "Ajuste de saldo", origem: { tipo: "ajuste" } });
  renderAll(); scheduleSave();
}

// ---------------- Dashboard ----------------
function renderChart() {
  const pr = projecaoMes(CUR_KEY);
  const receita = pr.clientes + pr.freelas + pr.outras;
  const custos = pr.custos;
  const max = Math.max(receita, custos, 1);
  document.getElementById("chart").innerHTML = `
    <div class="chart-col"><div class="chart-bars"><div class="bar in" style="height:${(receita / max * 118).toFixed(0)}px"></div></div><span>${brl(receita)}</span></div>
    <div class="chart-col"><div class="chart-bars"><div class="bar out" style="height:${(custos / max * 118).toFixed(0)}px"></div></div><span>${brl(custos)}</span></div>`;
}
function updateDashboardStats() {
  const pr = projecaoMes(CUR_KEY);
  const caixa = caixaAtual();
  const fatura = faturasAbertas();
  const recebidoMes = soma(state.movs.filter(m => m.tipo === "entrada" && (m.data || "").slice(0, 7) === CUR_KEY && movContaComoResultado(m)), m => m.valor)
    + soma(state.clients.filter(c => { const r = clienteRecebimento(c, CUR_KEY); return r && r.legado; }), c => clienteRecebimento(c, CUR_KEY).valor);
  const pagar = pr.pagarPend + fatura;
  const saldo = caixa + pr.receberPend - pagar;
  document.getElementById("statCaixa").textContent = (caixa < 0 ? "−" : "") + brl(Math.abs(caixa));
  document.getElementById("statCaixaSub").textContent = fatura ? `Fatura do cartão em aberto: ${brl(fatura)}` : "Saldo da conta Inter · clique pra ver o extrato";
  document.getElementById("statReceber").textContent = brl(pr.receberPend);
  document.getElementById("statPagar").textContent = brl(pagar);
  const saldoEl = document.getElementById("statSaldo");
  saldoEl.textContent = (saldo < 0 ? "−" : "") + brl(Math.abs(saldo));
  saldoEl.className = "stat-value num " + (saldo > 0 ? "pos" : saldo < 0 ? "neg" : "zero-c");
  const nCli = clientesPendentesNoMes(CUR_KEY).length;
  const nFreelas = new Set(freelaParcelasPendentes(CUR_KEY).map(x => x.f.id)).size;
  document.getElementById("statReceberSub").textContent = `Já recebido ${brl(recebidoMes)} · faltam ${nCli} cliente${nCli === 1 ? "" : "s"}` + (nFreelas ? ` e ${nFreelas} freela${nFreelas > 1 ? "s" : ""}` : "");
  const nContas = state.bills.filter(b => contaPendenteNoMes(b, CUR_KEY) > 0).length;
  document.getElementById("statPagarSub").textContent = `${nContas} conta${nContas === 1 ? "" : "s"} até o fim do mês` + (fatura ? " + fatura do cartão" : "");
}
function renderCostPie() {
  const sums = {}; let total = 0;
  state.bills.forEach(b => {
    const emp = empByBill(b);
    const v = emp ? empCusto(emp) : Number(b.value || 0);
    sums[b.tagId] = (sums[b.tagId] || 0) + v; total += v;
  });
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
// Projeção: mês atual = o que já entrou/saiu + o que falta; meses seguintes =
// clientes ativos que pagam naquele mês + parcelas de freela a receber − contas previstas.
function renderProjection() {
  let caixa = caixaAtual() - faturasAbertas();
  const rows = [0, 1, 2, 3].map(delta => {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() + delta, 1);
    const key = monthKeyOf(d.getFullYear(), d.getMonth());
    const pr = projecaoMes(key);
    caixa += pr.receberPend - pr.pagarPend;
    const cls = v => v > 0 ? "pos" : v < 0 ? "neg" : "zero-c";
    const fmt = v => (v < 0 ? "−" : "") + brl(Math.abs(v));
    return `<tr><td style="text-transform:capitalize;">${monthLabel(key)}${delta === 0 ? '<span class="freela-sub">realizado + previsto</span>' : ""}</td><td class="num">${brl(pr.clientes)}</td><td class="num">${brl(pr.freelas)}</td><td class="num">${brl(pr.outras)}</td><td class="num">${brl(pr.custos)}</td><td class="num ${cls(pr.lucro)}">${fmt(pr.lucro)}</td><td class="num ${cls(caixa)}">${fmt(caixa)}</td></tr>`;
  });
  document.getElementById("projBody").innerHTML = rows.join("");
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
    if (c.status === "novo") { items.push({ c: "var(--zero)", t: `${escapeHtml(c.nome)} está cadastrado mas ainda não gravou nada` }); return; }
    if (c.status !== "ativo") return;
    if (!clientePagaNoMes(c, CUR_KEY)) { items.push({ c: "var(--zero)", t: `${escapeHtml(c.nome)} entrou agora — 1º pagamento em ${fmtDateFull(c.primeiroVenc)}` }); return; }
    const sit = clienteSituacao(c);
    if (sit.st === "atrasado") items.push({ c: "var(--negative)", t: `${escapeHtml(c.nome)} não pagou — venceu ${fmtDate(sit.venc)} (${brl(c.valor)})` });
    else if (sit.st === "pendente") items.push({ c: "var(--accent)", t: `${escapeHtml(c.nome)} paga dia ${fmtDate(sit.venc)} — ${brl(c.valor)}` });
  });
  (state.freelas || []).forEach(f => (f.parcelas || []).forEach((p, i) => {
    if (p.pago || !p.venc) return;
    const label = f.parcelas.length > 1 ? ` (parcela ${i + 1}/${f.parcelas.length})` : "";
    if (p.venc < TODAY_ISO) items.push({ c: "var(--negative)", t: `Freela ${escapeHtml(f.titulo)}${label}: recebimento atrasado desde ${fmtDate(p.venc)} — ${brl(p.valor)}` });
  }));
  state.contas.filter(c => c.tipo === "credito").forEach(c => {
    const v = saldoConta(c);
    if (v > 0) items.push({ c: "var(--accent)", t: `Fatura do ${escapeHtml(c.nome)} em aberto: ${brl(v)}${c.vencimento ? " — vence dia " + c.vencimento : ""}` });
  });
  document.getElementById("alertList").innerHTML = items.length
    ? items.map(i => `<li><span class="alert-dot" style="background:${i.c}"></span>${i.t}</li>`).join("")
    : '<li style="color:var(--ink-faint);">Tudo em dia por aqui.</li>';
}
document.getElementById("tileCaixa").addEventListener("click", () => goToTab("caixa"));

// ---------------- master render ----------------
function renderAll() {
  renderBoard(); renderCalendar(); renderToolsTable(); renderInstallmentsTable(); renderEmployees();
  renderClients(); renderFreelas(); renderInvoices(); renderCaixa();
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

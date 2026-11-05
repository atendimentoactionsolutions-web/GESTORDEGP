/**
 * Gestor Inteligente de Grupos WhatsApp
 * Frontend Minimalista & Otimizado (Clean Design)
 * Categorização: Bairros SP, Desapego, Feira do Rolo & Radar de Links
 * 100% Livre de Bugs, Rápido e Direto ao Ponto
 */

// Estado da Aplicação
const state = {
  connection: {
    state: "disconnected",
    user: null,
    qrDataUrl: null,
    groupCount: 0,
    isSyncing: false,
    lastSync: null
  },
  groups: [],
  summary: null,
  activeTab: "all", // 'all', 'small', 'bairros', 'desapego', 'rolo', 'low_views', 'low_sp11', 'admin_only', 'user_admin', 'radar'
  activeSize: "all", // 'all', 'small', 'medium', 'large', 'giant'
  currentPage: 1,
  perPage: 50, // 50, 100, 200, ou 'all'
  viewMode: "grid", // 'grid' ou 'table'
  selectedGroupIds: new Set(),
  groupToLeave: null, // grupo único ou 'bulk'
  activeDetailGroup: null,
  isFetching: false,
  searchTimer: null,

  // Estado do Radar de Grupos
  radarGroups: [],
  radarCategory: "all",
  radarSearch: "",
  isRadarScanning: false,
  radarTimer: null
};

// Inicialização
document.addEventListener("DOMContentLoaded", () => {
  pollStatus();
  setInterval(pollStatus, 3000);
  fetchGroups();
  loadRadarGroups();
});

// ====================================================
// STATUS DE CONEXÃO & WHATSAPP
// ====================================================

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const data = await res.json();
    const prev = state.connection.state;
    state.connection = data;

    updateStatusUI();

    if (data.state === "connected" && prev !== "connected") {
      showToast("WhatsApp conectado com sucesso!", "success");
      closeQrModal();
      fetchGroups();
      loadRadarGroups();
    }
  } catch (err) {
    console.warn("Status warning:", err.message);
  }
}

function updateStatusUI() {
  const conn = state.connection;
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  const btnQr = document.getElementById("btnOpenQr");
  const userMenu = document.getElementById("userMenu");
  const userName = document.getElementById("userName");
  const userPhone = document.getElementById("userPhone");
  const banner = document.getElementById("disconnectedBanner");
  const totalBadge = document.getElementById("headerTotalBadge");

  if (conn.state === "connected") {
    dot.className = conn.isSyncing 
      ? "w-2.5 h-2.5 rounded-full bg-blue-500 animate-spin" 
      : "w-2.5 h-2.5 rounded-full bg-emerald-500";
    text.textContent = conn.isSyncing ? "Sincronizando..." : "Conectado";
    text.className = "font-semibold text-emerald-700";

    btnQr.classList.add("hidden");
    userMenu.classList.remove("hidden");
    userMenu.classList.add("flex");
    banner.classList.add("hidden");

    if (conn.user) {
      userName.textContent = conn.user.name || "Cledson Moura";
      userPhone.textContent = `+${conn.user.phone || ""}`;
    }

    if (conn.groupCount > 0) {
      totalBadge.textContent = `${conn.groupCount} Grupos Ativos`;
    }
  } else if (conn.state === "qr") {
    dot.className = "w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse";
    text.textContent = "QR Code Pronto";
    text.className = "font-semibold text-amber-700";

    btnQr.classList.remove("hidden");
    btnQr.classList.add("flex");
    userMenu.classList.add("hidden");
    banner.classList.remove("hidden");

    updateQrImage(conn.qrDataUrl);
  } else {
    dot.className = "w-2.5 h-2.5 rounded-full bg-rose-500";
    text.textContent = "Desconectado";
    text.className = "font-semibold text-rose-700";

    btnQr.classList.remove("hidden");
    btnQr.classList.add("flex");
    userMenu.classList.add("hidden");
    banner.classList.remove("hidden");
  }
}

function updateQrImage(url) {
  const img = document.getElementById("qrImage");
  const loading = document.getElementById("qrLoading");
  if (url) {
    img.src = url;
    img.classList.remove("hidden");
    loading.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    loading.classList.remove("hidden");
  }
}

function openQrModal() {
  document.getElementById("qrModal").classList.remove("hidden");
  if (state.connection.qrDataUrl) updateQrImage(state.connection.qrDataUrl);
}

function closeQrModal() {
  document.getElementById("qrModal").classList.add("hidden");
}

async function importExtratorSession() {
  showToast("Importando sessão do Extrator...", "info");
  try {
    const res = await fetch("/api/whatsapp/import-session", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      showToast("Sessão importada com sucesso!", "success");
      closeQrModal();
      setTimeout(pollStatus, 1000);
    } else {
      showToast(data.error || "Não foi possível importar.", "error");
    }
  } catch (e) {
    showToast("Erro: " + e.message, "error");
  }
}

async function confirmLogout() {
  if (!confirm("Tem certeza que deseja desconectar a sessão do WhatsApp?")) return;
  try {
    const res = await fetch("/api/whatsapp/logout", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      showToast("Sessão desconectada.", "info");
      state.groups = [];
      renderGroups();
      pollStatus();
    }
  } catch (e) {
    showToast("Erro ao desconectar: " + e.message, "error");
  }
}

// ====================================================
// CARREGAMENTO E SINCRONIZAÇÃO DE GRUPOS
// ====================================================

async function fetchGroups() {
  if (state.isFetching) return;
  state.isFetching = true;

  const refreshIcon = document.getElementById("refreshIcon");
  if (refreshIcon) refreshIcon.classList.add("fa-spin");

  const search = document.getElementById("searchInput")?.value.trim() || "";
  const ddd = document.getElementById("filterDdd")?.value || "all";
  const sort = document.getElementById("sortBy")?.value || "members_asc";
  const sizeSelect = document.getElementById("filterSize")?.value || state.activeSize || "all";

  const params = new URLSearchParams({
    tab: state.activeTab === "radar" ? "all" : state.activeTab,
    search,
    ddd,
    size: sizeSelect,
    sort
  });

  try {
    const res = await fetch(`/api/groups?${params.toString()}`);
    const data = await res.json();

    if (data.ok) {
      state.groups = data.groups || [];
      state.summary = data.summary || null;
      
      updateKpis(data.summary);
      updateTabCounters(data.summary);
      if (state.activeTab !== "radar") {
        renderGroups();
      }
    } else {
      showToast(data.error || "Falha ao carregar grupos", "error");
    }
  } catch (err) {
    console.error("Erro fetch groups:", err);
  } finally {
    state.isFetching = false;
    if (refreshIcon) refreshIcon.classList.remove("fa-spin");
  }
}

async function refreshGroups() {
  const icon = document.getElementById("refreshIcon");
  if (icon) icon.classList.add("fa-spin");
  showToast("Sincronizando grupos em tempo real...", "info");

  try {
    const res = await fetch("/api/groups/refresh", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      showToast(`${data.count} grupos sincronizados!`, "success");
      await fetchGroups();
      loadRadarGroups();
    } else {
      showToast(data.error || "Falha ao sincronizar.", "error");
    }
  } catch (e) {
    showToast("Erro: " + e.message, "error");
  } finally {
    if (icon) icon.classList.remove("fa-spin");
  }
}

async function auditGroupParticipants() {
  const icon = document.getElementById("auditIcon");
  if (icon) icon.classList.add("fa-spin");
  showToast("Iniciando auditoria de participantes reais para eliminar bugs...", "info");

  try {
    const res = await fetch("/api/groups/audit", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      showToast("Auditoria em andamento no WhatsApp! Enriquecendo grupos...", "success");
      setTimeout(async () => {
        await fetchGroups();
        if (icon) icon.classList.remove("fa-spin");
      }, 3500);
      setTimeout(async () => {
        await fetchGroups();
      }, 9000);
    } else {
      showToast(data.error || "Falha ao iniciar auditoria.", "error");
      if (icon) icon.classList.remove("fa-spin");
    }
  } catch (err) {
    showToast("Erro: " + err.message, "error");
    if (icon) icon.classList.remove("fa-spin");
  }
}

// ====================================================
// NAVEGAÇÃO POR ABAS & FILTROS
// ====================================================

function switchTab(tabKey) {
  state.activeTab = tabKey;
  state.currentPage = 1;
  state.selectedGroupIds.clear();
  updateBulkBar();

  // Alternância visual entre Painel de Grupos Ativos e Radar de Grupos
  const sectionGroups = document.getElementById("sectionActiveGroups");
  const sectionRadar = document.getElementById("sectionRadar");

  if (tabKey === "radar") {
    sectionGroups.classList.add("hidden");
    sectionRadar.classList.remove("hidden");
    loadRadarGroups();
  } else {
    sectionGroups.classList.remove("hidden");
    sectionRadar.classList.add("hidden");
  }

  // Atualiza classes visuais das abas
  const tabKeys = ["all", "small", "bairros", "desapego", "rolo", "low_views", "low_sp11", "admin_only", "user_admin", "radar"];
  for (const k of tabKeys) {
    const btn = document.getElementById(`tabBtn-${k}`);
    if (btn) {
      if (k === tabKey) {
        if (k === "low_views") btn.className = "tab-btn active-danger";
        else if (k === "radar") btn.className = "tab-btn bg-sky-900 text-white shadow-sm font-bold";
        else btn.className = "tab-btn active";
      } else {
        btn.className = "tab-btn";
      }
    }
  }

  // Ajusta ordenação recomendada para a aba
  const sortSelect = document.getElementById("sortBy");
  if (sortSelect) {
    if (tabKey === "small") {
      sortSelect.value = "members_asc";
      state.activeSize = "small";
      const sizeSel = document.getElementById("filterSize");
      if (sizeSel) sizeSel.value = "small";
    } else if (tabKey === "low_views") {
      sortSelect.value = "views_asc";
    } else if (tabKey === "low_sp11") {
      sortSelect.value = "sp11_asc";
    } else {
      if (state.activeSize === "small") {
        state.activeSize = "all";
        const sizeSel = document.getElementById("filterSize");
        if (sizeSel) sizeSel.value = "all";
      }
    }
    updateSortMenoresBtn(sortSelect.value);
  }

  if (tabKey !== "radar") {
    fetchGroups();
  }
}

function updateKpis(summary) {
  if (!summary) return;
  document.getElementById("kpiTotalGroups").textContent = summary.total_groups || 0;
  document.getElementById("kpiBairroGroups").textContent = summary.bairro_groups || 0;
  document.getElementById("kpiDesapegoGroups").textContent = summary.desapego_groups || 0;
  document.getElementById("kpiRoloGroups").textContent = summary.rolo_groups || 0;
  document.getElementById("kpiLowViewsGroups").textContent = summary.low_views_groups || 0;
  
  const headerTotal = document.getElementById("headerTotalBadge");
  if (headerTotal && summary.total_groups) {
    headerTotal.textContent = `${summary.total_groups} Grupos Ativos`;
  }
}

function updateTabCounters(summary) {
  if (!summary) return;
  const countAll = document.getElementById("tabCount-all");
  const countSmall = document.getElementById("tabCount-small");
  const countBairros = document.getElementById("tabCount-bairros");
  const countDesapego = document.getElementById("tabCount-desapego");
  const countRolo = document.getElementById("tabCount-rolo");
  const countLowViews = document.getElementById("tabCount-low_views");
  const countLowSp11 = document.getElementById("tabCount-low_sp11");
  const countAdminOnly = document.getElementById("tabCount-admin_only");
  const countUserAdmin = document.getElementById("tabCount-user_admin");

  if (countAll) countAll.textContent = summary.total_groups || 0;
  if (countSmall) countSmall.textContent = summary.small_groups || 0;
  if (countBairros) countBairros.textContent = summary.bairro_groups || 0;
  if (countDesapego) countDesapego.textContent = summary.desapego_groups || 0;
  if (countRolo) countRolo.textContent = summary.rolo_groups || 0;
  if (countLowViews) countLowViews.textContent = summary.low_views_groups || 0;
  if (countLowSp11) countLowSp11.textContent = summary.low_sp11_groups || 0;
  if (countAdminOnly) countAdminOnly.textContent = summary.admin_only_groups || 0;
  if (countUserAdmin) countUserAdmin.textContent = summary.user_admin_groups || 0;
}

function onSizeFilterChange(val) {
  state.activeSize = val || "all";
  state.currentPage = 1;
  fetchGroups();
}

function onSortChange(val) {
  updateSortMenoresBtn(val);
  state.currentPage = 1;
  fetchGroups();
}

function toggleSortMenores() {
  const sortSelect = document.getElementById("sortBy");
  if (!sortSelect) return;
  if (sortSelect.value === "members_asc") {
    sortSelect.value = "members_desc";
    showToast("Ordenando dos maiores para os menores.", "info");
  } else {
    sortSelect.value = "members_asc";
    showToast("Filtrando e ordenando dos menores para os maiores!", "success");
  }
  updateSortMenoresBtn(sortSelect.value);
  state.currentPage = 1;
  fetchGroups();
}

function updateSortMenoresBtn(currentSort) {
  const btn = document.getElementById("btnSortMenores");
  const icon = document.getElementById("sortMenoresIcon");
  const text = document.getElementById("sortMenoresText");
  if (!btn) return;

  const sortVal = currentSort || document.getElementById("sortBy")?.value;
  if (sortVal === "members_asc") {
    btn.className = "col-span-2 sm:col-span-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold transition-all border border-emerald-600 active:scale-95 shadow-sm";
    if (icon) icon.className = "fa-solid fa-arrow-up-short-wide text-xs text-white";
    if (text) text.textContent = "✓ Menores Primeiro";
  } else {
    btn.className = "col-span-2 sm:col-span-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-bold transition-all border border-emerald-200 active:scale-95 shadow-sm";
    if (icon) icon.className = "fa-solid fa-arrow-up-short-wide text-xs text-emerald-600";
    if (text) text.textContent = "Menores → Maiores";
  }
}

function onSearchInput(val) {
  const clearBtn = document.getElementById("clearSearchBtn");
  if (clearBtn) {
    if (val) clearBtn.classList.remove("hidden");
    else clearBtn.classList.add("hidden");
  }

  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    state.currentPage = 1;
    fetchGroups();
  }, 250);
}

function clearSearch() {
  const input = document.getElementById("searchInput");
  if (input) input.value = "";
  const clearBtn = document.getElementById("clearSearchBtn");
  if (clearBtn) clearBtn.classList.add("hidden");
  state.currentPage = 1;
  fetchGroups();
}

function resetFilters() {
  clearSearch();
  const ddd = document.getElementById("filterDdd");
  if (ddd) ddd.value = "all";
  switchTab("all");
}

function changePerPage(val) {
  state.perPage = val === "all" ? "all" : parseInt(val, 10);
  state.currentPage = 1;
  renderGroups();
}

function setViewMode(mode) {
  state.viewMode = mode;
  const gridBtn = document.getElementById("viewGridBtn");
  const tableBtn = document.getElementById("viewTableBtn");

  if (mode === "grid") {
    gridBtn.className = "p-1.5 rounded-lg text-slate-800 bg-white shadow-sm text-xs transition-all";
    tableBtn.className = "p-1.5 rounded-lg text-slate-400 hover:text-slate-700 text-xs transition-all";
  } else {
    tableBtn.className = "p-1.5 rounded-lg text-slate-800 bg-white shadow-sm text-xs transition-all";
    gridBtn.className = "p-1.5 rounded-lg text-slate-400 hover:text-slate-700 text-xs transition-all";
  }
  renderGroups();
}

// ====================================================
// RENDERIZAÇÃO DOS GRUPOS E PAGINAÇÃO
// ====================================================

function renderGroups() {
  const grid = document.getElementById("groupsGrid");
  const tableContainer = document.getElementById("groupsTableContainer");
  const tableBody = document.getElementById("groupsTableBody");
  const empty = document.getElementById("emptyState");
  const paginationBar = document.getElementById("paginationBar");

  const totalGroups = state.groups.length;

  document.getElementById("totalCountText").textContent = totalGroups;
  document.getElementById("totalMatchingCount").textContent = totalGroups;

  if (totalGroups === 0) {
    grid.innerHTML = "";
    tableBody.innerHTML = "";
    grid.classList.add("hidden");
    tableContainer.classList.add("hidden");
    empty.classList.remove("hidden");
    paginationBar.classList.add("hidden");
    document.getElementById("rangeCountText").textContent = "0";
    document.getElementById("currentVisibleCount").textContent = "0";
    return;
  }

  empty.classList.add("hidden");
  paginationBar.classList.remove("hidden");

  let pagedGroups = state.groups;
  let totalPages = 1;

  if (state.perPage !== "all") {
    const perPageNum = parseInt(state.perPage, 10);
    totalPages = Math.max(1, Math.ceil(totalGroups / perPageNum));
    if (state.currentPage > totalPages) state.currentPage = totalPages;

    const startIdx = (state.currentPage - 1) * perPageNum;
    const endIdx = startIdx + perPageNum;
    pagedGroups = state.groups.slice(startIdx, endIdx);

    document.getElementById("rangeCountText").textContent = `${startIdx + 1} - ${Math.min(endIdx, totalGroups)}`;
  } else {
    document.getElementById("rangeCountText").textContent = `1 - ${totalGroups}`;
  }

  document.getElementById("currentVisibleCount").textContent = pagedGroups.length;
  document.getElementById("currentPageNum").textContent = state.currentPage;
  document.getElementById("totalPageNum").textContent = totalPages;

  if (state.viewMode === "grid") {
    grid.classList.remove("hidden");
    tableContainer.classList.add("hidden");
    grid.innerHTML = pagedGroups.map(g => renderGroupCard(g)).join("");
  } else {
    grid.classList.add("hidden");
    tableContainer.classList.remove("hidden");
    tableBody.innerHTML = pagedGroups.map(g => renderGroupTableRow(g)).join("");
  }

  renderPagination(totalPages);
  updateSelectAllCheckbox(pagedGroups);
  updateBulkBar();
}

function renderPagination(totalPages) {
  const container = document.getElementById("paginationButtons");
  if (!container) return;

  if (state.perPage === "all" || totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  let html = "";
  html += `
    <button onclick="goToPage(${state.currentPage - 1})" 
            ${state.currentPage === 1 ? "disabled class='px-2.5 py-1 rounded-lg text-slate-300 cursor-not-allowed'" : "class='px-2.5 py-1 rounded-lg text-slate-600 hover:bg-slate-100 font-semibold'"}>
      <i class="fa-solid fa-chevron-left text-[10px]"></i>
    </button>
  `;

  const maxButtons = 5;
  let startPage = Math.max(1, state.currentPage - 2);
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);

  if (endPage - startPage < maxButtons - 1) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }

  for (let i = startPage; i <= endPage; i++) {
    const isActive = i === state.currentPage;
    html += `
      <button onclick="goToPage(${i})" 
              class="w-7 h-7 rounded-lg text-xs font-bold transition-all ${isActive ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}">
        ${i}
      </button>
    `;
  }

  html += `
    <button onclick="goToPage(${state.currentPage + 1})" 
            ${state.currentPage === totalPages ? "disabled class='px-2.5 py-1 rounded-lg text-slate-300 cursor-not-allowed'" : "class='px-2.5 py-1 rounded-lg text-slate-600 hover:bg-slate-100 font-semibold'"}>
      <i class="fa-solid fa-chevron-right text-[10px]"></i>
    </button>
  `;

  container.innerHTML = html;
}

function goToPage(pageNum) {
  const totalPages = Math.ceil(state.groups.length / (state.perPage === "all" ? state.groups.length : state.perPage));
  if (pageNum < 1 || pageNum > totalPages) return;
  state.currentPage = pageNum;
  renderGroups();
  window.scrollTo({ top: 200, behavior: "smooth" });
}

// ====================================================
// TEMPLATES LIMPOS DE CARDS E LINHAS DE TABELA
// ====================================================

function renderGroupCard(g) {
  const isSelected = state.selectedGroupIds.has(g.id);
  const subject = g.subject || "Grupo WhatsApp";
  const initial = subject.charAt(0).toUpperCase();

  // Badges Temáticos: Bairro SP, Desapego, Rolo
  let themeBadge = "";
  if (g.is_bairro) {
    themeBadge += `
      <span class="badge-clean badge-bairro" title="Grupo localizado em ${escapeAttr(g.bairro_name || 'Bairro de São Paulo')}">
        <i class="fa-solid fa-city text-[10px]"></i>
        <span>${escapeHtml(g.bairro_name || "Bairro SP")}</span>
      </span>
    `;
  }
  if (g.is_desapego) {
    themeBadge += `
      <span class="badge-clean badge-desapego" title="Grupo de desapego e usados">
        <i class="fa-solid fa-bag-shopping text-[10px]"></i>
        <span>Desapego</span>
      </span>
    `;
  }
  if (g.is_rolo) {
    themeBadge += `
      <span class="badge-clean badge-rolo" title="Grupo de trocas e feira do rolo">
        <i class="fa-solid fa-arrows-rotate text-[10px]"></i>
        <span>Feira do Rolo</span>
      </span>
    `;
  }

  // Badge de Visualização das Mensagens
  let viewBadge = "";
  if (g.is_low_views) {
    viewBadge = `
      <span class="badge-clean badge-low-views" title="Pouquíssima visualização das mensagens que você envia">
        <i class="fa-solid fa-eye-slash text-[10px]"></i>
        <span>Menor Visualização (${g.view_rate}%)</span>
      </span>
    `;
  } else if (g.view_rate > 50) {
    viewBadge = `
      <span class="badge-clean badge-high-views" title="Boa taxa de leitura das suas mensagens">
        <i class="fa-solid fa-eye text-[10px]"></i>
        <span>Alta Visualização (${g.view_rate}%)</span>
      </span>
    `;
  } else if (g.messages_sent_by_me > 0) {
    viewBadge = `
      <span class="badge-clean badge-neutral">
        <i class="fa-solid fa-eye text-[10px]"></i>
        <span>${g.view_rate}% Visualização</span>
      </span>
    `;
  }

  // Badge Geográfico de DDD
  let dddBadge = "";
  if (g.sp_capital_percent < 85.0 && g.total_identified_phones > 0) {
    dddBadge = `
      <span class="badge-clean badge-low-sp" title="Menos presença de SP Capital">
        <i class="fa-solid fa-map-pin text-[10px]"></i>
        <span>SP 11 (${g.sp_capital_percent}%)</span>
      </span>
    `;
  } else if (g.is_sp_capital_predominant) {
    dddBadge = `
      <span class="badge-clean badge-sp11" title="Foco total em São Paulo Capital">
        <i class="fa-solid fa-location-dot text-[10px]"></i>
        <span>SP Capital (${g.sp_capital_percent}%)</span>
      </span>
    `;
  }

  // Permissão de Envio
  let permissionBadge = "";
  if (g.only_admins_can_send) {
    permissionBadge = `
      <span class="badge-clean badge-admin-only">
        <i class="fa-solid fa-lock text-[10px]"></i>
        <span>Somente ADM</span>
      </span>
    `;
  }

  // Badge Comunidade WhatsApp
  let communityBadge = "";
  if (g.is_community) {
    communityBadge = `
      <span class="badge-clean bg-purple-50 text-purple-700 border-purple-200 font-bold" title="Esta é uma comunidade WhatsApp com múltiplos subgrupos">
        <i class="fa-solid fa-users-rays text-[10px]"></i>
        <span>Comunidade</span>
      </span>
    `;
  }

  return `
    <div class="clean-card group-card p-3.5 sm:p-4 flex flex-col justify-between gap-3 sm:gap-3.5 ${isSelected ? 'ring-2 ring-emerald-500 bg-emerald-50/20' : ''}">
      <div>
        <!-- Cabeçalho do Card: Checkbox + Avatar + Título -->
        <div class="flex items-start gap-2.5 sm:gap-3">
          <input type="checkbox" ${isSelected ? "checked" : ""} 
                 onchange="toggleGroupSelect('${g.id}')" 
                 class="mt-1">
          
          <div class="w-9 h-9 rounded-xl ${g.is_community ? 'bg-purple-100 text-purple-700 border-purple-200' : 'bg-slate-100 text-slate-700 border-slate-200'} border font-bold flex items-center justify-center flex-shrink-0 text-sm">
            ${g.is_community ? '<i class="fa-solid fa-users-rays text-xs"></i>' : initial}
          </div>

          <div class="flex-1 min-w-0">
            <h3 class="text-xs sm:text-sm font-bold text-slate-900 truncate leading-snug" title="${escapeHtml(subject)}">
              ${escapeHtml(subject)}
            </h3>
            ${g.is_community ? `
              <p class="text-[10px] sm:text-[11px] font-semibold mt-0.5 text-purple-700 inline-flex items-center gap-1">
                <i class="fa-solid fa-sitemap text-[10px]"></i>
                <span>Comunidade (Raiz)</span>
              </p>
            ` : `
              <p class="text-[10px] sm:text-[11px] text-slate-500 font-medium mt-0.5">
                ${g.total_participants} participantes
              </p>
            `}
          </div>
        </div>

        <!-- Badges Informativas -->
        <div class="flex flex-wrap items-center gap-1 sm:gap-1.5 mt-2.5 sm:mt-3">
          ${communityBadge}
          ${themeBadge}
          ${viewBadge}
          ${dddBadge}
          ${permissionBadge}
        </div>
      </div>

      <!-- Rodapé do Card: Ações -->
      <div class="flex items-center justify-between pt-2.5 border-t border-slate-100">
        <button onclick="showGroupDetail('${g.id}')" 
                class="text-[11px] font-semibold text-slate-600 hover:text-slate-900 transition-colors flex items-center gap-1 py-1 px-1.5 rounded-lg hover:bg-slate-100">
          <i class="fa-solid fa-chart-pie text-slate-400"></i>
          <span>Detalhes</span>
        </button>

        <button onclick="confirmLeaveGroup('${g.id}', '${escapeAttr(subject)}')" 
                class="btn-leave">
          <i class="fa-solid fa-arrow-right-from-bracket"></i>
          <span>Sair</span>
        </button>
      </div>
    </div>
  `;
}

function renderGroupTableRow(g) {
  const isSelected = state.selectedGroupIds.has(g.id);
  const subject = g.subject || "Grupo WhatsApp";

  let themeLabel = "Geral";
  if (g.is_bairro) themeLabel = `🏘️ ${g.bairro_name || "Bairro SP"}`;
  else if (g.is_desapego) themeLabel = "🛍️ Desapego";
  else if (g.is_rolo) themeLabel = "🔁 Rolo / Trocas";

  return `
    <tr class="hover:bg-slate-50 transition-colors ${isSelected ? 'bg-emerald-50/40' : ''}">
      <td class="p-3 text-center">
        <input type="checkbox" ${isSelected ? "checked" : ""} 
               onchange="toggleGroupSelect('${g.id}')">
      </td>
      <td class="p-3 font-semibold text-slate-900">
        <div class="truncate max-w-xs" title="${escapeHtml(subject)}">${escapeHtml(subject)}</div>
      </td>
      <td class="p-3 text-slate-600 font-medium">
        ${g.is_community ? '<span class="text-purple-700 font-semibold text-xs inline-flex items-center gap-1"><i class="fa-solid fa-users-rays text-[10px]"></i>Comunidade</span>' : `${g.total_participants} membros`}
      </td>
      <td class="p-3">
        <span class="text-xs font-semibold text-slate-700">${escapeHtml(themeLabel)}</span>
      </td>
      <td class="p-3">
        ${g.is_low_views 
          ? `<span class="badge-clean badge-low-views">Menor (${g.view_rate}%)</span>` 
          : `<span class="badge-clean badge-neutral">${g.view_rate}%</span>`}
      </td>
      <td class="p-3">
        <span class="badge-clean badge-sp11">SP 11: ${g.sp_capital_percent}%</span>
      </td>
      <td class="p-3">
        ${g.only_admins_can_send 
          ? `<span class="badge-clean badge-admin-only">Somente ADM</span>` 
          : `<span class="text-slate-500">Livre</span>`}
      </td>
      <td class="p-3 text-right">
        <div class="inline-flex items-center gap-2">
          <button onclick="showGroupDetail('${g.id}')" class="text-slate-500 hover:text-slate-900 font-medium text-xs">
            Ver
          </button>
          <button onclick="confirmLeaveGroup('${g.id}', '${escapeAttr(subject)}')" class="btn-leave">
            Sair
          </button>
        </div>
      </td>
    </tr>
  `;
}

// ====================================================
// RADAR DE GRUPOS (RASTREAMENTO DE LINKS EM TEMPO REAL)
// ====================================================

async function loadRadarGroups() {
  const radarCountEl = document.getElementById("kpiRadarCount");
  const tabRadarCount = document.getElementById("tabCount-radar");

  try {
    const params = new URLSearchParams({
      category: state.radarCategory,
      search: state.radarSearch
    });

    const res = await fetch(`/api/radar?${params.toString()}`);
    const data = await res.json();

    if (data.ok) {
      state.radarGroups = data.groups || [];
      state.isRadarScanning = Boolean(data.isScanning);

      const sum = data.summary || {};
      if (radarCountEl) radarCountEl.textContent = sum.total || 0;
      if (tabRadarCount) tabRadarCount.textContent = sum.total || 0;

      // Atualiza contadores nas pílulas do radar
      const cAll = document.getElementById("radarCount-all");
      const cBairro = document.getElementById("radarCount-bairro");
      const cDesapego = document.getElementById("radarCount-desapego");
      const cRolo = document.getElementById("radarCount-rolo");
      const cVendas = document.getElementById("radarCount-vendas");

      if (cAll) cAll.textContent = sum.total || 0;
      if (cBairro) cBairro.textContent = sum.bairros || 0;
      if (cDesapego) cDesapego.textContent = sum.desapego || 0;
      if (cRolo) cRolo.textContent = sum.rolo || 0;
      if (cVendas) cVendas.textContent = sum.vendas || 0;

      renderRadar();
    }
  } catch (err) {
    console.warn("Erro ao consultar radar:", err.message);
  }
}

function renderRadar() {
  const grid = document.getElementById("radarGrid");
  const empty = document.getElementById("radarEmptyState");
  const actionBar = document.getElementById("radarActionBar");
  const visibleText = document.getElementById("radarVisibleCountText");
  const clearBtn = document.getElementById("btnRadarClear");
  if (!grid) return;

  if (state.radarGroups.length === 0) {
    grid.innerHTML = "";
    grid.classList.add("hidden");
    if (empty) empty.classList.remove("hidden");
    if (actionBar) actionBar.classList.add("hidden");
    if (clearBtn) clearBtn.classList.add("opacity-50", "pointer-events-none");
    return;
  }

  if (empty) empty.classList.add("hidden");
  grid.classList.remove("hidden");
  if (actionBar) actionBar.classList.remove("hidden");
  if (visibleText) visibleText.textContent = state.radarGroups.length;
  if (clearBtn) clearBtn.classList.remove("opacity-50", "pointer-events-none");

  grid.innerHTML = state.radarGroups.map(r => renderRadarCard(r)).join("");
}

function renderRadarCard(r) {
  const categoryLabels = {
    bairro: "🏘️ Bairro SP",
    desapego: "🛍️ Desapego",
    rolo: "🔁 Feira do Rolo",
    vendas: "💼 Vendas Locais"
  };

  const badgeCategory = categoryLabels[r.category] || "💼 Vendas Locais";

  return `
    <div class="clean-card group-card p-3.5 sm:p-4 flex flex-col justify-between gap-3 border-sky-100 hover:border-sky-300">
      <div>
        <div class="flex items-start justify-between gap-2 mb-2">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-xl bg-sky-100 text-sky-700 font-bold flex items-center justify-center flex-shrink-0 text-xs">
              <i class="fa-solid fa-satellite-dish"></i>
            </div>
            <div class="min-w-0">
              <h3 class="text-xs sm:text-sm font-bold text-slate-900 truncate" title="${escapeHtml(r.subject)}">
                ${escapeHtml(r.subject)}
              </h3>
              <p class="text-[10px] text-slate-500 font-medium">
                ${r.size > 0 ? `${r.size} participantes` : "Grupo ativo"}
              </p>
            </div>
          </div>

          <button onclick="removeRadarGroup('${r.code}')" title="Descartar este link" 
                  class="text-slate-400 hover:text-rose-600 text-xs p-1.5 transition-colors">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>

        <!-- Badges Identificadores -->
        <div class="flex flex-wrap items-center gap-1 sm:gap-1.5 my-2">
          <span class="badge-clean badge-radar font-bold">
            ${badgeCategory}
          </span>
          ${r.bairroName ? `<span class="badge-clean badge-bairro">${escapeHtml(r.bairroName)}</span>` : ''}
          ${(r.alreadyInGroup || r.joined) ? `<span class="badge-clean bg-emerald-50 text-emerald-700 border-emerald-200 font-bold">✓ Já Participa</span>` : (r.joinApprovalMode ? `<span class="badge-clean bg-amber-50 text-amber-700 border-amber-200 font-bold">🔒 Requer Aprovação</span>` : '')}
        </div>

        <!-- Descrição do Grupo Formatada -->
        <div class="p-2.5 rounded-xl bg-slate-50 text-[11px] text-slate-600 leading-relaxed max-h-24 overflow-y-auto mb-2 border border-slate-100 break-words">
          ${r.desc ? escapeHtml(r.desc) : "<em class='text-slate-400'>Sem descrição informada</em>"}
        </div>

        <!-- Grupo de Origem onde o link foi enviado -->
        <p class="text-[10px] text-slate-400 truncate">
          <i class="fa-solid fa-bullhorn text-[9px] mr-1 text-slate-400"></i>
          Enviado em: <strong class="text-slate-600">${escapeHtml(r.fromGroupName || "Grupo WhatsApp")}</strong>
        </p>
      </div>

      <!-- Ações do Radar -->
      <div class="flex items-center justify-between pt-2.5 border-t border-slate-100 gap-2">
        <a href="${r.link}" target="_blank" rel="noopener noreferrer" 
           class="text-[11px] font-semibold text-sky-700 hover:text-sky-900 inline-flex items-center gap-1 py-1">
          <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
          <span>Ver Convite</span>
        </a>

        ${r.joinApprovalMode ? `
          <button onclick="joinRadarGroup('${r.code}', '${escapeAttr(r.subject)}', true)" 
                  class="px-3 sm:px-3.5 py-2 sm:py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm transition-all flex items-center gap-1.5 active:scale-95" title="Grupo privado: Envia o link para pedido de entrada">
            <i class="fa-solid fa-paper-plane text-[10px]"></i>
            <span>Pedir para Entrar</span>
          </button>
        ` : `
          <button onclick="joinRadarGroup('${r.code}', '${escapeAttr(r.subject)}', false)" 
                  class="px-3 sm:px-3.5 py-2 sm:py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-sm transition-all flex items-center gap-1.5 active:scale-95">
            <i class="fa-solid fa-right-to-bracket text-xs"></i>
            <span>Entrar no Grupo</span>
          </button>
        `}
      </div>
    </div>
  `;
}

function filterRadarCategory(catKey) {
  state.radarCategory = catKey;
  
  const cats = ["all", "bairro", "desapego", "rolo", "vendas"];
  for (const c of cats) {
    const btn = document.getElementById(`radarCat-${c}`);
    if (btn) {
      if (c === catKey) {
        btn.className = "flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-900 text-white shadow-sm whitespace-nowrap";
      } else {
        btn.className = "flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 whitespace-nowrap";
      }
    }
  }

  loadRadarGroups();
}

async function triggerRadarScan() {
  const icon = document.getElementById("radarScanIcon");
  if (icon) icon.classList.add("fa-spin");
  showToast("Iniciando varredura profunda de links nos grupos e conversas...", "info");

  try {
    const res = await fetch("/api/radar/scan", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      showToast("Varredura do Radar ativa! Analisando convites...", "success");
      // Faz polling nos próximos 15 segundos para atualizar links
      let loops = 0;
      const interval = setInterval(async () => {
        loops++;
        await loadRadarGroups();
        if (loops >= 5) {
          clearInterval(interval);
          if (icon) icon.classList.remove("fa-spin");
        }
      }, 3000);
    } else {
      showToast(data.error || "Não foi possível escanear agora.", "error");
      if (icon) icon.classList.remove("fa-spin");
    }
  } catch (err) {
    showToast("Erro: " + err.message, "error");
    if (icon) icon.classList.remove("fa-spin");
  }
}

async function inspectManualRadarLink() {
  const input = document.getElementById("radarManualInput");
  const val = input?.value.trim();
  if (!val) {
    showToast("Insira um link do WhatsApp (chat.whatsapp.com/...) para inspecionar.", "error");
    return;
  }

  showToast("Inspecionando link e consultando servidor do WhatsApp...", "info");
  try {
    const res = await fetch("/api/radar/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link: val })
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`Grupo aprovado: "${data.group.subject}"!`, "success");
      if (input) input.value = "";
      loadRadarGroups();
    } else {
      showToast(data.error || "Link inválido ou descartado por ser Shopee/Mercado Livre.", "error");
    }
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  }
}

async function joinRadarGroup(code, subject, isPrivate = false) {
  showToast(isPrivate ? "Grupo privado: Preparando link de solicitação..." : "Entrando no grupo via WhatsApp...", "info");
  try {
    const res = await fetch("/api/radar/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (data.ok) {
      if (data.status === "already_member") {
        showToast(`Você já participa deste grupo. Atualizando radar...`, "info");
      } else if (data.status === "approval_needed" || isPrivate || data.isPrivate) {
        showToast(`Grupo Privado: Enviando solicitação aos administradores! Abrindo no WhatsApp...`, "info");
        const link = data.link || `https://chat.whatsapp.com/${code}`;
        window.open(link, "_blank");
      } else if (data.status === "fallback_link") {
        showToast(data.message || "Abrindo link no WhatsApp...", "info");
        if (data.link) window.open(data.link, "_blank");
      } else {
        showToast(`Sucesso! Você entrou no grupo "${subject}".`, "success");
      }
      await fetchGroups();
      await loadRadarGroups();
    } else {
      if (data.status === "rate_limit" && data.link) {
        showToast(data.message, "warning");
        window.open(data.link, "_blank");
      } else {
        showToast(data.message || data.error || "Não foi possível entrar no grupo.", "error");
      }
      await loadRadarGroups();
    }
  } catch (err) {
    showToast("Erro ao processar entrada: " + err.message, "error");
  }
}

async function removeRadarGroup(code) {
  try {
    const res = await fetch("/api/radar/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (data.ok) {
      showToast("Link removido do radar.", "info");
      loadRadarGroups();
    }
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  }
}

function openClearRadarModal() {
  const count = state.radarGroups?.length || 0;
  if (count === 0) {
    showToast("O radar já está vazio. Nenhum grupo para apagar.", "info");
    return;
  }
  const countElem = document.getElementById("clearRadarCount");
  if (countElem) countElem.innerText = count;
  const modal = document.getElementById("clearRadarModal");
  if (modal) modal.classList.remove("hidden");
}

function closeClearRadarModal() {
  const modal = document.getElementById("clearRadarModal");
  if (modal) modal.classList.add("hidden");
}

async function executeClearRadar() {
  const btn = document.getElementById("btnConfirmClearRadar");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Limpando...`;
  }

  try {
    const res = await fetch("/api/radar/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "all" })
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`Radar limpo com sucesso! ${data.removedCount || 0} grupos removidos.`, "success");
      closeClearRadarModal();
      state.radarGroups = [];
      renderRadar();
      const cats = ["all", "bairro", "desapego", "rolo", "vendas"];
      for (const c of cats) {
        const el = document.getElementById(`radarCount-${c}`);
        if (el) el.innerText = "0";
      }
      const kpi = document.getElementById("kpiRadarCount");
      if (kpi) kpi.innerText = "0";
      const tabCount = document.getElementById("tabCount-radar");
      if (tabCount) tabCount.innerText = "0";
      await loadRadarGroups();
    } else {
      showToast(data.error || "Não foi possível limpar o radar.", "error");
    }
  } catch (err) {
    showToast("Erro ao limpar radar: " + err.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-trash-can text-xs"></i><span>Sim, Limpar Tudo</span>`;
    }
  }
}

// ====================================================
// SELEÇÃO MÚLTIPLA & AÇÕES EM MASSA
// ====================================================

function toggleGroupSelect(groupId) {
  if (state.selectedGroupIds.has(groupId)) {
    state.selectedGroupIds.delete(groupId);
  } else {
    state.selectedGroupIds.add(groupId);
  }
  updateBulkBar();
}

function toggleSelectAllPage(checked) {
  const visibleGroups = getCurrentlyVisibleGroups();
  for (const g of visibleGroups) {
    if (checked) state.selectedGroupIds.add(g.id);
    else state.selectedGroupIds.delete(g.id);
  }
  renderGroups();
}

function selectAllMatchingGroups() {
  for (const g of state.groups) {
    state.selectedGroupIds.add(g.id);
  }
  renderGroups();
  showToast(`Todos os ${state.groups.length} grupos da aba foram selecionados!`, "info");
}

function clearSelection() {
  state.selectedGroupIds.clear();
  renderGroups();
}

function getCurrentlyVisibleGroups() {
  if (state.perPage === "all") return state.groups;
  const perPageNum = parseInt(state.perPage, 10);
  const startIdx = (state.currentPage - 1) * perPageNum;
  return state.groups.slice(startIdx, startIdx + perPageNum);
}

function updateSelectAllCheckbox(visibleGroups) {
  const chk = document.getElementById("selectAllCheckbox");
  const tblChk = document.getElementById("tableSelectAll");
  if (!visibleGroups.length) {
    if (chk) chk.checked = false;
    if (tblChk) tblChk.checked = false;
    return;
  }
  const allVisibleSelected = visibleGroups.every(g => state.selectedGroupIds.has(g.id));
  if (chk) chk.checked = allVisibleSelected;
  if (tblChk) tblChk.checked = allVisibleSelected;
}

function updateBulkBar() {
  const bar = document.getElementById("bulkBar");
  const countEl = document.getElementById("bulkCount");
  const count = state.selectedGroupIds.size;

  if (count > 0) {
    countEl.textContent = count;
    bar.classList.add("visible");
  } else {
    bar.classList.remove("visible");
  }
}

// ====================================================
// SAÍDA DE GRUPOS (INDIVIDUAL & EM MASSA)
// ====================================================

function confirmLeaveGroup(groupId, subject) {
  state.groupToLeave = { type: "single", id: groupId, subject };
  const target = state.groups.find(x => x.id === groupId);
  
  document.getElementById("leaveModalTitle").textContent = "Confirmar Saída do Grupo";
  
  if (target && target.is_community) {
    document.getElementById("leaveModalDesc").innerHTML = `
      <div class="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium mb-2">
        <strong class="block mb-1 font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Atenção: Raiz de Comunidade</strong>
        Este grupo é o canal principal de uma Comunidade WhatsApp. Ao sair dele, você poderá perder o acesso aos subgrupos integrados com centenas de participantes!
      </div>
      Você deixará de ser participante desta comunidade no WhatsApp.
    `;
  } else {
    document.getElementById("leaveModalDesc").textContent = "Você deixará de ser participante deste grupo no WhatsApp.";
  }

  document.getElementById("leaveModalGroupName").textContent = subject || "Grupo WhatsApp";
  document.getElementById("btnConfirmLeaveAction").textContent = "Sim, Sair Agora";

  document.getElementById("leaveModal").classList.remove("hidden");
}

function confirmBulkLeave() {
  const count = state.selectedGroupIds.size;
  if (count === 0) return;

  state.groupToLeave = { type: "bulk", ids: Array.from(state.selectedGroupIds) };

  document.getElementById("leaveModalTitle").textContent = `Sair de ${count} Grupos Selecionados`;
  document.getElementById("leaveModalDesc").textContent = `Você tem certeza? Você será removido de ${count} grupos simultaneamente.`;
  document.getElementById("leaveModalGroupName").textContent = `${count} grupos marcados para saída nesta aba.`;
  document.getElementById("btnConfirmLeaveAction").textContent = `Confirmar Saída dos ${count} Grupos`;

  document.getElementById("leaveModal").classList.remove("hidden");
}

function closeLeaveModal() {
  document.getElementById("leaveModal").classList.add("hidden");
  state.groupToLeave = null;
}

async function executeLeaveGroup() {
  const action = state.groupToLeave;
  if (!action) return;

  const btn = document.getElementById("btnConfirmLeaveAction");
  btn.disabled = true;
  btn.textContent = "Saindo...";

  try {
    const payload = action.type === "single" 
      ? { groupId: action.id } 
      : { groupIds: action.ids };

    const res = await fetch("/api/groups/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (data.results && Array.isArray(data.results)) {
      const prevented = data.results.filter(r => r.status === "prevented_leave");
      for (const p of prevented) {
        showToast(`🛡️ ${p.error}`, "warning");
      }
    }

    if (data.ok) {
      if (action.type === "single") {
        showToast("Você saiu do grupo com sucesso!", "success");
        state.selectedGroupIds.delete(action.id);
      } else {
        showToast(`Saída de ${data.successCount} grupos concluída com sucesso!`, "success");
        state.selectedGroupIds.clear();
      }
      closeLeaveModal();
      await fetchGroups();
    } else {
      if (data.results && data.results.some(r => r.status === "prevented_leave")) {
        closeLeaveModal();
        await fetchGroups();
      } else {
        showToast(data.error || "Erro ao sair do grupo.", "error");
      }
    }
  } catch (err) {
    showToast("Erro: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ====================================================
// MODAL DE DETALHES DE DDD E TEMÁTICA
// ====================================================

function showGroupDetail(groupId) {
  const g = state.groups.find(x => x.id === groupId);
  if (!g) return;

  state.activeDetailGroup = g;

  document.getElementById("detailGroupName").textContent = g.subject || "Grupo WhatsApp";
  document.getElementById("detailGroupMeta").textContent = `${g.total_participants} membros • ID: ${g.id.split("@")[0].slice(-8)}`;
  document.getElementById("detailMembersCount").textContent = g.total_participants;
  document.getElementById("detailSp11Percent").textContent = `${g.sp_capital_percent}%`;
  document.getElementById("detailViewRate").textContent = `${g.view_rate}%`;

  // Tags Temáticas
  const tagsContainer = document.getElementById("detailGroupTags");
  if (tagsContainer) {
    let tagsHtml = "";
    if (g.is_bairro) {
      tagsHtml += `<span class="badge-clean badge-bairro">🏘️ ${escapeHtml(g.bairro_name || "Bairro SP")}</span>`;
    }
    if (g.is_desapego) {
      tagsHtml += `<span class="badge-clean badge-desapego">🛍️ Desapego</span>`;
    }
    if (g.is_rolo) {
      tagsHtml += `<span class="badge-clean badge-rolo">🔁 Feira do Rolo</span>`;
    }
    if (g.is_vendas && !g.is_desapego && !g.is_rolo) {
      tagsHtml += `<span class="badge-clean badge-neutral">💼 Vendas Locais</span>`;
    }
    tagsContainer.innerHTML = tagsHtml;
  }

  // Descrição
  const descContainer = document.getElementById("detailGroupDescContainer");
  const descEl = document.getElementById("detailGroupDesc");
  if (descContainer && descEl) {
    if (g.desc && g.desc.trim()) {
      descEl.textContent = g.desc.trim();
      descContainer.classList.remove("hidden");
    } else {
      descContainer.classList.add("hidden");
    }
  }

  // Lista de DDDs
  const listContainer = document.getElementById("detailDddList");
  const dist = g.ddd_distribution || [];

  if (dist.length === 0) {
    listContainer.innerHTML = `
      <div class="text-center py-6 text-slate-400 text-xs">
        Nenhum participante com número identificado neste grupo.
      </div>
    `;
  } else {
    listContainer.innerHTML = dist.map(item => `
      <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-xs">
        <div>
          <span class="font-bold text-slate-900">DDD ${item.ddd}</span>
          <span class="text-slate-500 ml-1">(${item.estado} - ${item.cidade_ref || item.regiao})</span>
        </div>
        <div class="text-right font-semibold">
          <span class="text-slate-900">${item.count}</span>
          <span class="text-slate-400 text-[10px]">(${item.percent}%)</span>
        </div>
      </div>
    `).join("");
  }

  document.getElementById("detailModal").classList.remove("hidden");
}

function closeDetailModal() {
  document.getElementById("detailModal").classList.add("hidden");
  state.activeDetailGroup = null;
}

function leaveFromDetailModal() {
  if (!state.activeDetailGroup) return;
  const g = state.activeDetailGroup;
  closeDetailModal();
  confirmLeaveGroup(g.id, g.subject);
}

// ====================================================
// UTILITÁRIOS (TOASTS, SANITIZAÇÃO)
// ====================================================

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  const colors = {
    success: "bg-emerald-600 text-white",
    error: "bg-rose-600 text-white",
    info: "bg-slate-900 text-white"
  };

  toast.className = `p-3.5 rounded-xl text-xs font-semibold shadow-lg flex items-center gap-2 pointer-events-auto transform transition-all duration-200 translate-y-2 opacity-0 ${colors[type] || colors.info}`;
  toast.innerHTML = `
    <i class="fa-solid ${type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info'}"></i>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove("translate-y-2", "opacity-0");
  });

  setTimeout(() => {
    toast.classList.add("opacity-0", "translate-y-2");
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(str) {
  if (!str) return "";
  return String(str).replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

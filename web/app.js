/* Painel InvestNow: lógica do navegador.
   Cripto e câmbio: WebSocket público da Binance (tick a tick).
   B3, EUA e renda fixa: função `api` no Supabase, atualizada a cada 30 s. */
(() => {
  "use strict";
  const API = window.PAINEL_CONFIG.api;
  const BINANCE_WS = "wss://stream.binance.com:9443";
  const BINANCE_REST = "https://api.binance.com/api/v3";
  const CLASSES = { b3: "Ações B3", eua: "EUA", cripto: "Cripto", cambio: "Câmbio", rendafixa: "Renda fixa" };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const est = {
    codigo: ler("painel.codigo") || "",
    ativos: [],
    cot: {},            // simbolo -> {preco, variacao, anterior, volume, hora}
    sel: ler("painel.sel") || "BTC",
    iv: ler("painel.iv") || "15m",
    decisoes: [], alertas: [], disparos: [],
    ws: null, wsKline: null,
  };

  function ler(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function gravar(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

  // ---------- API ----------
  async function api(acao, params = {}) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-codigo": est.codigo },
      body: JSON.stringify({ acao, ...params }),
    });
    const j = await r.json().catch(() => ({ erro: `Erro ${r.status}` }));
    if (r.status === 401) { sair(); throw new Error(j.erro); }
    if (!r.ok || j.erro) throw new Error(j.erro || `Erro ${r.status}`);
    return j.dados;
  }

  // ---------- Formatação ----------
  const moeda = (a) => a.classe === "rendafixa" ? "%" : (a.classe === "b3" || a.codigo.endsWith("BRL")) ? "R$" : "US$";
  const ehIndice = (a) => a.codigo.startsWith("^");
  function casas(v, a) {
    if (a && a.classe === "rendafixa") return 2;
    if (v == null) return 2;
    const x = Math.abs(v);
    return x >= 1000 ? 2 : x >= 1 ? (a && a.classe === "cambio" ? 4 : 2) : x >= 0.01 ? 4 : 6;
  }
  function fmtN(v, d = 2) { return v == null || isNaN(v) ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function fmtPreco(v, a) {
    if (v == null) return "—";
    const n = fmtN(v, casas(v, a));
    if (!a || ehIndice(a)) return n;
    return a.classe === "rendafixa" ? `${n}%` : n;
  }
  function fmtVar(v, a) {
    if (v == null || isNaN(v)) return "—";
    const s = v > 0 ? "+" : "";
    return a && a.classe === "rendafixa" ? `${s}${fmtN(v, 2)} p.p.` : `${s}${fmtN(v, 2)}%`;
  }
  const tom = (v) => v > 0 ? "alta" : v < 0 ? "baixa" : "";
  const dataHora = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const numBR = (s) => Number(String(s).replace(/\./g, "").replace(",", "."));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const porSimbolo = (s) => est.ativos.find((a) => a.simbolo === s);

  let avisoT;
  function aviso(msg, ruim = false) {
    const el = $("#aviso");
    el.textContent = msg; el.className = "aviso" + (ruim ? " ruim" : ""); el.hidden = false;
    clearTimeout(avisoT); avisoT = setTimeout(() => (el.hidden = true), 3500);
  }

  // ---------- Login ----------
  async function entrar(codigo) {
    est.codigo = codigo.trim();
    await api("entrar");
    gravar("painel.codigo", est.codigo);
  }
  function sair() {
    gravar("painel.codigo", null); est.codigo = "";
    $("#app").hidden = true; $("#tela-login").hidden = false;
    if (est.ws) est.ws.close(); if (est.wsKline) est.wsKline.close();
  }
  $("#form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-erro").hidden = true;
    try { await entrar($("#codigo").value); iniciar(); }
    catch (err) { $("#login-erro").textContent = err.message || "Não foi possível entrar"; $("#login-erro").hidden = false; }
  });
  $("#sair").addEventListener("click", sair);

  // ---------- Lista de ativos ----------
  function desenharLista() {
    const cont = $("#lista");
    cont.innerHTML = "";
    for (const classe of Object.keys(CLASSES)) {
      const grupo = est.ativos.filter((a) => a.classe === classe);
      if (!grupo.length) continue;
      const cab = document.createElement("div");
      cab.className = "grupo";
      const atraso = classe === "cripto" || classe === "cambio" ? "ao vivo" : classe === "rendafixa" ? "diário" : "atraso 15 min";
      cab.innerHTML = `<span>${CLASSES[classe]}</span><span>${atraso}</span>`;
      cont.append(cab);
      for (const a of grupo) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "linha-ativo"; b.dataset.sim = a.simbolo;
        b.setAttribute("aria-current", a.simbolo === est.sel ? "true" : "false");
        b.innerHTML = `<span class="la-id"><span class="la-sim">${esc(a.simbolo)}</span><span class="la-nome">${esc(a.nome)}</span></span>
          <span class="la-preco" data-p>—</span><span class="chip" data-v>—</span>`;
        b.addEventListener("click", () => selecionar(a.simbolo, true));
        cont.append(b);
        pintarLinha(a.simbolo);
      }
    }
  }
  function pintarLinha(sim, anterior) {
    const a = porSimbolo(sim); const q = est.cot[sim];
    const b = document.querySelector(`.linha-ativo[data-sim="${CSS.escape(sim)}"]`);
    if (!a || !b || !q) return;
    const p = b.querySelector("[data-p]"); const v = b.querySelector("[data-v]");
    p.textContent = fmtPreco(q.preco, a);
    v.textContent = fmtVar(q.variacao, a);
    v.className = "chip " + tom(q.variacao);
    if (anterior != null && q.preco !== anterior) {
      const c = q.preco > anterior ? "pisca-alta" : "pisca-baixa";
      p.classList.remove("pisca-alta", "pisca-baixa"); void p.offsetWidth; p.classList.add(c);
      setTimeout(() => p.classList.remove(c), 250);
    }
  }
  function atualizarCot(sim, dados) {
    const ant = est.cot[sim]?.preco;
    est.cot[sim] = { ...est.cot[sim], ...dados };
    pintarLinha(sim, ant);
    if (sim === est.sel) pintarCabecalho();
  }

  // ---------- Binance ao vivo ----------
  function conectarBinance() {
    const bin = est.ativos.filter((a) => a.fonte === "binance");
    if (est.ws) { est.ws.onclose = null; est.ws.close(); }
    if (!bin.length) return;
    const streams = bin.map((a) => a.codigo.toLowerCase() + "@ticker").join("/");
    const ws = new WebSocket(`${BINANCE_WS}/stream?streams=${streams}`);
    est.ws = ws;
    ws.onopen = () => $("#st-binance").className = "fonte-st ok";
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data).data; if (!d) return;
      const a = bin.find((x) => x.codigo === d.s); if (!a) return;
      atualizarCot(a.simbolo, { preco: +d.c, variacao: +d.P, anterior: +d.x || +d.o, volume: +d.q, hora: d.E });
    };
    ws.onclose = () => { $("#st-binance").className = "fonte-st falha"; setTimeout(conectarBinance, 3000); };
  }

  // ---------- Cotações com atraso ----------
  async function buscarAtrasadas() {
    try {
      const lista = await api("cotacoes");
      for (const q of lista) if (q.preco != null) atualizarCot(q.simbolo, q);
      $("#st-atraso").className = "fonte-st ok";
      $("#st-atraso").title = "Atualizado às " + new Date().toLocaleTimeString("pt-BR");
      if (est.decisoes.length) desenharDecisoes();
    } catch { $("#st-atraso").className = "fonte-st falha"; }
  }

  // ---------- Gráfico ----------
  let chart, velasS, volS, dadosVelas = [];
  const fuso = () => -new Date().getTimezoneOffset() * 60; // segundos para hora local
  const cor = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function criarGrafico() {
    const el = $("#grafico");
    chart = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: cor("--mudo"), fontFamily: "IBM Plex Mono, monospace" },
      grid: { vertLines: { color: cor("--linha") + "80" }, horzLines: { color: cor("--linha") + "80" } },
      rightPriceScale: { borderColor: cor("--linha") },
      timeScale: { borderColor: cor("--linha"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { locale: "pt-BR", priceFormatter: (p) => fmtN(p, casas(p, porSimbolo(est.sel))) },
    });
    velasS = chart.addCandlestickSeries({
      upColor: cor("--alta"), downColor: cor("--baixa"), borderVisible: false,
      wickUpColor: cor("--alta"), wickDownColor: cor("--baixa"),
    });
    volS = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.subscribeCrosshairMove((p) => {
      const d = p && p.seriesData && p.seriesData.get(velasS);
      mostrarOHLC(d || dadosVelas[dadosVelas.length - 1]);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { chart.remove(); criarGrafico(); carregarVelas(); });
  }
  function mostrarOHLC(d) {
    const a = porSimbolo(est.sel);
    if (!d || !a) { $("#g-ohlc").textContent = ""; return; }
    if (a.classe === "rendafixa") { $("#g-ohlc").textContent = `Valor ${fmtPreco(d.close, a)}`; return; }
    $("#g-ohlc").innerHTML = `<span>A ${fmtN(d.open, casas(d.open, a))}</span><span>M ${fmtN(d.high, casas(d.high, a))}</span><span>m ${fmtN(d.low, casas(d.low, a))}</span><span>F ${fmtN(d.close, casas(d.close, a))}</span>`;
  }
  const paraVela = (v) => ({ time: Math.floor(v.t / 1000) + fuso(), open: v.o, high: v.h, low: v.l, close: v.c });
  const paraVol = (v) => ({ time: Math.floor(v.t / 1000) + fuso(), value: v.v, color: (v.c >= v.o ? cor("--alta") : cor("--baixa")) + "55" });

  let pedidoVelas = 0, timerVelas;
  async function carregarVelas() {
    const a = porSimbolo(est.sel); if (!a) return;
    const meu = ++pedidoVelas;
    clearTimeout(timerVelas);
    if (est.wsKline) { est.wsKline.onclose = null; est.wsKline.close(); est.wsKline = null; }
    const rf = a.classe === "rendafixa";
    $$("#intervalos button").forEach((b) => { b.disabled = rf && b.dataset.iv !== "1d"; b.setAttribute("aria-pressed", String((rf ? "1d" : est.iv) === b.dataset.iv)); });
    const iv = rf ? "1d" : est.iv;
    $("#graf-msg").textContent = "Carregando velas…"; $("#graf-msg").hidden = false;
    try {
      let lista;
      if (a.fonte === "binance") {
        const r = await fetch(`${BINANCE_REST}/klines?symbol=${a.codigo}&interval=${iv}&limit=500`);
        lista = (await r.json()).map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
      } else {
        lista = await api("velas", { simbolo: a.simbolo, intervalo: iv });
      }
      if (meu !== pedidoVelas) return;
      // remove horários repetidos (o gráfico exige ordem estrita)
      const vistos = new Set(); lista = lista.filter((v) => !vistos.has(v.t) && vistos.add(v.t));
      dadosVelas = lista.map(paraVela);
      velasS.setData(dadosVelas);
      volS.setData(rf ? [] : lista.map(paraVol));
      chart.timeScale().fitContent();
      const mostrar = matchMedia("(max-width: 600px)").matches ? 60 : 120;
      if (lista.length > mostrar) chart.timeScale().setVisibleLogicalRange({ from: lista.length - mostrar, to: lista.length + 3 });
      mostrarOHLC(dadosVelas[dadosVelas.length - 1]);
      $("#graf-msg").hidden = !!lista.length;
      if (!lista.length) $("#graf-msg").textContent = "Sem negociação nesse intervalo.";
      if (a.fonte === "binance") velasAoVivo(a, iv);
      else timerVelas = setTimeout(carregarVelas, rf ? 3_600_000 : 60_000);
    } catch (e) {
      if (meu !== pedidoVelas) return;
      $("#graf-msg").textContent = "Não consegui carregar as velas. Tentando de novo em 30 s.";
      timerVelas = setTimeout(carregarVelas, 30_000);
    }
  }
  function velasAoVivo(a, iv) {
    const ws = new WebSocket(`${BINANCE_WS}/ws/${a.codigo.toLowerCase()}@kline_${iv}`);
    est.wsKline = ws;
    ws.onmessage = (ev) => {
      const k = JSON.parse(ev.data).k; if (!k) return;
      const v = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
      const vela = paraVela(v);
      velasS.update(vela); volS.update(paraVol(v));
      if (dadosVelas.length && dadosVelas[dadosVelas.length - 1].time === vela.time) dadosVelas[dadosVelas.length - 1] = vela; else dadosVelas.push(vela);
    };
    ws.onclose = () => { if (est.wsKline === ws) setTimeout(() => { if (est.wsKline === ws) velasAoVivo(a, iv); }, 3000); };
  }

  function pintarCabecalho() {
    const a = porSimbolo(est.sel); if (!a) return;
    const q = est.cot[a.simbolo] || {};
    $("#g-simbolo").textContent = a.simbolo;
    $("#g-nome").textContent = a.nome;
    const vivo = a.fonte === "binance";
    $("#g-fonte").textContent = vivo ? "ao vivo" : a.fonte === "bcb" ? "Banco Central · diário" : "atraso 15 min";
    $("#g-fonte").className = "selo" + (vivo ? " vivo" : "");
    const m = moeda(a);
    $("#g-preco").textContent = (m !== "%" && !ehIndice(a) ? m + " " : "") + fmtPreco(q.preco, a);
    $("#g-var").textContent = fmtVar(q.variacao, a);
    $("#g-var").className = "num chip " + tom(q.variacao);
    document.title = q.preco != null ? `${a.simbolo} ${fmtPreco(q.preco, a)} · Painel InvestNow` : "Painel InvestNow";
  }

  function selecionar(sim, rolar) {
    if (!porSimbolo(sim)) sim = est.ativos[0]?.simbolo;
    if (!sim) return;
    est.sel = sim; gravar("painel.sel", sim);
    $$(".linha-ativo").forEach((b) => b.setAttribute("aria-current", String(b.dataset.sim === sim)));
    pintarCabecalho();
    carregarVelas();
    if (rolar && matchMedia("(max-width: 900px)").matches) $(".centro").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#intervalos").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-iv]"); if (!b || b.disabled) return;
    est.iv = b.dataset.iv; gravar("painel.iv", est.iv); carregarVelas();
  });

  // ---------- Abas ----------
  function abrirAba(nome) {
    $$(".abas button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.aba === nome)));
    $$(".aba").forEach((s) => (s.hidden = s.id !== "aba-" + nome));
  }
  $(".abas").addEventListener("click", (e) => { const b = e.target.closest("button[data-aba]"); if (b) abrirAba(b.dataset.aba); });
  function contador(aba, n) {
    const b = document.querySelector(`.abas button[data-aba="${aba}"]`);
    b.innerHTML = b.textContent.replace(/\d+$/, "").trim() + (n ? ` <span class="cont">${n}</span>` : "");
  }

  function opcoesAtivos(sel) {
    sel.innerHTML = est.ativos.map((a) => `<option value="${esc(a.simbolo)}">${esc(a.simbolo)} · ${esc(a.nome)}</option>`).join("");
    sel.value = est.sel;
  }

  // ---------- Decisões ----------
  $$("[data-abrir]").forEach((b) => b.addEventListener("click", () => {
    const tipo = b.dataset.abrir;
    if (tipo === "alerta") {
      abrirAba("alertas"); opcoesAtivos($("#a-simbolo")); $("#form-alerta").hidden = false; ajustarRotuloAlerta(); $("#a-valor").focus();
    } else {
      abrirAba("decisoes"); opcoesAtivos($("#d-simbolo"));
      $("#d-lado").value = tipo;
      const q = est.cot[est.sel]; const a = porSimbolo(est.sel);
      $("#d-preco").value = q?.preco != null ? String(Number(q.preco.toFixed(casas(q.preco, a)))).replace(".", ",") : "";
      $("#d-autor").value = ler("painel.autor") || "";
      $("#form-decisao").hidden = false; $("#d-qtd").focus();
    }
    $(".abas").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $$("[data-fechar]").forEach((b) => b.addEventListener("click", () => (b.closest("form").hidden = true)));
  $("#d-simbolo").addEventListener("change", () => {
    const s = $("#d-simbolo").value; const q = est.cot[s];
    if (q?.preco != null) $("#d-preco").value = String(Number(q.preco.toFixed(casas(q.preco, porSimbolo(s))))).replace(".", ",");
  });

  $("#form-decisao").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      gravar("painel.autor", $("#d-autor").value);
      const d = await api("decisao_adicionar", {
        simbolo: $("#d-simbolo").value, lado: $("#d-lado").value,
        preco: numBR($("#d-preco").value), quantidade: numBR($("#d-qtd").value),
        motivo: $("#d-motivo").value, autor: $("#d-autor").value,
      });
      est.decisoes.unshift(d); desenharDecisoes();
      e.target.reset(); e.target.hidden = true; aviso("Decisão registrada");
    } catch (err) { aviso(err.message, true); }
    btn.disabled = false;
  });

  function resultado(d) {
    const q = est.cot[d.simbolo];
    if (!q || q.preco == null) return null;
    const r = (q.preco - d.preco) / d.preco * 100;
    return d.lado === "compra" ? r : -r;
  }
  function desenharDecisoes() {
    const tb = $("#t-decisoes tbody");
    $("#v-decisoes").hidden = est.decisoes.length > 0;
    $("#t-decisoes").closest(".tabela-rolagem").hidden = !est.decisoes.length;
    contador("decisoes", est.decisoes.length);
    let certas = 0, medidas = 0, soma = 0;
    tb.innerHTML = est.decisoes.map((d) => {
      const a = porSimbolo(d.simbolo);
      const r = resultado(d);
      if (r != null) { medidas++; soma += r; if (r > 0) certas++; }
      return `<tr>
        <td class="num">${dataHora(d.criado_em)}</td>
        <td><b>${esc(d.simbolo)}</b></td>
        <td><span class="lado ${d.lado}">${d.lado}</span></td>
        <td class="dir num">${fmtPreco(Number(d.preco), a)}</td>
        <td class="dir num">${fmtN(Number(d.quantidade), Number(d.quantidade) % 1 ? 4 : 0)}</td>
        <td class="dir num">${fmtPreco(est.cot[d.simbolo]?.preco, a)}</td>
        <td class="dir"><span class="chip ${tom(r)}">${r == null ? "—" : (r > 0 ? "+" : "") + fmtN(r) + "%"}</span></td>
        <td class="motivo">${esc(d.motivo)}${d.autor ? ` <span class="mudo">· ${esc(d.autor)}</span>` : ""}</td>
        <td><button class="btn-x" type="button" data-del-dec="${d.id}" title="Apagar decisão" aria-label="Apagar decisão">✕</button></td>
      </tr>`;
    }).join("");
    $("#resumo-decisoes").innerHTML = medidas ? `
      <div class="resumo-item"><span>Decisões</span><b>${est.decisoes.length}</b></div>
      <div class="resumo-item"><span>Acertando agora</span><b>${certas} de ${medidas}</b></div>
      <div class="resumo-item"><span>Resultado médio</span><b class="${tom(soma)}">${(soma > 0 ? "+" : "") + fmtN(soma / medidas)}%</b></div>` : "";
  }
  $("#t-decisoes").addEventListener("click", (e) => confirmarApagar(e, "data-del-dec", async (id) => {
    await api("decisao_remover", { id }); est.decisoes = est.decisoes.filter((d) => d.id !== id); desenharDecisoes();
  }));

  // Apagar com dois cliques (o painel não usa janelas de confirmação)
  function confirmarApagar(e, attr, fn) {
    const b = e.target.closest(`[${attr}]`); if (!b) return;
    if (b.dataset.confirma !== "1") {
      b.dataset.confirma = "1"; b.textContent = "Apagar?"; b.classList.add("baixa");
      setTimeout(() => { if (b.isConnected) { b.dataset.confirma = ""; b.textContent = "✕"; b.classList.remove("baixa"); } }, 3000);
      return;
    }
    fn(Number(b.getAttribute(attr)) || b.getAttribute(attr)).catch((err) => aviso(err.message, true));
  }

  // ---------- Alertas ----------
  const ROTULOS = { variacao: "Variação (%)", preco_acima: "Preço alvo", preco_abaixo: "Preço alvo", volume: "Vezes a média" };
  function ajustarRotuloAlerta() {
    const t = $("#a-tipo").value; $("#a-valor-rot").textContent = ROTULOS[t];
    $("#a-valor").placeholder = t === "variacao" ? "Ex.: 3" : t === "volume" ? "Ex.: 2" : "Ex.: " + fmtN(est.cot[$("#a-simbolo").value]?.preco ?? 0);
  }
  $("#a-tipo").addEventListener("change", ajustarRotuloAlerta);
  $("#a-simbolo").addEventListener("change", ajustarRotuloAlerta);
  function descreverAlerta(al) {
    const a = porSimbolo(al.simbolo); const v = Number(al.valor);
    return {
      variacao: `Variação no dia de ${fmtN(v)}% ou mais`,
      preco_acima: `Preço chega a ${fmtPreco(v, a)} ou mais`,
      preco_abaixo: `Preço cai a ${fmtPreco(v, a)} ou menos`,
      volume: `Volume ${fmtN(v, 1)}x a média de 20 dias`,
    }[al.tipo];
  }
  $("#form-alerta").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      if (!$("#a-email").checked && !$("#a-zap").checked) throw new Error("Escolha pelo menos um canal");
      const al = await api("alerta_adicionar", {
        simbolo: $("#a-simbolo").value, tipo: $("#a-tipo").value, valor: numBR($("#a-valor").value),
        email: $("#a-email").checked, whatsapp: $("#a-zap").checked,
      });
      est.alertas.unshift(al); desenharAlertas();
      $("#a-valor").value = ""; e.target.hidden = true; aviso("Alerta criado");
    } catch (err) { aviso(err.message, true); }
    btn.disabled = false;
  });
  function desenharAlertas() {
    $("#v-alertas").hidden = est.alertas.length > 0;
    $("#t-alertas").closest(".tabela-rolagem").hidden = !est.alertas.length;
    contador("alertas", est.alertas.filter((a) => a.ativo).length);
    $("#t-alertas tbody").innerHTML = est.alertas.map((al) => `<tr>
      <td><b>${esc(al.simbolo)}</b></td>
      <td>${esc(descreverAlerta(al))}</td>
      <td>${[al.whatsapp && "WhatsApp", al.email && "E-mail"].filter(Boolean).join(" · ")}</td>
      <td class="num">${al.ultimo_disparo ? dataHora(al.ultimo_disparo) : "—"}</td>
      <td><button type="button" class="situacao ${al.ativo ? "ligado" : "desligado"}" data-alt="${al.id}">${al.ativo ? "Ligado" : "Desligado"}</button></td>
      <td><button class="btn-x" type="button" data-del-al="${al.id}" title="Apagar alerta" aria-label="Apagar alerta">✕</button></td>
    </tr>`).join("");
  }
  $("#t-alertas").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-alt]");
    if (t) {
      const al = est.alertas.find((x) => x.id === Number(t.dataset.alt));
      try { await api("alerta_alternar", { id: al.id, ativo: !al.ativo }); al.ativo = !al.ativo; al.ultimo_disparo = null; desenharAlertas(); }
      catch (err) { aviso(err.message, true); }
      return;
    }
    confirmarApagar(e, "data-del-al", async (id) => {
      await api("alerta_remover", { id }); est.alertas = est.alertas.filter((a) => a.id !== id); desenharAlertas();
    });
  });

  function desenharDisparos() {
    $("#v-disparos").hidden = est.disparos.length > 0;
    $("#l-disparos").innerHTML = est.disparos.map((d) => `<li>
      <span>${esc(d.mensagem)}</span>
      <span class="meta"><span class="num">${dataHora(d.criado_em)}</span>
        ${d.canais ? `<span>Enviado por ${esc(d.canais)}</span>` : ""}
        ${d.erro ? `<span class="falhou">Falhou: ${esc(d.erro)}</span>` : ""}</span>
    </li>`).join("");
  }

  // ---------- Gerenciar ativos ----------
  $("#n-classe").addEventListener("change", () => {
    const rf = $("#n-classe").value === "rendafixa";
    $("#n-codigo-campo").hidden = !rf;
    $("#n-simbolo").placeholder = { b3: "Ex.: MGLU3", eua: "Ex.: TSLA", cripto: "Ex.: ADA", cambio: "Ex.: USDTBRL", rendafixa: "Ex.: TR" }[$("#n-classe").value];
  });
  $("#form-ativo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true; btn.textContent = "Conferindo…";
    try {
      const a = await api("ativo_adicionar", {
        classe: $("#n-classe").value, simbolo: $("#n-simbolo").value, nome: $("#n-nome").value, codigo: $("#n-codigo").value,
      });
      e.target.reset(); $("#n-codigo-campo").hidden = true;
      await carregarAtivos(); aviso(`${a.simbolo} adicionado`);
    } catch (err) { aviso(err.message, true); }
    btn.disabled = false; btn.textContent = "Adicionar";
  });
  function desenharGerenciar() {
    $("#l-ativos").innerHTML = est.ativos.map((a) => `<li>
      <span class="nm"><b>${esc(a.simbolo)}</b> <span class="mudo">${esc(a.nome)} · ${CLASSES[a.classe]}</span></span>
      <button class="btn-x" type="button" data-del-at="${esc(a.simbolo)}" title="Tirar da lista" aria-label="Tirar ${esc(a.simbolo)} da lista">✕</button>
    </li>`).join("");
  }
  $("#l-ativos").addEventListener("click", (e) => confirmarApagar(e, "data-del-at", async (sim) => {
    await api("ativo_remover", { simbolo: sim }); await carregarAtivos(); aviso(`${sim} removido`);
  }));

  async function carregarAtivos() {
    est.ativos = await api("ativos");
    desenharLista(); desenharGerenciar(); conectarBinance();
    if (!porSimbolo(est.sel)) selecionar(est.ativos[0]?.simbolo);
  }

  async function carregarRegistros() {
    try {
      const [d, a, x] = await Promise.all([api("decisoes"), api("alertas"), api("disparos")]);
      est.decisoes = d; est.alertas = a;
      const novos = est.disparos.length && x.length && x[0].id !== est.disparos[0].id;
      est.disparos = x;
      desenharDecisoes(); desenharAlertas(); desenharDisparos();
      contador("disparos", 0);
      if (novos) { aviso("Novo alerta disparado: " + x[0].mensagem); contador("disparos", 1); }
    } catch (err) { aviso(err.message, true); }
  }

  // ---------- Início ----------
  let iniciado = false;
  async function iniciar() {
    $("#tela-login").hidden = true; $("#app").hidden = false;
    if (!chart) criarGrafico();
    await carregarAtivos();
    selecionar(est.sel);
    buscarAtrasadas();
    carregarRegistros();
    if (iniciado) return;
    iniciado = true;
    setInterval(() => { if (!document.hidden && est.codigo) buscarAtrasadas(); }, 30_000);
    setInterval(() => { if (!document.hidden && est.codigo) carregarRegistros(); }, 60_000);
    setInterval(() => { if (!document.hidden && est.decisoes.length) desenharDecisoes(); }, 5_000);
  }

  setInterval(() => {
    $("#relogio").textContent = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" }) + " Brasília";
  }, 1000);

  if (est.codigo) {
    entrar(est.codigo).then(iniciar).catch(() => ($("#tela-login").hidden = false));
  } else {
    $("#tela-login").hidden = false;
  }
})();

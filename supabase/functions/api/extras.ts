// Indicadores econômicos (Banco Central e FRED) e notícias (RSS), com cache.

const UA = { "User-Agent": "Mozilla/5.0 (painel-investnow)" };
const cache = new Map<string, { at: number; val: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val as T;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  return val;
}

export type Indicador = {
  grupo: "br" | "eua";
  nome: string;
  valor: number | null;
  anterior: number | null;
  unidade: string; // "%", "% a.a.", "R$", "mil"
  data: string | null; // data de referência, dd/mm/aaaa ou mm/aaaa
  fonte: string;
};

type Serie = { data: string; valor: number }[];

async function bcb(codigo: number, n = 13): Promise<Serie> {
  const r = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${codigo}/dados/ultimos/${n}?formato=json`, { headers: UA });
  if (!r.ok) throw new Error(`BCB ${r.status}`);
  return (await r.json()).map((x: { data: string; valor: string }) => ({ data: x.data, valor: Number(x.valor) }));
}

async function fred(id: string): Promise<Serie> {
  const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: UA });
  if (!r.ok) throw new Error(`FRED ${r.status}`);
  const linhas = (await r.text()).trim().split("\n").slice(1);
  return linhas
    .map((l) => l.split(","))
    .filter(([, v]) => v && v !== "." && !isNaN(Number(v)))
    .slice(-400)
    .map(([d, v]) => {
      const [y, m, dd] = d.split("-");
      return { data: `${dd}/${m}/${y}`, valor: Number(v) };
    });
}

const mesAno = (d: string) => d.slice(3); // dd/mm/aaaa -> mm/aaaa

function ultimo(nome: string, grupo: "br" | "eua", unidade: string, fonte: string, s: Serie, mensal = false): Indicador {
  const u = s[s.length - 1];
  const a = s.length > 1 ? s[s.length - 2] : null;
  return { grupo, nome, unidade, fonte, valor: u?.valor ?? null, anterior: a?.valor ?? null, data: u ? (mensal ? mesAno(u.data) : u.data) : null };
}

// Variação em 12 meses de um índice mensal (ex.: CPI).
function em12m(nome: string, grupo: "br" | "eua", fonte: string, s: Serie): Indicador {
  const n = s.length;
  const yoy = (i: number) => (i >= 12 ? (s[i].valor / s[i - 12].valor - 1) * 100 : null);
  return { grupo, nome, unidade: "%", fonte, valor: yoy(n - 1), anterior: yoy(n - 2), data: n ? mesAno(s[n - 1].data) : null };
}

// Diferença mensal (ex.: criação de vagas no payroll, em milhares).
function diferenca(nome: string, grupo: "br" | "eua", unidade: string, fonte: string, s: Serie): Indicador {
  const n = s.length;
  const d = (i: number) => (i >= 1 ? s[i].valor - s[i - 1].valor : null);
  return { grupo, nome, unidade, fonte, valor: d(n - 1), anterior: d(n - 2), data: n ? mesAno(s[n - 1].data) : null };
}

async function seguro(fn: () => Promise<Indicador>, nome: string, grupo: "br" | "eua", unidade: string, fonte: string): Promise<Indicador> {
  try { return await fn(); } catch { return { grupo, nome, unidade, fonte, valor: null, anterior: null, data: null }; }
}

export function indicadores(): Promise<Indicador[]> {
  return cached("indicadores", 3_600_000, () =>
    Promise.all([
      seguro(async () => ultimo("Selic meta", "br", "% a.a.", "BCB", await bcb(432, 2)), "Selic meta", "br", "% a.a.", "BCB"),
      seguro(async () => ultimo("IPCA 12 meses", "br", "%", "IBGE/BCB", await bcb(13522, 2), true), "IPCA 12 meses", "br", "%", "IBGE/BCB"),
      seguro(async () => ultimo("IPCA no mês", "br", "%", "IBGE/BCB", await bcb(433, 2), true), "IPCA no mês", "br", "%", "IBGE/BCB"),
      seguro(async () => ultimo("IGP-M no mês", "br", "%", "FGV/BCB", await bcb(189, 2), true), "IGP-M no mês", "br", "%", "FGV/BCB"),
      seguro(async () => ultimo("Desemprego (PNAD)", "br", "%", "IBGE/BCB", await bcb(24369, 2), true), "Desemprego (PNAD)", "br", "%", "IBGE/BCB"),
      seguro(async () => ultimo("Dólar PTAX venda", "br", "R$", "BCB", await bcb(1, 2)), "Dólar PTAX venda", "br", "R$", "BCB"),
      seguro(async () => ultimo("IBC-Br (prévia do PIB)", "br", "pts", "BCB", await bcb(24364, 2), true), "IBC-Br (prévia do PIB)", "br", "pts", "BCB"),
      seguro(async () => ultimo("Fed Funds (teto)", "eua", "% a.a.", "Fed/FRED", await fred("DFEDTARU")), "Fed Funds (teto)", "eua", "% a.a.", "Fed/FRED"),
      seguro(async () => em12m("CPI 12 meses", "eua", "BLS/FRED", await fred("CPIAUCSL")), "CPI 12 meses", "eua", "%", "BLS/FRED"),
      seguro(async () => em12m("Core CPI 12 meses", "eua", "BLS/FRED", await fred("CPILFESL")), "Core CPI 12 meses", "eua", "%", "BLS/FRED"),
      seguro(async () => ultimo("Desemprego", "eua", "%", "BLS/FRED", await fred("UNRATE"), true), "Desemprego", "eua", "%", "BLS/FRED"),
      seguro(async () => diferenca("Payroll (vagas criadas)", "eua", "mil", "BLS/FRED", await fred("PAYEMS")), "Payroll (vagas criadas)", "eua", "mil", "BLS/FRED"),
      seguro(async () => ultimo("PIB (tri anualizado)", "eua", "%", "BEA/FRED", await fred("A191RL1Q225SBEA"), true), "PIB (tri anualizado)", "eua", "%", "BEA/FRED"),
      seguro(async () => ultimo("Treasury 10 anos", "eua", "% a.a.", "FRED", await fred("DGS10")), "Treasury 10 anos", "eua", "% a.a.", "FRED"),
    ])
  );
}

export type Noticia = { titulo: string; link: string; fonte: string; quando: number };

const FEEDS: { url: string; fonte: string }[] = [
  { url: "https://www.infomoney.com.br/feed/", fonte: "InfoMoney" },
  { url: "https://www.moneytimes.com.br/feed/", fonte: "Money Times" },
  { url: "https://news.google.com/rss/search?q=mercado+financeiro+OR+ibovespa+OR+d%C3%B3lar&hl=pt-BR&gl=BR&ceid=BR:pt-419", fonte: "" },
  { url: "https://news.google.com/rss/search?q=stock+market+OR+fed+OR+treasury&hl=en-US&gl=US&ceid=US:en", fonte: "" },
];

const limpar = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).trim();
const tag = (item: string, t: string) => {
  const m = item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
  return m ? limpar(m[1]) : "";
};

async function lerFeed(f: { url: string; fonte: string }): Promise<Noticia[]> {
  const r = await fetch(f.url, { headers: UA });
  if (!r.ok) return [];
  const xml = await r.text();
  const itens = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  return itens.slice(0, 20).map((it) => {
    let titulo = tag(it, "title");
    let fonte = f.fonte || tag(it, "source");
    // Google News põe " - Fonte" no fim do título
    if (!f.fonte && fonte && titulo.endsWith(` - ${fonte}`)) titulo = titulo.slice(0, -(fonte.length + 3));
    if (!fonte) fonte = "Google Notícias";
    return { titulo, link: tag(it, "link"), fonte, quando: Date.parse(tag(it, "pubDate")) || 0 };
  }).filter((n) => n.titulo && /^https?:\/\//.test(n.link));
}

export function noticias(): Promise<Noticia[]> {
  return cached("noticias", 300_000, async () => {
    const listas = await Promise.all(FEEDS.map((f) => lerFeed(f).catch(() => [])));
    const vistos = new Set<string>();
    return listas.flat()
      .sort((a, b) => b.quando - a.quando)
      .filter((n) => {
        const k = n.titulo.toLowerCase().slice(0, 60);
        if (vistos.has(k)) return false;
        vistos.add(k);
        return true;
      })
      .slice(0, 40);
  });
}

// Tesouro Direto: taxas e preços do último fechamento (Tesouro Transparente, D-1).
// O arquivo é grande (~15 MB) e vem com os dias mais recentes no topo: lemos só o começo.
export type Titulo = {
  tipo: string; vencimento: string; taxa: number | null; taxaAnterior: number | null;
  pu: number | null; data: string; aoVivo?: boolean; hora?: string;
};
const TESOURO_CSV =
  "https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv";
const TIPOS = ["Tesouro Selic", "Tesouro Prefixado", "Tesouro Prefixado com Juros Semestrais", "Tesouro IPCA+", "Tesouro IPCA+ com Juros Semestrais"];
const num = (s: string) => (s ? Number(s.replace(".", "").replace(",", ".")) : null);
const ymd = (d: string) => d.split("/").reverse().join("");

function tesouroFechamento(): Promise<Titulo[]> {
  return cached("tesouro", 3 * 3_600_000, async () => {
    const r = await fetch(TESOURO_CSV, { headers: UA });
    if (!r.ok || !r.body) throw new Error(`Tesouro ${r.status}`);
    const leitor = r.body.pipeThrough(new TextDecoderStream("latin1")).getReader();
    let texto = "";
    const datas = new Set<string>();
    while (texto.length < 600_000) {
      const { value, done } = await leitor.read();
      if (done) break;
      texto += value;
      for (const l of value.split("\n")) { const d = l.split(";")[2]; if (d && /\d\d\/\d\d\/\d{4}/.test(d)) datas.add(d); }
      if (datas.size >= 4) break;
    }
    leitor.cancel().catch(() => {});
    const linhas = texto.split("\n").slice(1).map((l) => l.split(";")).filter((c) => c.length >= 7 && /\d\d\/\d\d\/\d{4}/.test(c[2]));
    const ordenadas = [...new Set(linhas.map((c) => c[2]))].sort((a, b) => ymd(b).localeCompare(ymd(a)));
    const [hoje, ontem] = ordenadas;
    const ant = new Map(linhas.filter((c) => c[2] === ontem).map((c) => [`${c[0]}|${c[1]}`, num(c[3])]));
    return linhas
      .filter((c) => c[2] === hoje && TIPOS.includes(c[0]))
      .map((c) => ({ tipo: c[0], vencimento: c[1], taxa: num(c[3]), taxaAnterior: ant.get(`${c[0]}|${c[1]}`) ?? null, pu: num(c[5]), data: c[2] }))
      .sort((a, b) => TIPOS.indexOf(a.tipo) - TIPOS.indexOf(b.tipo) || ymd(a.vencimento).localeCompare(ymd(b.vencimento)));
  });
}

// Taxas do dia, como aparecem no site do Tesouro Direto (atualizadas algumas vezes por pregão).
// Só os títulos à venda das famílias Selic, Prefixado e IPCA+. Variação contra o último fechamento.
const TD_AO_VIVO = "https://www.tesourodireto.com.br/o/rentabilidade/investir";
const UA_NAV = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36", Accept: "application/json" };
const taxaDe = (s: string) => { const m = String(s ?? "").match(/(-?[\d.]+,\d+)%?\s*$/); return m ? num(m[1]) : null; };

export function tesouro(): Promise<Titulo[]> {
  return cached("tesouro-vivo", 5 * 60_000, async () => {
    const fechamento = await tesouroFechamento().catch(() => [] as Titulo[]);
    try {
      const r = await fetch(TD_AO_VIVO, { headers: UA_NAV });
      if (!r.ok) throw new Error(`TD ${r.status}`);
      const j = await r.json();
      const ant = new Map(fechamento.map((t) => [`${t.tipo}|${t.vencimento}`, t.taxa]));
      // deno-lint-ignore no-explicit-any
      const lista: Titulo[] = (j?.TesouroLegado ?? []).map((x: any) => {
        const nome = String(x.treasuryBondName ?? "");
        const tipo = nome.replace(/\s+\d{4}$/, "");
        const [y, m, d] = String(x.maturityDate ?? "").slice(0, 10).split("-");
        const venc = `${d}/${m}/${y}`;
        const quando = String(x.lastMarketPricingDate ?? "");
        const [dy, dm, dd] = quando.slice(0, 10).split("-");
        return {
          tipo, vencimento: venc, taxa: taxaDe(x.investmentProfitabilityIndexerName),
          taxaAnterior: ant.get(`${tipo}|${venc}`) ?? null, pu: Number(x.unitaryInvestmentValue) || null,
          data: `${dd}/${dm}/${dy}`, hora: quando.slice(11, 16), aoVivo: true,
        };
      }).filter((t: Titulo) => TIPOS.includes(t.tipo) && t.taxa != null)
        .sort((a: Titulo, b: Titulo) => TIPOS.indexOf(a.tipo) - TIPOS.indexOf(b.tipo) || ymd(a.vencimento).localeCompare(ymd(b.vencimento)));
      if (lista.length) return lista;
    } catch (_e) { /* cai para o último fechamento */ }
    return fechamento;
  });
}

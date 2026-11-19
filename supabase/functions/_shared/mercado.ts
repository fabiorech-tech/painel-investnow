// Fontes de dados de mercado usadas pelas funções do painel.
// Binance (cripto e câmbio via stablecoin): dados públicos, sem chave.
// Yahoo Finance (B3 e EUA): gratuito, com atraso (B3 ~15 min).
// Banco Central SGS (renda fixa): Selic, CDI, IPCA.

const UA = { "User-Agent": "Mozilla/5.0 (painel-investnow)" };
const BINANCE = "https://data-api.binance.vision/api/v3";

export type Ativo = {
  simbolo: string;
  nome: string;
  classe: string;
  fonte: "binance" | "yahoo" | "bcb";
  codigo: string;
};

export type Cotacao = {
  simbolo: string;
  preco: number | null;
  anterior: number | null;
  variacao: number | null; // %
  volume: number | null; // volume de hoje (ou 24h para Binance)
  volumeMedio: number | null; // média diária dos últimos 20 pregões
  hora: number | null; // epoch ms da última cotação
  data?: string;
};

export type Vela = { t: number; o: number; h: number; l: number; c: number; v: number };

const cache = new Map<string, { at: number; val: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val as T;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  return val;
}

async function getJson(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} em ${new URL(url).host}`);
  return r.json();
}

const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

async function cotacaoYahoo(a: Ativo): Promise<Cotacao> {
  return cached(`yq:${a.codigo}`, 30_000, async () => {
    const j = await getJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(a.codigo)}?interval=1d&range=2mo`,
    );
    const r = j?.chart?.result?.[0];
    const m = r?.meta ?? {};
    const vols: number[] = (r?.indicators?.quote?.[0]?.volume ?? []).filter((v: number | null) => v != null);
    const preco = m.regularMarketPrice ?? null;
    const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
    // fechamento anterior = penúltimo fechamento diário válido
    const validos = closes.filter((c) => c != null) as number[];
    const anterior = validos.length >= 2 ? validos[validos.length - 2] : (m.chartPreviousClose ?? null);
    const hoje = vols.length ? vols[vols.length - 1] : (m.regularMarketVolume ?? null);
    return {
      simbolo: a.simbolo,
      preco,
      anterior,
      variacao: preco != null && anterior ? ((preco - anterior) / anterior) * 100 : null,
      volume: m.regularMarketVolume || hoje,
      volumeMedio: media(vols.slice(-21, -1)),
      hora: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
    };
  });
}

async function cotacaoBinance(a: Ativo): Promise<Cotacao> {
  return cached(`bq:${a.codigo}`, 10_000, async () => {
    const [t, k] = await Promise.all([
      getJson(`${BINANCE}/ticker/24hr?symbol=${a.codigo}`),
      cached(`bk:${a.codigo}`, 3_600_000, () => getJson(`${BINANCE}/klines?symbol=${a.codigo}&interval=1d&limit=21`)),
    ]);
    const vols = (k as unknown[][]).slice(0, -1).map((x) => Number(x[7]));
    return {
      simbolo: a.simbolo,
      preco: Number(t.lastPrice),
      anterior: Number(t.prevClosePrice) || Number(t.openPrice),
      variacao: Number(t.priceChangePercent),
      volume: Number(t.quoteVolume),
      volumeMedio: media(vols),
      hora: t.closeTime,
    };
  });
}

async function cotacaoBcb(a: Ativo): Promise<Cotacao> {
  return cached(`bcb:${a.codigo}`, 3_600_000, async () => {
    const j = await getJson(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${a.codigo}/dados/ultimos/2?formato=json`);
    const ult = j[j.length - 1];
    const ant = j.length > 1 ? j[j.length - 2] : null;
    const preco = Number(ult.valor);
    const anterior = ant ? Number(ant.valor) : null;
    const [d, mm, y] = String(ult.data).split("/");
    return {
      simbolo: a.simbolo,
      preco,
      anterior,
      variacao: anterior != null ? preco - anterior : null, // em pontos percentuais
      volume: null,
      volumeMedio: null,
      hora: Date.parse(`${y}-${mm}-${d}T12:00:00-03:00`),
      data: ult.data,
    };
  });
}

export async function cotacao(a: Ativo): Promise<Cotacao> {
  try {
    if (a.fonte === "binance") return await cotacaoBinance(a);
    if (a.fonte === "yahoo") return await cotacaoYahoo(a);
    return await cotacaoBcb(a);
  } catch (_e) {
    return { simbolo: a.simbolo, preco: null, anterior: null, variacao: null, volume: null, volumeMedio: null, hora: null };
  }
}

const YAHOO_INTERVALOS: Record<string, [string, string]> = {
  "1m": ["1m", "1d"],
  "5m": ["5m", "5d"],
  "15m": ["15m", "1mo"],
  "1h": ["60m", "3mo"],
  "1d": ["1d", "2y"],
};

export async function velas(a: Ativo, intervalo: string): Promise<Vela[]> {
  if (a.fonte === "yahoo") {
    const [iv, rg] = YAHOO_INTERVALOS[intervalo] ?? YAHOO_INTERVALOS["1d"];
    return cached(`yv:${a.codigo}:${iv}`, 30_000, async () => {
      const j = await getJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(a.codigo)}?interval=${iv}&range=${rg}`,
      );
      const r = j?.chart?.result?.[0];
      const ts: number[] = r?.timestamp ?? [];
      const q = r?.indicators?.quote?.[0] ?? {};
      const out: Vela[] = [];
      ts.forEach((t, i) => {
        if (q.open?.[i] == null || q.close?.[i] == null) return;
        out.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0 });
      });
      return out;
    });
  }
  if (a.fonte === "bcb") {
    return cached(`bv:${a.codigo}`, 3_600_000, async () => {
      const j = await getJson(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${a.codigo}/dados/ultimos/250?formato=json`);
      return (j as { data: string; valor: string }[]).map((x) => {
        const [d, m, y] = x.data.split("/");
        const v = Number(x.valor);
        return { t: Date.parse(`${y}-${m}-${d}T12:00:00-03:00`), o: v, h: v, l: v, c: v, v: 0 };
      });
    });
  }
  const k = await getJson(`${BINANCE}/klines?symbol=${a.codigo}&interval=${intervalo}&limit=500`);
  return (k as unknown[][]).map((x) => ({
    t: Number(x[0]), o: +x[1]!, h: +x[2]!, l: +x[3]!, c: +x[4]!, v: +x[5]!,
  }));
}

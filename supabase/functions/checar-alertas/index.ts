// Chamada pelo pg_cron a cada minuto. Avalia os alertas ativos e envia
// por e-mail (Resend) e WhatsApp (CallMeBot) quando as chaves estão configuradas.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { type Ativo, type Cotacao, cotacao } from "./mercado.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Alerta = {
  id: number; simbolo: string; tipo: string; valor: number;
  email: boolean; whatsapp: boolean; ativo: boolean; ultimo_disparo: string | null;
};

const fmt = (n: number, d = 2) => n.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const diaBR = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

function avaliar(a: Alerta, at: Ativo, q: Cotacao): string | null {
  if (q.preco == null) return null;
  const nome = `${at.simbolo} (${at.nome})`;
  const pr = fmt(q.preco, q.preco < 10 ? 4 : 2);
  switch (a.tipo) {
    case "preco_acima":
      return q.preco >= a.valor ? `${nome} subiu para ${pr}, acima do alvo de ${fmt(a.valor)}.` : null;
    case "preco_abaixo":
      return q.preco <= a.valor ? `${nome} caiu para ${pr}, abaixo do alvo de ${fmt(a.valor)}.` : null;
    case "variacao":
      if (q.variacao == null || Math.abs(q.variacao) < a.valor) return null;
      return `${nome} ${q.variacao >= 0 ? "sobe" : "cai"} ${fmt(Math.abs(q.variacao))}% no dia (limite ${fmt(a.valor)}%). Preço ${pr}.`;
    case "volume":
      if (!q.volume || !q.volumeMedio) return null;
      if (q.volume < a.valor * q.volumeMedio) return null;
      return `${nome} com volume ${fmt(q.volume / q.volumeMedio, 1)}x a média de 20 dias (limite ${fmt(a.valor, 1)}x). Preço ${pr}.`;
  }
  return null;
}

// Alvo de preço: dispara uma vez e desliga. Variação e volume: no máximo uma vez por dia.
function podeDisparar(a: Alerta) {
  if (!a.ultimo_disparo) return true;
  if (a.tipo.startsWith("preco")) return false;
  return diaBR(new Date(a.ultimo_disparo)) !== diaBR(new Date());
}

async function enviarEmail(cfg: Record<string, string>, assunto: string, corpo: string) {
  if (!cfg.resend_key) throw new Error("e-mail não configurado");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.resend_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cfg.resend_from || "Painel InvestNow <onboarding@resend.dev>",
      to: [cfg.alerta_email],
      subject: assunto,
      text: corpo + "\n\nPainel InvestNow",
    }),
  });
  if (!r.ok) throw new Error(`e-mail ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function enviarWhatsapp(cfg: Record<string, string>, corpo: string) {
  if (!cfg.callmebot_key) throw new Error("WhatsApp não configurado");
  const u = new URL("https://api.callmebot.com/whatsapp.php");
  u.searchParams.set("phone", cfg.alerta_whatsapp);
  u.searchParams.set("text", corpo);
  u.searchParams.set("apikey", cfg.callmebot_key);
  const r = await fetch(u);
  const t = await r.text();
  if (!r.ok || /error|invalid/i.test(t.slice(0, 500))) throw new Error(`WhatsApp ${r.status}: ${t.replace(/<[^>]+>/g, " ").trim().slice(0, 200)}`);
}

Deno.serve(async (req) => {
  const { data: cfgRows } = await db.from("config").select("chave, valor");
  const cfg = Object.fromEntries((cfgRows ?? []).map((r) => [r.chave, r.valor])) as Record<string, string>;
  if (req.headers.get("x-cron-secret") !== cfg.cron_secret) return new Response("negado", { status: 401 });

  const teste = new URL(req.url).searchParams.get("teste") === "1";
  const { data: alertas } = await db.from("alertas").select("*").eq("ativo", true);
  const { data: ativos } = await db.from("ativos").select("*");
  const porSimbolo = new Map((ativos as Ativo[]).map((a) => [a.simbolo, a]));

  const resultados: unknown[] = [];
  const pendentes = (alertas as Alerta[] ?? []).filter(podeDisparar);
  const simbolos = [...new Set(pendentes.map((a) => a.simbolo))];
  const cotacoes = new Map(
    await Promise.all(simbolos.map(async (s) => [s, await cotacao(porSimbolo.get(s)!)] as const)),
  );

  const mensagens: { alerta?: Alerta; simbolo: string; msg: string }[] = [];
  if (teste) mensagens.push({ simbolo: "TESTE", msg: "Teste do Painel InvestNow: os alertas estão chegando." });
  for (const a of pendentes) {
    const at = porSimbolo.get(a.simbolo);
    const q = cotacoes.get(a.simbolo);
    if (!at || !q) continue;
    const msg = avaliar(a, at, q);
    if (msg) mensagens.push({ alerta: a, simbolo: a.simbolo, msg });
  }

  for (const m of mensagens) {
    const canais: string[] = [];
    const erros: string[] = [];
    const querEmail = m.alerta ? m.alerta.email : true;
    const querZap = m.alerta ? m.alerta.whatsapp : true;
    if (querEmail) {
      try { await enviarEmail(cfg, `Alerta ${m.simbolo}`, m.msg); canais.push("e-mail"); } catch (e) { erros.push(String((e as Error).message)); }
    }
    if (querZap) {
      try { await enviarWhatsapp(cfg, `🔔 ${m.msg}`); canais.push("WhatsApp"); } catch (e) { erros.push(String((e as Error).message)); }
    }
    await db.from("disparos").insert({
      alerta_id: m.alerta?.id ?? null, simbolo: m.simbolo, mensagem: m.msg,
      canais: canais.join(", "), erro: erros.length ? erros.join(" | ") : null,
    });
    if (m.alerta) {
      const upd: Record<string, unknown> = { ultimo_disparo: new Date().toISOString() };
      if (m.alerta.tipo.startsWith("preco")) upd.ativo = false;
      await db.from("alertas").update(upd).eq("id", m.alerta.id);
    }
    resultados.push({ simbolo: m.simbolo, canais, erros });
  }

  return new Response(JSON.stringify({ avaliados: pendentes.length, disparados: resultados }), {
    headers: { "Content-Type": "application/json" },
  });
});

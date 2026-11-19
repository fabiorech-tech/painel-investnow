// Função única que o painel chama. Exige o código de acesso no cabeçalho
// `x-codigo`. Usa a service role para ler e gravar nas tabelas (RLS sem políticas).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { type Ativo, cotacao, velas } from "./mercado.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-codigo, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let codigoCache: { at: number; val: string } | null = null;
async function codigoAcesso() {
  if (codigoCache && Date.now() - codigoCache.at < 60_000) return codigoCache.val;
  const { data } = await db.from("config").select("valor").eq("chave", "codigo_acesso").single();
  codigoCache = { at: Date.now(), val: data?.valor ?? "" };
  return codigoCache.val;
}

async function listarAtivos(): Promise<Ativo[]> {
  const { data, error } = await db.from("ativos").select("*").order("ordem").order("simbolo");
  if (error) throw error;
  return data as Ativo[];
}

async function ativo(simbolo: string): Promise<Ativo> {
  const { data, error } = await db.from("ativos").select("*").eq("simbolo", simbolo).single();
  if (error || !data) throw new Error("Ativo não encontrado");
  return data as Ativo;
}

const texto = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);
const numero = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Informe um número maior que zero");
  return n;
};

async function tratar(acao: string, p: Record<string, unknown>) {
  switch (acao) {
    case "entrar":
      return { ok: true };

    case "ativos":
      return await listarAtivos();

    case "cotacoes": {
      // Só fontes com atraso ou diárias: cripto e câmbio chegam direto da Binance no navegador.
      const lista = (await listarAtivos()).filter((a) => a.fonte !== "binance" || p.todas);
      return await Promise.all(lista.map(cotacao));
    }

    case "velas":
      return await velas(await ativo(texto(p.simbolo, 20)), texto(p.intervalo, 4) || "1d");

    case "ativo_adicionar": {
      const classe = texto(p.classe, 12);
      const simbolo = texto(p.simbolo, 20).toUpperCase().replace(/[^A-Z0-9^.=-]/g, "");
      if (!simbolo) throw new Error("Informe o código do ativo");
      let fonte = "yahoo";
      let codigo = simbolo;
      if (classe === "b3") codigo = simbolo.startsWith("^") ? simbolo : `${simbolo}.SA`;
      else if (classe === "cripto") { fonte = "binance"; codigo = simbolo.endsWith("USDT") ? simbolo : `${simbolo}USDT`; }
      else if (classe === "cambio") { fonte = "binance"; codigo = simbolo; }
      else if (classe === "rendafixa") { fonte = "bcb"; codigo = texto(p.codigo, 10); }
      else if (classe !== "eua") throw new Error("Classe inválida");
      const novo = { simbolo: simbolo.replace(/^\^/, "").replace(/USDT$/, "") || simbolo, nome: texto(p.nome, 60) || simbolo, classe, fonte, codigo, ordem: 200 };
      const teste = await cotacao(novo as Ativo);
      if (teste.preco == null) throw new Error(`Não encontrei cotação para ${codigo}. Confira o código.`);
      const { error } = await db.from("ativos").insert(novo);
      if (error) throw new Error(error.code === "23505" ? "Esse ativo já está na lista" : error.message);
      return novo;
    }

    case "ativo_remover": {
      const { error } = await db.from("ativos").delete().eq("simbolo", texto(p.simbolo, 20));
      if (error) throw error;
      return { ok: true };
    }

    case "decisoes": {
      const { data, error } = await db.from("decisoes").select("*").order("criado_em", { ascending: false }).limit(300);
      if (error) throw error;
      return data;
    }

    case "decisao_adicionar": {
      const lado = texto(p.lado, 10);
      if (lado !== "compra" && lado !== "venda") throw new Error("Escolha compra ou venda");
      const reg = {
        simbolo: texto(p.simbolo, 20), lado, preco: numero(p.preco), quantidade: numero(p.quantidade),
        motivo: texto(p.motivo, 1000), autor: texto(p.autor, 60),
      };
      const { data, error } = await db.from("decisoes").insert(reg).select().single();
      if (error) throw error;
      return data;
    }

    case "decisao_remover": {
      const { error } = await db.from("decisoes").delete().eq("id", Number(p.id));
      if (error) throw error;
      return { ok: true };
    }

    case "alertas": {
      const { data, error } = await db.from("alertas").select("*").order("criado_em", { ascending: false });
      if (error) throw error;
      return data;
    }

    case "alerta_adicionar": {
      const tipo = texto(p.tipo, 20);
      if (!["variacao", "preco_acima", "preco_abaixo", "volume"].includes(tipo)) throw new Error("Tipo de alerta inválido");
      const reg = {
        simbolo: texto(p.simbolo, 20), tipo, valor: numero(p.valor),
        email: p.email !== false, whatsapp: p.whatsapp !== false,
      };
      const { data, error } = await db.from("alertas").insert(reg).select().single();
      if (error) throw error;
      return data;
    }

    case "alerta_alternar": {
      const { error } = await db.from("alertas").update({ ativo: !!p.ativo, ultimo_disparo: null }).eq("id", Number(p.id));
      if (error) throw error;
      return { ok: true };
    }

    case "alerta_remover": {
      const { error } = await db.from("alertas").delete().eq("id", Number(p.id));
      if (error) throw error;
      return { ok: true };
    }

    case "disparos": {
      const { data, error } = await db.from("disparos").select("*").order("criado_em", { ascending: false }).limit(100);
      if (error) throw error;
      return data;
    }
  }
  throw new Error("Ação desconhecida");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Use POST" }, 405);
  const codigo = req.headers.get("x-codigo") ?? "";
  if (!codigo || codigo !== (await codigoAcesso())) return json({ erro: "Código de acesso incorreto" }, 401);
  try {
    const { acao, ...params } = await req.json();
    return json({ dados: await tratar(String(acao), params) });
  } catch (e) {
    return json({ erro: e instanceof Error ? e.message : String(e) }, 400);
  }
});

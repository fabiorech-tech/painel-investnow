// Função única que o painel chama. Cada pessoa entra com usuário e senha (ação `entrar`)
// e recebe um token de sessão, enviado depois no cabeçalho `x-sessao`.
// Usa a service role para ler e gravar nas tabelas (RLS sem políticas).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { type Ativo, cotacao, velas } from "./mercado.ts";
import { indicadores, noticias, tesouro } from "./extras.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-sessao, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Usuario = { id: number; nome: string; login: string; admin: boolean; trocar_senha: boolean };
class NaoAutorizado extends Error {}

const sessoes = new Map<string, { at: number; u: Usuario }>();
async function usuarioDaSessao(token: string): Promise<Usuario> {
  if (!/^[0-9a-f]{48}$/.test(token)) throw new NaoAutorizado("Entre com seu usuário e senha");
  const hit = sessoes.get(token);
  if (hit && Date.now() - hit.at < 20_000) return hit.u;
  const { data } = await db.from("sessoes")
    .select("expira_em, usuarios!inner(id, nome, login, admin, ativo, trocar_senha)")
    .eq("token", token).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const u = (data as any)?.usuarios;
  if (!data || !u?.ativo || new Date(data.expira_em) < new Date()) {
    sessoes.delete(token);
    throw new NaoAutorizado("Sua sessão expirou. Entre de novo.");
  }
  const usuario = { id: u.id, nome: u.nome, login: u.login, admin: u.admin, trocar_senha: u.trocar_senha };
  sessoes.set(token, { at: Date.now(), u: usuario });
  return usuario;
}

function senhaProvisoria() {
  const letras = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(b, (x) => letras[x % letras.length]).join("");
}
const exigirAdmin = (u: Usuario) => { if (!u.admin) throw new Error("Só administradores podem fazer isso"); };
async function derrubarSessoes(id: number) {
  await db.from("sessoes").delete().eq("usuario_id", id);
  for (const [t, v] of sessoes) if (v.u.id === id) sessoes.delete(t);
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

async function tratar(acao: string, p: Record<string, unknown>, eu: Usuario, token: string) {
  if (eu.trocar_senha && !["eu", "senha_trocar", "sair"].includes(acao)) throw new Error("Troque sua senha provisória primeiro");
  switch (acao) {
    case "eu":
      return eu;

    case "sair":
      await db.from("sessoes").delete().eq("token", token);
      sessoes.delete(token);
      return { ok: true };

    case "senha_trocar": {
      const senha = String(p.senha ?? "");
      if (senha.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres");
      if (senha.length > 72) throw new Error("Senha longa demais");
      const { error } = await db.rpc("login_senha", { p_id: eu.id, p_senha: senha, p_trocar: false });
      if (error) throw error;
      sessoes.delete(token);
      return { ...eu, trocar_senha: false };
    }

    case "usuarios": {
      exigirAdmin(eu);
      const { data, error } = await db.from("usuarios").select("id, nome, login, admin, ativo, trocar_senha, criado_em, ultimo_acesso").order("nome");
      if (error) throw error;
      return data;
    }

    case "usuario_criar": {
      exigirAdmin(eu);
      const nome = texto(p.nome, 60);
      const login = texto(p.login, 80).toLowerCase().replace(/\s+/g, "");
      if (!nome || login.length < 2) throw new Error("Informe nome e usuário");
      if (!/^[a-z0-9._@-]+$/.test(login)) throw new Error("Usuário só pode ter letras, números, ponto, hífen, _ e @");
      const senha = senhaProvisoria();
      const { error } = await db.rpc("login_criar", { p_nome: nome, p_login: login, p_senha: senha, p_admin: !!p.admin });
      if (error) throw new Error(error.code === "23505" ? "Esse usuário já existe" : error.message);
      return { login, senha };
    }

    case "usuario_resetar": {
      exigirAdmin(eu);
      const id = Number(p.id);
      const senha = senhaProvisoria();
      const { error } = await db.rpc("login_senha", { p_id: id, p_senha: senha, p_trocar: true });
      if (error) throw error;
      await derrubarSessoes(id);
      const { data } = await db.from("usuarios").select("login").eq("id", id).single();
      return { login: data?.login, senha };
    }

    case "usuario_alterar": {
      exigirAdmin(eu);
      const id = Number(p.id);
      if (id === eu.id) throw new Error("Você não pode desativar nem tirar o admin de si mesmo");
      const mud: Record<string, boolean> = {};
      if (typeof p.ativo === "boolean") mud.ativo = p.ativo;
      if (typeof p.admin === "boolean") mud.admin = p.admin;
      const { error } = await db.from("usuarios").update(mud).eq("id", id);
      if (error) throw error;
      await derrubarSessoes(id);
      return { ok: true };
    }

    case "ativos":
      return await listarAtivos();

    case "cotacoes": {
      // Só fontes com atraso ou diárias: cripto e câmbio chegam direto da Binance no navegador.
      const lista = (await listarAtivos()).filter((a) => a.fonte !== "binance" || p.todas);
      return await Promise.all(lista.map(cotacao));
    }

    case "indicadores":
      return await indicadores();

    case "tesouro":
      return await tesouro();

    case "noticias":
      return await noticias();

    case "velas":
      return await velas(await ativo(texto(p.simbolo, 20)), texto(p.intervalo, 4) || "1d");

    case "ativo_adicionar": {
      exigirAdmin(eu);
      const classe = texto(p.classe, 12);
      const simbolo = texto(p.simbolo, 20).toUpperCase().replace(/[^A-Z0-9^.=-]/g, "");
      if (!simbolo) throw new Error("Informe o código do ativo");
      let fonte = "yahoo";
      let codigo = simbolo;
      if (classe === "b3") codigo = simbolo.startsWith("^") ? simbolo : `${simbolo}.SA`;
      else if (classe === "cripto") { fonte = "binance"; codigo = simbolo.endsWith("USDT") ? simbolo : `${simbolo}USDT`; }
      else if (classe === "cambio") { fonte = "binance"; codigo = simbolo; }
      else if (classe === "rendafixa") { fonte = "bcb"; codigo = texto(p.codigo, 10); }
      else if (classe === "treasury") { codigo = simbolo.startsWith("^") ? simbolo : `^${simbolo}`; }
      else if (classe === "commodities") { codigo = simbolo.includes("=") ? simbolo : `${simbolo}=F`; }
      else if (classe !== "eua") throw new Error("Classe inválida");
      const novo = { simbolo: simbolo.replace(/^\^/, "").replace(/USDT$/, "").replace(/=F$/, "") || simbolo, nome: texto(p.nome, 60) || simbolo, classe, fonte, codigo, ordem: 200 };
      const teste = await cotacao(novo as Ativo);
      if (teste.preco == null) throw new Error(`Não encontrei cotação para ${codigo}. Confira o código.`);
      const { error } = await db.from("ativos").insert(novo);
      if (error) throw new Error(error.code === "23505" ? "Esse ativo já está na lista" : error.message);
      return novo;
    }

    case "ativo_remover": {
      exigirAdmin(eu);
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
        motivo: texto(p.motivo, 1000), autor: eu.nome, usuario_id: eu.id,
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
      if (!["variacao", "preco_acima", "preco_abaixo", "volume", "taxa_acima", "taxa_abaixo"].includes(tipo)) throw new Error("Tipo de alerta inválido");
      const simbolo = texto(p.simbolo, 80);
      const td = simbolo.startsWith("TD|");
      if (td !== tipo.startsWith("taxa_")) throw new Error("Para títulos do Tesouro, use taxa sobe até ou taxa cai até");
      if (td && !(await tesouro()).some((t) => `TD|${t.tipo}|${t.vencimento}` === simbolo)) throw new Error("Título do Tesouro não encontrado");
      if (!td) await ativo(simbolo);
      const reg = {
        simbolo, tipo, valor: numero(p.valor),
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
  try {
    const { acao, ...params } = await req.json();
    if (acao === "entrar") {
      const { data, error } = await db.rpc("login_entrar", { p_login: texto(params.login, 80), p_senha: String(params.senha ?? "").slice(0, 72) });
      if (error) throw error;
      const r = Array.isArray(data) ? data[0] : null;
      if (!r) return json({ erro: "Usuário ou senha incorretos" }, 401);
      const { token, ...u } = r;
      return json({ dados: { token, usuario: u } });
    }
    const token = req.headers.get("x-sessao") ?? "";
    const eu = await usuarioDaSessao(token);
    return json({ dados: await tratar(String(acao), params, eu, token) });
  } catch (e) {
    if (e instanceof NaoAutorizado) return json({ erro: e.message }, 401);
    return json({ erro: e instanceof Error ? e.message : String(e) }, 400);
  }
});

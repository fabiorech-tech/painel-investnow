-- Alertas também para títulos do Tesouro Direto (taxa sobe/cai até um alvo).
-- O símbolo desses alertas é "TD|<tipo>|<vencimento>", que não existe na tabela de ativos.
alter table public.alertas drop constraint if exists alertas_simbolo_fkey;
alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('variacao','preco_acima','preco_abaixo','volume','taxa_acima','taxa_abaixo'));

-- Clientes que autorizaram receber alertas (WhatsApp Business / e-mail).
create table if not exists public.clientes (
  id bigint generated always as identity primary key,
  nome text not null,
  whatsapp text not null default '',
  email text not null default '',
  autorizou_em date,
  ativo boolean not null default true,
  criado_por bigint references public.usuarios(id) on delete set null,
  criado_em timestamptz not null default now()
);
alter table public.clientes enable row level security;
alter table public.alertas add column if not exists clientes bigint[] not null default '{}';
alter table public.disparos add column if not exists clientes_enviados int not null default 0;

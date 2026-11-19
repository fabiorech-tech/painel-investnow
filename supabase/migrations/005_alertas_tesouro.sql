-- Alertas também para títulos do Tesouro Direto (taxa sobe/cai até um alvo).
-- O símbolo desses alertas é "TD|<tipo>|<vencimento>", que não existe na tabela de ativos.
alter table public.alertas drop constraint if exists alertas_simbolo_fkey;
alter table public.alertas drop constraint if exists alertas_tipo_check;
alter table public.alertas add constraint alertas_tipo_check
  check (tipo in ('variacao','preco_acima','preco_abaixo','volume','taxa_acima','taxa_abaixo'));

-- Login individual para o time. Senhas com bcrypt (pgcrypto), sessões por token.
-- Só a service role (edge function `api`) acessa: RLS sem políticas e funções sem grant público.

create extension if not exists pgcrypto with schema extensions;

create table public.usuarios (
  id bigint generated always as identity primary key,
  nome text not null,
  login text not null unique check (login = lower(login) and length(login) between 2 and 80),
  senha_hash text not null,
  admin boolean not null default false,
  ativo boolean not null default true,
  trocar_senha boolean not null default true,
  criado_em timestamptz not null default now(),
  ultimo_acesso timestamptz
);

create table public.sessoes (
  token text primary key,
  usuario_id bigint not null references public.usuarios(id) on delete cascade,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '30 days'
);
create index on public.sessoes (usuario_id);

alter table public.usuarios enable row level security;
alter table public.sessoes enable row level security;

alter table public.decisoes add column usuario_id bigint references public.usuarios(id) on delete set null;

-- Confere login e senha; devolve um token novo ou nada.
create or replace function public.login_entrar(p_login text, p_senha text)
returns table (token text, id bigint, nome text, login text, admin boolean, trocar_senha boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare u public.usuarios;
declare t text;
begin
  select * into u from public.usuarios where usuarios.login = lower(trim(p_login)) and usuarios.ativo;
  if not found or u.senha_hash <> extensions.crypt(p_senha, u.senha_hash) then return; end if;
  t := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.sessoes (token, usuario_id) values (t, u.id);
  update public.usuarios set ultimo_acesso = now() where usuarios.id = u.id;
  delete from public.sessoes where expira_em < now();
  return query select t, u.id, u.nome, u.login, u.admin, u.trocar_senha;
end $$;

create or replace function public.login_senha(p_id bigint, p_senha text, p_trocar boolean)
returns void language sql security definer set search_path = public, extensions as $$
  update public.usuarios set senha_hash = extensions.crypt(p_senha, extensions.gen_salt('bf', 10)), trocar_senha = p_trocar where id = p_id;
$$;

create or replace function public.login_criar(p_nome text, p_login text, p_senha text, p_admin boolean)
returns bigint language sql security definer set search_path = public, extensions as $$
  insert into public.usuarios (nome, login, senha_hash, admin)
  values (p_nome, lower(trim(p_login)), extensions.crypt(p_senha, extensions.gen_salt('bf', 10)), p_admin)
  returning id;
$$;

revoke all on function public.login_entrar(text, text) from public, anon, authenticated;
revoke all on function public.login_senha(bigint, text, boolean) from public, anon, authenticated;
revoke all on function public.login_criar(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.login_entrar(text, text) to service_role;
grant execute on function public.login_senha(bigint, text, boolean) to service_role;
grant execute on function public.login_criar(text, text, text, boolean) to service_role;

-- Fabio vira o primeiro administrador. Senha inicial = antigo código de acesso; troca no primeiro login.
select public.login_criar('Fabio', 'fabio', (select valor from public.config where chave = 'codigo_acesso'), true);

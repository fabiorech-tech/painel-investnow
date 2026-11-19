-- Painel InvestNow: esquema inicial.
-- Todas as tabelas têm RLS ligado e nenhuma política: só as edge functions
-- (service role) leem e gravam. O navegador fala apenas com a função `api`.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table public.ativos (
  simbolo text primary key,
  nome text not null,
  classe text not null check (classe in ('b3','eua','cripto','cambio','rendafixa')),
  fonte text not null check (fonte in ('binance','yahoo','bcb')),
  codigo text not null,
  ordem int not null default 100,
  criado_em timestamptz not null default now()
);

create table public.decisoes (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  simbolo text not null references public.ativos(simbolo) on delete cascade,
  lado text not null check (lado in ('compra','venda')),
  preco numeric not null check (preco > 0),
  quantidade numeric not null check (quantidade > 0),
  motivo text not null default '',
  autor text not null default ''
);

create table public.alertas (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  simbolo text not null references public.ativos(simbolo) on delete cascade,
  tipo text not null check (tipo in ('variacao','preco_acima','preco_abaixo','volume')),
  valor numeric not null check (valor > 0),
  email boolean not null default true,
  whatsapp boolean not null default true,
  ativo boolean not null default true,
  ultimo_disparo timestamptz
);

create table public.disparos (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  alerta_id bigint references public.alertas(id) on delete set null,
  simbolo text not null,
  mensagem text not null,
  canais text not null default '',
  erro text
);

-- Configuração privada (código de acesso, chaves de envio). Nunca exposta.
create table public.config (
  chave text primary key,
  valor text not null
);

alter table public.ativos enable row level security;
alter table public.decisoes enable row level security;
alter table public.alertas enable row level security;
alter table public.disparos enable row level security;
alter table public.config enable row level security;

create index on public.decisoes (criado_em desc);
create index on public.disparos (criado_em desc);
create index on public.alertas (simbolo);

insert into public.ativos (simbolo, nome, classe, fonte, codigo, ordem) values
  ('IBOV',   'Ibovespa',            'b3',        'yahoo',   '^BVSP',    1),
  ('PETR4',  'Petrobras PN',        'b3',        'yahoo',   'PETR4.SA', 2),
  ('VALE3',  'Vale ON',             'b3',        'yahoo',   'VALE3.SA', 3),
  ('ITUB4',  'Itaú Unibanco PN',    'b3',        'yahoo',   'ITUB4.SA', 4),
  ('BBDC4',  'Bradesco PN',         'b3',        'yahoo',   'BBDC4.SA', 5),
  ('BBAS3',  'Banco do Brasil ON',  'b3',        'yahoo',   'BBAS3.SA', 6),
  ('WEGE3',  'WEG ON',              'b3',        'yahoo',   'WEGE3.SA', 7),
  ('B3SA3',  'B3 ON',               'b3',        'yahoo',   'B3SA3.SA', 8),
  ('SPX',    'S&P 500',             'eua',       'yahoo',   '^GSPC',    10),
  ('AAPL',   'Apple',               'eua',       'yahoo',   'AAPL',     11),
  ('MSFT',   'Microsoft',           'eua',       'yahoo',   'MSFT',     12),
  ('NVDA',   'Nvidia',              'eua',       'yahoo',   'NVDA',     13),
  ('AMZN',   'Amazon',              'eua',       'yahoo',   'AMZN',     14),
  ('BTC',    'Bitcoin',             'cripto',    'binance', 'BTCUSDT',  20),
  ('ETH',    'Ethereum',            'cripto',    'binance', 'ETHUSDT',  21),
  ('SOL',    'Solana',              'cripto',    'binance', 'SOLUSDT',  22),
  ('USDBRL', 'Dólar (USDT/BRL)',    'cambio',    'binance', 'USDTBRL',  30),
  ('EURUSD', 'Euro (EUR/USDT)',     'cambio',    'binance', 'EURUSDT',  31),
  ('SELIC',  'Selic meta (% a.a.)', 'rendafixa', 'bcb',     '432',      40),
  ('CDI',    'CDI (% a.a.)',        'rendafixa', 'bcb',     '4389',     41),
  ('IPCA12', 'IPCA 12 meses (%)',   'rendafixa', 'bcb',     '13522',    42);

insert into public.config (chave, valor) values
  ('codigo_acesso', encode(extensions.gen_random_bytes(5), 'hex')),
  ('cron_secret',   encode(extensions.gen_random_bytes(24), 'hex')),
  ('alerta_email',  'fabio.rech@gmail.com'),
  ('alerta_whatsapp', '5581999960007');

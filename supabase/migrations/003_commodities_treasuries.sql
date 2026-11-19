alter table public.ativos drop constraint ativos_classe_check;
alter table public.ativos add constraint ativos_classe_check check (classe in ('b3','eua','cripto','cambio','rendafixa','commodities','treasury'));
insert into public.ativos (simbolo, nome, classe, fonte, codigo, ordem) values
  ('CL',  'Petróleo WTI (US$/barril)',   'commodities', 'yahoo', 'CL=F', 50),
  ('BZ',  'Petróleo Brent (US$/barril)', 'commodities', 'yahoo', 'BZ=F', 51),
  ('GC',  'Ouro (US$/onça)',             'commodities', 'yahoo', 'GC=F', 52),
  ('SI',  'Prata (US$/onça)',            'commodities', 'yahoo', 'SI=F', 53),
  ('HG',  'Cobre (US$/libra)',           'commodities', 'yahoo', 'HG=F', 54),
  ('ZS',  'Soja (US¢/bushel)',           'commodities', 'yahoo', 'ZS=F', 55),
  ('ZC',  'Milho (US¢/bushel)',          'commodities', 'yahoo', 'ZC=F', 56),
  ('KC',  'Café arábica (US¢/libra)',    'commodities', 'yahoo', 'KC=F', 57),
  ('LE',  'Boi gordo CME (US¢/libra)',   'commodities', 'yahoo', 'LE=F', 58),
  ('IRX', 'Treasury 13 semanas',         'treasury',    'yahoo', '^IRX', 60),
  ('FVX', 'Treasury 5 anos',             'treasury',    'yahoo', '^FVX', 61),
  ('TNX', 'Treasury 10 anos',            'treasury',    'yahoo', '^TNX', 62),
  ('TYX', 'Treasury 30 anos',            'treasury',    'yahoo', '^TYX', 63);

-- Checa os alertas a cada minuto chamando a função checar-alertas.
select cron.schedule('checar-alertas', '* * * * *', $$
  select net.http_post(
    url := 'https://pdcdyajhyfylsxwjfwdy.supabase.co/functions/v1/checar-alertas',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select valor from public.config where chave='cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
$$);
select cron.schedule('limpar-net', '0 4 * * *', $$ delete from net._http_response where created < now() - interval '1 day' $$);

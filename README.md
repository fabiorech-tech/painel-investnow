# Painel InvestNow

Painel de observação do escritório InvestNow: lista de ativos com preço e variação, gráfico de velas, registro de decisões de compra e venda (sem envio de ordens) e alertas por WhatsApp e e-mail.

## Como funciona

- `web/`: o site (HTML, CSS e JS puros), publicado no GitHub Pages a cada push na `main`.
- `supabase/functions/api`: função que o site chama para cotações com atraso, velas, decisões, alertas e lista de ativos. Exige o código de acesso no cabeçalho `x-codigo`.
- `supabase/functions/checar-alertas`: roda a cada minuto pelo `pg_cron` e envia os alertas.
- `supabase/migrations/`: esquema do banco.

## Fontes de dados (fase 1)

| Classe | Fonte | Atualização |
|---|---|---|
| Cripto | Binance (WebSocket público) | tick a tick |
| Câmbio | Binance (pares com USDT) | tick a tick |
| Ações B3 | Yahoo Finance | ~15 min de atraso |
| EUA | Yahoo Finance | atraso |
| Renda fixa | Banco Central (SGS) | diário |

Tempo real da B3 e dos EUA depende de licença de dados (Nelogica, Interactive Brokers) e fica para a fase 2.

## Configuração privada

Fica na tabela `config` do Supabase (RLS sem políticas, só a service role lê): `codigo_acesso`, `cron_secret`, `alerta_email`, `alerta_whatsapp`, `resend_key`, `resend_from`, `callmebot_key`.

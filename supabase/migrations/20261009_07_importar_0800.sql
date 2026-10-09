-- Importación diaria a las 8:00 hora de Madrid (sustituye a la de 7:30).
-- 6:00 UTC en verano y 7:00 UTC en invierno; la función solo actúa si en Madrid son las 8 (?hora=8).
select cron.unschedule('fab_importar_0730');
select cron.schedule('fab_importar_0800', '0 6,7 * * *', $$
  select net.http_post(
    url := 'https://hgvsrmywsfnmvenkfynb.supabase.co/functions/v1/fab?hora=8',
    headers := jsonb_build_object('Content-Type','application/json','x-fab-cron', public.read_secret('fab_cron_key')),
    body := '{"accion":"importar"}'::jsonb,
    timeout_milliseconds := 150000);
$$);

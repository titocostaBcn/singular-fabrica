-- Solo los emails de fab_usuarios pueden ver la pantalla (aunque alguien cree una cuenta en Supabase).
create table if not exists public.fab_usuarios (email text primary key, nombre text, creado_at timestamptz not null default now());
alter table public.fab_usuarios enable row level security;

create or replace function public.fab_es_usuario() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fab_usuarios where lower(email) = lower(auth.jwt()->>'email'));
$$;
revoke execute on function public.fab_es_usuario() from public, anon;
grant execute on function public.fab_es_usuario() to authenticated, service_role;

alter policy fab_pedidos_leer on public.fab_pedidos using (public.fab_es_usuario());
alter policy fab_lineas_leer  on public.fab_lineas  using (public.fab_es_usuario());
alter policy fab_eventos_leer on public.fab_eventos using (public.fab_es_usuario());
alter policy fab_config_leer  on public.fab_config  using (public.fab_es_usuario());
create policy fab_usuarios_leer on public.fab_usuarios for select to authenticated using (public.fab_es_usuario());

insert into public.fab_usuarios (email, nombre) values ('fabrica@singularwardrobe.com', 'Pantalla fábrica')
  on conflict do nothing;

-- Importación diaria 7:30 hora de Madrid (5:30 UTC en verano, 6:30 UTC en invierno; la función solo actúa si en Madrid son las 7).
select cron.schedule('fab_importar_0730', '30 5,6 * * *', $$
  select net.http_post(
    url := 'https://hgvsrmywsfnmvenkfynb.supabase.co/functions/v1/fab?solo7=1',
    headers := jsonb_build_object('Content-Type','application/json','x-fab-cron', public.read_secret('fab_cron_key')),
    body := '{"accion":"importar"}'::jsonb,
    timeout_milliseconds := 150000);
$$);

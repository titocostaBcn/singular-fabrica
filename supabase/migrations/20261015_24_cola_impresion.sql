-- Cola de impresión (15-oct-2026, pedido de Tito: imprimir en la Honeywell de Expedición desde el iPhone o la tablet).
-- El iPhone no puede imprimir en la Honeywell (no tiene AirPrint). En su lugar, el móvil deja la etiqueta en esta cola
-- y el ordenador de Expedición marcado como «impresora» (localStorage fab_impresion = 'servidor') la coge y la imprime
-- con su Chrome (--kiosk-printing, 10x15). Dos ordenadores-impresora a la vez no imprimen dos veces: fab_cola_coger
-- reserva con «for update skip locked». Los encargos de hace más de 30 min no se imprimen (el móvil avisa).

create table if not exists public.fab_cola_impresion (
  id bigserial primary key,
  order_id bigint not null,
  pedido_por text,
  pedido_at timestamptz not null default now(),
  cogido_por text,
  cogido_at timestamptz,
  impreso_at timestamptz,
  error text
);
create index if not exists fab_cola_impresion_pend on public.fab_cola_impresion (pedido_at) where impreso_at is null and error is null;
alter table public.fab_cola_impresion enable row level security;
create policy fab_cola_impresion_usuarios on public.fab_cola_impresion for select to authenticated using (public.fab_es_usuario());
grant select on public.fab_cola_impresion to authenticated;

insert into public.fab_config (clave, valor, nota) values
  ('impresora_ultimo', '', 'Última vez que el ordenador-impresora de Expedición miró la cola (lo pone solo)')
on conflict (clave) do nothing;

-- El móvil manda una etiqueta a la cola
create or replace function public.fab_cola_mandar(p_order_id bigint)
returns bigint language plpgsql security definer set search_path to '' as $$
declare i bigint;
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  insert into public.fab_cola_impresion (order_id, pedido_por) values (p_order_id, auth.jwt()->>'email') returning id into i;
  insert into public.fab_eventos (order_id, tipo, detalle, usuario) values (p_order_id, 'cola_impresion', jsonb_build_object('id', i), auth.jwt()->>'email');
  return i;
end $$;

-- El ordenador-impresora reserva lo pendiente (y deja constancia de que está vivo)
create or replace function public.fab_cola_coger(p_quien text)
returns table (id bigint, order_id bigint) language plpgsql security definer set search_path to '' as $$
#variable_conflict use_column
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  insert into public.fab_config (clave, valor) values ('impresora_ultimo', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    on conflict (clave) do update set valor = excluded.valor;
  return query
    update public.fab_cola_impresion c set cogido_por = coalesce(nullif(trim(p_quien), ''), auth.jwt()->>'email'), cogido_at = now()
     where c.id in (select x.id from public.fab_cola_impresion x
                     where x.impreso_at is null and x.error is null and x.pedido_at > now() - interval '30 minutes'
                       and (x.cogido_at is null or x.cogido_at < now() - interval '2 minutes')
                     order by x.id for update skip locked limit 5)
    returning c.id, c.order_id;
end $$;

-- El ordenador-impresora apunta el resultado
create or replace function public.fab_cola_hecho(p_id bigint, p_error text default null)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  update public.fab_cola_impresion set impreso_at = case when p_error is null then now() end, error = p_error where id = p_id;
end $$;

revoke all on function public.fab_cola_mandar(bigint), public.fab_cola_coger(text), public.fab_cola_hecho(bigint, text) from public, anon;
grant execute on function public.fab_cola_mandar(bigint), public.fab_cola_coger(text), public.fab_cola_hecho(bigint, text) to authenticated, service_role;

do $$ begin
  alter publication supabase_realtime add table public.fab_cola_impresion;
exception when duplicate_object then null; end $$;

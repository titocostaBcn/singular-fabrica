-- «Jefa» pasa a llamarse «Responsable de Expedición» (13-oct-2026, pedido de Tito). Solo cambian los mensajes de error;
-- la marca sigue siendo fab_usuarios.jefe y ahora se pone y se quita desde 👥 (función fab v13).
create or replace function public.fab_recuperar(p_de text, p_order_ids bigint[] default null)
returns bigint[] language plpgsql security definer set search_path to '' as $$
declare yo record; ids bigint[];
begin
  select u.nombre, u.jefe, u.admin into yo from public.fab_usuarios u where lower(u.email) = lower(auth.jwt()->>'email');
  if yo.nombre is null or not (coalesce(yo.jefe, false) or coalesce(yo.admin, false)) then raise exception 'solo la Responsable de Expedición puede recuperar pedidos'; end if;
  if nullif(trim(p_de), '') is null or p_de = yo.nombre then return '{}'; end if;
  with u as (
    update public.fab_pedidos set asignado_a = yo.nombre, asignado_at = now()
     where asignado_a = p_de and estado = 'empaquetar' and not cancelado
       and (p_order_ids is null or order_id = any(p_order_ids))
    returning order_id)
  select coalesce(array_agg(order_id), '{}') into ids from u;
  if array_length(ids, 1) > 0 then
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      select unnest(ids), 'recuperado', jsonb_build_object('de', p_de, 'para', yo.nombre, 'todos', p_order_ids is null), auth.jwt()->>'email';
  end if;
  return ids;
end $$;

create or replace function public.fab_pausar_reparto(p_nombre text, p_pausa boolean)
returns text[] language plpgsql security definer set search_path to '' as $$
declare yo record; n text := nullif(trim(p_nombre), ''); l text[];
begin
  select u.nombre, u.jefe, u.admin into yo from public.fab_usuarios u where lower(u.email) = lower(auth.jwt()->>'email');
  if yo.nombre is null or not (coalesce(yo.jefe, false) or coalesce(yo.admin, false)) then raise exception 'solo la Responsable de Expedición puede pausar el reparto'; end if;
  if n is null then raise exception 'falta el nombre'; end if;
  l := array_remove(public.fab_pausados_reparto(), n);
  if p_pausa then l := l || n; end if;
  insert into public.fab_config (clave, valor) values ('reparto_pausados', array_to_string(l, ', '))
    on conflict (clave) do update set valor = excluded.valor;
  insert into public.fab_eventos (order_id, tipo, detalle, usuario)
    values (null, case when p_pausa then 'reparto_pausa' else 'reparto_reanuda' end, jsonb_build_object('nombre', n), auth.jwt()->>'email');
  return l;
end $$;

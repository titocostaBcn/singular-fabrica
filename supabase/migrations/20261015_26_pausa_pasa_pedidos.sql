-- Al sacar a alguien del reparto, sus pedidos de Empaquetar pasan solos a la Responsable (15-oct-2026, pedido de Tito:
-- «así no hay errores ni despistes»). Destino: quien pulsa, si es Responsable (fab_usuarios.jefe) y no es la que se va;
-- si no (lo pulsa el administrador en 👥), la primera Responsable de Expedición que siga en el reparto. Si no hay ninguna,
-- se quedan libres y fab_repartir los reparte entre las que quedan. Evento 'recuperado' con motivo 'pausa'.

create or replace function public.fab_pausar_reparto(p_nombre text, p_pausa boolean)
returns text[] language plpgsql security definer set search_path to '' as $$
declare yo record; n text := nullif(trim(p_nombre), ''); l text[]; destino text; ids bigint[];
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

  if p_pausa then
    destino := case when coalesce(yo.jefe, false) and yo.nombre <> n then yo.nombre end;
    if destino is null then
      select u.nombre into destino from public.fab_usuarios u
       where u.jefe and u.puesto = 'expedicion' and u.nombre <> n and not (u.nombre = any(l))
       order by u.nombre limit 1;
    end if;
    with u as (
      update public.fab_pedidos set asignado_a = destino, asignado_at = case when destino is null then null else now() end
       where asignado_a = n and estado = 'empaquetar' and not cancelado
      returning order_id)
    select coalesce(array_agg(order_id), '{}') into ids from u;
    if array_length(ids, 1) > 0 then
      insert into public.fab_eventos (order_id, tipo, detalle, usuario)
        select unnest(ids), 'recuperado', jsonb_build_object('de', n, 'para', destino, 'motivo', 'pausa'), auth.jwt()->>'email';
      if destino is null then perform public.fab_repartir(); end if;
    end if;
  end if;
  return l;
end $$;
revoke all on function public.fab_pausar_reparto(text, boolean) from public, anon;
grant execute on function public.fab_pausar_reparto(text, boolean) to authenticated, service_role;

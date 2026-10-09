-- APLICADA el 9-oct-2026 (en 3 pasos: fab_autoasignar_funcion, fab_autoasignar_trigger, fab_sin_vinilo_no_cuenta_cortados).
-- El MCP de Supabase cancela migraciones que contienen DELETE/DROP: por eso el reparto usa un jsonb en vez de tabla temporal.
--
-- Asignación automática de prendas ESTÁNDAR ya cortadas (contador fab_cortados) a pedidos.
-- Orden: urgentes primero (Exprés / etiqueta urgente) y luego los más antiguos.
-- Un pedido solo recibe prendas si así queda COMPLETO: todas sus estándar en "cortar" cubiertas por el contador,
-- personalizadas ya en Empaquetar, "sin vinilo" ya disponibles y nada en Pendiente / Sin stock.
-- Las prendas asignadas pasan a "empaquetar" (fab_consumir_cortados descuenta el contador).
-- Se lanza al sumar cortadas (fab_sumar_cortados) y tras cualquier cambio en fab_lineas (trigger de sentencia;
-- el flag fab.autoasignando evita que se relance a sí misma).
-- Prendas "sin vinilo" (etiqueta Shopify) NO cuentan ni consumen el contador.

create or replace function public.fab_consumir_cortados()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if old.estado = 'cortar' and new.estado in ('estampar', 'empaquetar') and not new.sin_vinilo
     and coalesce(jsonb_array_length(new.personalizacion), 0) = 0 then
    update public.fab_cortados set hechas = greatest(hechas - new.cantidad, 0), actualizado_at = now()
     where clave = new.titulo || '|' || coalesce(new.variante, '') and hechas > 0;
  end if;
  return null;
end $$;

create or replace function public.fab_autoasignar(p_aplicar boolean default true)
returns table(order_id bigint, order_name text, prendas int)
language plpgsql security definer set search_path to '' as $$
declare r record; ok boolean; need record; movidas bigint[] := '{}'; disp jsonb;
begin
  select coalesce(jsonb_object_agg(c.clave, c.hechas), '{}'::jsonb) into disp from public.fab_cortados c where c.hechas > 0;
  if disp = '{}'::jsonb then return; end if;
  for r in
    select p.order_id, p.order_name
      from public.fab_pedidos p
     where p.estado <> 'producido' and not p.cancelado and not p.enviado_fuera
       and exists (select 1 from public.fab_lineas l where l.order_id = p.order_id and l.estado = 'cortar' and not l.sin_vinilo
                    and coalesce(jsonb_array_length(l.personalizacion), 0) = 0)
     order by (p.metodo_envio ~* 'expr[eé]s|urgent' or exists (select 1 from unnest(coalesce(p.tags, '{}'::text[])) t where t ~* 'urgent')) desc,
              p.creado_shopify asc
  loop
    if exists (select 1 from public.fab_lineas l where l.order_id = r.order_id
                 and (l.estado in ('pendiente', 'sin_stock')
                      or (l.estado in ('cortar', 'estampar') and (l.sin_vinilo or coalesce(jsonb_array_length(l.personalizacion), 0) > 0)))) then
      continue;
    end if;
    ok := true;
    for need in
      select l.titulo || '|' || coalesce(l.variante, '') as clave, sum(l.cantidad)::int as n
        from public.fab_lineas l where l.order_id = r.order_id and l.estado = 'cortar' and not l.sin_vinilo
         and coalesce(jsonb_array_length(l.personalizacion), 0) = 0
       group by 1
    loop
      if coalesce((disp->>need.clave)::int, 0) < need.n then ok := false; exit; end if;
    end loop;
    if not ok then continue; end if;
    for need in
      select l.titulo || '|' || coalesce(l.variante, '') as clave, sum(l.cantidad)::int as n
        from public.fab_lineas l where l.order_id = r.order_id and l.estado = 'cortar' and not l.sin_vinilo
         and coalesce(jsonb_array_length(l.personalizacion), 0) = 0
       group by 1
    loop
      disp := jsonb_set(disp, array[need.clave], to_jsonb((disp->>need.clave)::int - need.n));
    end loop;
    order_id := r.order_id; order_name := r.order_name;
    select count(*)::int into prendas from public.fab_lineas l where l.order_id = r.order_id and l.estado = 'cortar' and not l.sin_vinilo
       and coalesce(jsonb_array_length(l.personalizacion), 0) = 0;
    movidas := movidas || r.order_id;
    return next;
  end loop;
  if p_aplicar and array_length(movidas, 1) > 0 then
    perform set_config('fab.autoasignando', '1', true);
    update public.fab_lineas l set estado = 'empaquetar', estado_at = now(), estado_por = 'auto'
     where l.order_id = any(movidas) and l.estado = 'cortar' and not l.sin_vinilo and coalesce(jsonb_array_length(l.personalizacion), 0) = 0;
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      select unnest(movidas), 'auto_asignado', null, 'auto';
    perform set_config('fab.autoasignando', '', true);
  end if;
end $$;
revoke all on function public.fab_autoasignar(boolean) from public, anon, authenticated;

create or replace function public.fab_autoasignar_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if coalesce(current_setting('fab.autoasignando', true), '') = '' then perform public.fab_autoasignar(true); end if;
  return null;
end $$;
revoke all on function public.fab_autoasignar_trg() from public, anon, authenticated;
create trigger fab_lineas_autoasignar after insert or update of estado on public.fab_lineas
  for each statement execute function public.fab_autoasignar_trg();

create or replace function public.fab_sumar_cortados(p_titulo text, p_variante text, p_n integer)
returns integer language plpgsql security definer set search_path to '' as $$
declare v int; k text := p_titulo || '|' || coalesce(p_variante, '');
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  if p_n is null or p_n = 0 or abs(p_n) > 1000 then raise exception 'cantidad no válida'; end if;
  insert into public.fab_cortados as c (clave, titulo, variante, hechas, actualizado_por)
    values (k, p_titulo, p_variante, greatest(p_n, 0), auth.jwt()->>'email')
  on conflict (clave) do update set hechas = greatest(c.hechas + p_n, 0), actualizado_at = now(), actualizado_por = auth.jwt()->>'email'
  returning hechas into v;
  insert into public.fab_eventos (order_id, tipo, detalle, usuario)
    values (null, 'cortados', jsonb_build_object('clave', k, 'n', p_n, 'total', v), auth.jwt()->>'email');
  if p_n > 0 then perform public.fab_autoasignar(true); end if;
  select c.hechas into v from public.fab_cortados c where c.clave = k;
  return v;
end $$;

-- Importación: pedidos abiertos de los últimos 60 días (para que salgan los retrasados)
update public.fab_config set valor = '60' where clave = 'importar_dias_atras';

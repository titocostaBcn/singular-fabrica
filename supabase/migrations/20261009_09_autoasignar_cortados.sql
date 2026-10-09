-- Asignación automática de prendas ESTÁNDAR (sin personalización) ya cortadas (contador fab_cortados) a pedidos.
-- Orden: urgentes primero (Exprés / etiqueta urgente) y luego los más antiguos.
-- Un pedido solo recibe prendas si así queda COMPLETO: todas sus prendas estándar en "cortar" se cubren con el contador,
-- sus personalizadas ya están en Empaquetar y no tiene nada en Pendiente / Sin stock. Si no, se salta y el stock queda para otro.
-- Las prendas asignadas pasan a "empaquetar" (el trigger fab_consumir_cortados descuenta el contador) → el pedido pasa a Empaquetar.
-- Se ejecuta al sumar cortadas y cada vez que cambian prendas (p. ej. una personalizada "Hecha" o un pedido nuevo importado).

create or replace function public.fab_autoasignar(p_aplicar boolean default true)
returns table(order_id bigint, order_name text, prendas int)
language plpgsql security definer set search_path to '' as $$
declare r record; ok boolean; need record; movidas bigint[] := '{}';
begin
  create temp table if not exists _disp (clave text primary key, hechas int) on commit drop;
  delete from _disp;
  insert into _disp select c.clave, c.hechas from public.fab_cortados c where c.hechas > 0;
  if not exists (select 1 from _disp) then return; end if;

  for r in
    select p.order_id, p.order_name
      from public.fab_pedidos p
     where p.estado <> 'producido' and not p.cancelado and not p.enviado_fuera
       and exists (select 1 from public.fab_lineas l where l.order_id = p.order_id and l.estado = 'cortar'
                    and coalesce(jsonb_array_length(l.personalizacion), 0) = 0)
     order by (p.metodo_envio ~* 'expr[eé]s|urgent' or exists (select 1 from unnest(coalesce(p.tags, '{}'::text[])) t where t ~* 'urgent')) desc,
              p.creado_shopify asc
  loop
    -- el resto del pedido tiene que estar listo: nada pendiente/sin stock y personalizadas ya hechas
    if exists (select 1 from public.fab_lineas l where l.order_id = r.order_id
                 and (l.estado in ('pendiente', 'sin_stock')
                      or (l.estado in ('cortar', 'estampar') and coalesce(jsonb_array_length(l.personalizacion), 0) > 0))) then
      continue;
    end if;
    -- ¿hay suficientes cortadas para todas sus prendas estándar?
    ok := true;
    for need in
      select l.titulo || '|' || coalesce(l.variante, '') as clave, sum(l.cantidad)::int as n
        from public.fab_lineas l where l.order_id = r.order_id and l.estado = 'cortar'
         and coalesce(jsonb_array_length(l.personalizacion), 0) = 0
       group by 1
    loop
      if coalesce((select d.hechas from _disp d where d.clave = need.clave), 0) < need.n then ok := false; exit; end if;
    end loop;
    if not ok then continue; end if;

    for need in
      select l.titulo || '|' || coalesce(l.variante, '') as clave, sum(l.cantidad)::int as n
        from public.fab_lineas l where l.order_id = r.order_id and l.estado = 'cortar'
         and coalesce(jsonb_array_length(l.personalizacion), 0) = 0
       group by 1
    loop
      update _disp d set hechas = d.hechas - need.n where d.clave = need.clave;
    end loop;
    order_id := r.order_id; order_name := r.order_name;
    select count(*)::int into prendas from public.fab_lineas l where l.order_id = r.order_id and l.estado = 'cortar'
       and coalesce(jsonb_array_length(l.personalizacion), 0) = 0;
    movidas := movidas || r.order_id;
    return next;
  end loop;

  if p_aplicar and array_length(movidas, 1) > 0 then
    perform set_config('fab.autoasignando', '1', true);
    update public.fab_lineas l set estado = 'empaquetar', estado_at = now(), estado_por = 'auto'
     where l.order_id = any(movidas) and l.estado = 'cortar' and coalesce(jsonb_array_length(l.personalizacion), 0) = 0;
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      select unnest(movidas), 'auto_asignado', null, 'auto';
    perform set_config('fab.autoasignando', '', true);
  end if;
end $$;
revoke all on function public.fab_autoasignar(boolean) from public, anon, authenticated;

-- Disparador: tras cambios en prendas (no recursivo: mientras asigna se marca fab.autoasignando)
create or replace function public.fab_autoasignar_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if coalesce(current_setting('fab.autoasignando', true), '') = '' then perform public.fab_autoasignar(true); end if;
  return null;
end $$;
drop trigger if exists fab_lineas_autoasignar on public.fab_lineas;
create trigger fab_lineas_autoasignar after insert or update of estado on public.fab_lineas
  for each statement execute function public.fab_autoasignar_trg();

-- Al sumar cortadas se asigna en el acto
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

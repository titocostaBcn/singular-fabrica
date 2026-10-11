-- Productos «sin vinilo» también por Producción (11-oct-2026, decisión de Tito): Producción mira si hay la prenda y la deja en
-- la estantería de hechas («✔ Preparadas»), o pulsa «✖ No hay». Expedición ya no ve nada que no esté listo.
-- · fab_autoasignar y fab_consumir_cortados tratan las «sin vinilo» como las estándar (contador fab_cortados por modelo+talla).
-- · fab_picking: lo que llega de Sin stock vuelve siempre a Producción (cortar), también las «sin vinilo».
-- · Las «sin vinilo» que el programa había pasado solo a Empaquetar (o a Sin stock según Shopify) vuelven a Producción.
create or replace function public.fab_autoasignar(p_aplicar boolean default true)
returns table(order_id bigint, order_name text, prendas integer)
language plpgsql security definer set search_path to '' as $function$
declare r record; ok boolean; need record; movidas bigint[] := '{}'; disp jsonb;
begin
  select coalesce(jsonb_object_agg(c.clave, c.hechas), '{}'::jsonb) into disp from public.fab_cortados c where c.hechas > 0;
  if disp = '{}'::jsonb then return; end if;
  for r in
    select p.order_id, p.order_name
      from public.fab_pedidos p
     where p.estado <> 'producido' and not p.cancelado and not p.enviado_fuera
       and exists (select 1 from public.fab_lineas l where l.order_id = p.order_id and l.estado = 'cortar'
                    and coalesce(jsonb_array_length(l.personalizacion), 0) = 0)
     order by (p.metodo_envio ~* 'expr[eé]s|urgent' or exists (select 1 from unnest(coalesce(p.tags, '{}'::text[])) t where t ~* 'urgent')) desc,
              p.creado_shopify asc
  loop
    -- falta alguna prenda, o queda alguna personalizada por hacer → este pedido aún no
    if exists (select 1 from public.fab_lineas l where l.order_id = r.order_id
                 and (l.estado in ('pendiente', 'sin_stock')
                      or (l.estado in ('cortar', 'estampar') and not l.sin_vinilo and coalesce(jsonb_array_length(l.personalizacion), 0) > 0))) then
      continue;
    end if;
    ok := true;
    for need in
      select l.titulo || '|' || coalesce(l.variante, '') as clave, sum(l.cantidad)::int as n
        from public.fab_lineas l where l.order_id = r.order_id and l.estado = 'cortar'
         and coalesce(jsonb_array_length(l.personalizacion), 0) = 0
       group by 1
    loop
      if coalesce((disp->>need.clave)::int, 0) < need.n then ok := false; exit; end if;
    end loop;
    if not ok then continue; end if;
    for need in
      select l.titulo || '|' || coalesce(l.variante, '') as clave, sum(l.cantidad)::int as n
        from public.fab_lineas l where l.order_id = r.order_id and l.estado = 'cortar'
         and coalesce(jsonb_array_length(l.personalizacion), 0) = 0
       group by 1
    loop
      disp := jsonb_set(disp, array[need.clave], to_jsonb((disp->>need.clave)::int - need.n));
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
      select unnest(movidas), 'auto_asignado', '{"a":"empaquetar"}'::jsonb, 'auto';
    perform set_config('fab.autoasignando', '', true);
  end if;
end $function$;

create or replace function public.fab_consumir_cortados()
 returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  k text := new.titulo || '|' || coalesce(new.variante, '');
  estandar boolean := coalesce(jsonb_array_length(new.personalizacion), 0) = 0;
  hay int; sale int;
begin
  if not estandar or old.estado = new.estado then return null; end if;
  if old.estado = 'cortar' and new.estado in ('estampar', 'empaquetar') then
    select c.hechas into hay from public.fab_cortados c where c.clave = k for update;
    sale := least(coalesce(hay, 0), new.cantidad);
    if sale > 0 then
      update public.fab_cortados set hechas = hechas - sale, actualizado_at = now() where clave = k;
      insert into public.fab_almacen_mov (clave, titulo, variante, n, uds, motivo, order_id, line_id, usuario)
        values (k, new.titulo, new.variante, -sale, sale, 'asignado', new.order_id, new.line_id, coalesce(new.estado_por, 'auto'));
    end if;
  elsif old.estado = 'estampar' and new.estado in ('cortar', 'sin_stock', 'pendiente') then
    if coalesce(current_setting('fab.descartar', true), '') = '1' then
      insert into public.fab_almacen_mov (clave, titulo, variante, n, uds, motivo, order_id, line_id, usuario)
        values (k, new.titulo, new.variante, 0, new.cantidad, 'descartado', new.order_id, new.line_id, new.estado_por);
    else
      insert into public.fab_cortados as c (clave, titulo, variante, hechas, actualizado_por)
        values (k, new.titulo, new.variante, new.cantidad, 'devuelto')
      on conflict (clave) do update set hechas = c.hechas + excluded.hechas, actualizado_at = now();
      insert into public.fab_almacen_mov (clave, titulo, variante, n, uds, motivo, order_id, line_id, usuario)
        values (k, new.titulo, new.variante, new.cantidad, new.cantidad, 'devuelto', new.order_id, new.line_id, new.estado_por);
    end if;
  end if;
  return null;
end $function$;

create or replace function public.fab_picking(p_line_ids bigint[], p_hay boolean, p_persona text default null)
returns integer language plpgsql security definer set search_path to '' as $function$
declare n int; per text := coalesce(nullif(trim(p_persona), ''), auth.jwt()->>'email');
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  if p_hay then
    update public.fab_lineas l
       set prenda_ok_at = now(), prenda_ok_por = per,
           estado = case when l.estado = 'sin_stock' then 'cortar' else l.estado end,
           estado_at = case when l.estado = 'sin_stock' then now() else l.estado_at end,
           estado_por = case when l.estado = 'sin_stock' then per else l.estado_por end
      from public.fab_pedidos p
     where p.order_id = l.order_id and l.line_id = any(p_line_ids)
       and p.estado <> 'producido' and not p.cancelado and not p.enviado_fuera;
  else
    update public.fab_lineas l
       set prenda_ok_at = null, prenda_ok_por = null, estado = 'sin_stock', estado_at = now(), estado_por = per
      from public.fab_pedidos p
     where p.order_id = l.order_id and l.line_id = any(p_line_ids)
       and p.estado <> 'producido' and not p.cancelado and not p.enviado_fuera;
  end if;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      select distinct l.order_id, case when p_hay then 'picking_hay' else 'picking_no_hay' end,
             jsonb_build_object('line_ids', p_line_ids, 'persona', p_persona), auth.jwt()->>'email'
        from public.fab_lineas l where l.line_id = any(p_line_ids);
  end if;
  return n;
end $function$;

update public.fab_lineas l set estado = 'cortar', estado_at = now(), estado_por = 'a producción'
  from public.fab_pedidos p
 where p.order_id = l.order_id and l.sin_vinilo
   and (l.estado = 'empaquetar' or (l.estado = 'sin_stock' and l.estado_por = 'auto sin vinilo'))
   and p.estado <> 'producido' and not p.cancelado and not p.enviado_fuera;

-- Producción en un solo paso (11-oct-2026, decisión de Tito): quien corta el vinilo también estampa, a la vez.
-- Las prendas van cortar ("Producción") → empaquetar. El contador fab_cortados pasa a contar PRENDAS HECHAS (cortadas y
-- estampadas) que esperan en la estantería de «hechas»; fab_autoasignar las reparte a los pedidos que quedan completos
-- (urgentes y antiguos primero) y los pasa directamente a EMPAQUETAR. Un pedido con alguna personalizada aún por hacer
-- espera (no se le reservan prendas hasta que su personalizada esté hecha). Ya no hay hojas por pedido ni etapa Estampar.
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
       and exists (select 1 from public.fab_lineas l where l.order_id = p.order_id and l.estado = 'cortar' and not l.sin_vinilo
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
      select unnest(movidas), 'auto_asignado', '{"a":"empaquetar"}'::jsonb, 'auto';
    perform set_config('fab.autoasignando', '', true);
  end if;
end $function$;

-- Lo que estuviera en la antigua etapa Estampar ya está hecho → Empaquetar
update public.fab_lineas set estado = 'empaquetar', estado_at = now(), estado_por = 'un paso' where estado = 'estampar';

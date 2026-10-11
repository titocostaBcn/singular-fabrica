-- APLICADA el 11-oct-2026 (migración fab_ola1_estampar_almacen).
-- Ola 1 del diagnóstico operativo (11-oct-2026).
-- 1) Cortar y estampar separados: las prendas con vinilo estándar pasan cortar → estampar → empaquetar.
--    El contador de cortadas (fab_cortados) es ahora un ALMACÉN de vinilos cortados por modelo y variante:
--    fab_autoasignar reparte el almacén a pedidos (urgentes y antiguos primero) moviendo sus prendas a ESTAMPAR
--    (antes las pasaba a Empaquetar como si ya estuvieran estampadas). Si una prenda con vinilo asignado vuelve a
--    Sin stock / Cortar, su vinilo vuelve al almacén. «Vinilo mal» (fab_vinilo_mal) lo descarta.
--    Todos los movimientos del almacén quedan en fab_almacen_mov (para el informe de vinilo parado).
-- 2) Color de vinilo por modelo (fab_modelos) para la hoja de corte por color.
-- 3) Capacidad diaria para el plan del día (fab_config.capacidad_min / capacidad_max).
-- 4) Recogida de prendas (fab_lineas.prenda_ok_at/por, rpc fab_picking).
-- 5) Hoja de pedido: hueco de la estantería y hoja impresa (fab_pedidos.hueco, hoja_impresa_at, hoja_version, rpc fab_hojas_impresas).
-- (Sin las palabras que el MCP de Supabase bloquea.)

-- ───── columnas y tablas ─────
alter table public.fab_lineas
  add column if not exists prenda_ok_at timestamptz,
  add column if not exists prenda_ok_por text;
alter table public.fab_pedidos
  add column if not exists hueco integer,
  add column if not exists hoja_impresa_at timestamptz,
  add column if not exists hoja_version integer not null default 0;

create table if not exists public.fab_modelos (
  titulo text primary key,
  color_vinilo text,
  actualizado_at timestamptz not null default now(),
  actualizado_por text
);
alter table public.fab_modelos enable row level security;
create policy fab_modelos_leer on public.fab_modelos for select to authenticated using (public.fab_es_usuario());

create table if not exists public.fab_almacen_mov (
  id bigint generated always as identity primary key,
  clave text not null,
  titulo text,
  variante text,
  n integer not null,          -- cambio en el almacén: + entra, − sale, 0 = no cambia (descartado)
  uds integer not null,        -- unidades afectadas
  motivo text not null,        -- cortado · corregido · asignado · devuelto · descartado
  order_id bigint,
  line_id bigint,
  usuario text,
  created_at timestamptz not null default now()
);
alter table public.fab_almacen_mov enable row level security;
create policy fab_almacen_mov_leer on public.fab_almacen_mov for select to authenticated using (public.fab_es_usuario());
create index if not exists fab_almacen_mov_clave_idx on public.fab_almacen_mov (clave, created_at);

insert into public.fab_config (clave, valor) values ('capacidad_min', '70'), ('capacidad_max', '90') on conflict (clave) do nothing;

-- ───── almacén de vinilos: salidas y devoluciones automáticas ─────
create or replace function public.fab_consumir_cortados()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  k text := new.titulo || '|' || coalesce(new.variante, '');
  estandar boolean := not new.sin_vinilo and coalesce(jsonb_array_length(new.personalizacion), 0) = 0;
  hay int; sale int;
begin
  if not estandar or old.estado = new.estado then return null; end if;
  if old.estado = 'cortar' and new.estado in ('estampar', 'empaquetar') then
    -- la prenda se lleva su vinilo del almacén (lo que haya)
    select c.hechas into hay from public.fab_cortados c where c.clave = k for update;
    sale := least(coalesce(hay, 0), new.cantidad);
    if sale > 0 then
      update public.fab_cortados set hechas = hechas - sale, actualizado_at = now() where clave = k;
      insert into public.fab_almacen_mov (clave, titulo, variante, n, uds, motivo, order_id, line_id, usuario)
        values (k, new.titulo, new.variante, -sale, sale, 'asignado', new.order_id, new.line_id, coalesce(new.estado_por, 'auto'));
    end if;
  elsif old.estado = 'estampar' and new.estado in ('cortar', 'sin_stock', 'pendiente') then
    if coalesce(current_setting('fab.descartar', true), '') = '1' then
      -- vinilo estropeado: no vuelve al almacén
      insert into public.fab_almacen_mov (clave, titulo, variante, n, uds, motivo, order_id, line_id, usuario)
        values (k, new.titulo, new.variante, 0, new.cantidad, 'descartado', new.order_id, new.line_id, new.estado_por);
    else
      -- la prenda no se estampa (falta la prenda o se ha deshecho): su vinilo vuelve al almacén
      insert into public.fab_cortados as c (clave, titulo, variante, hechas, actualizado_por)
        values (k, new.titulo, new.variante, new.cantidad, 'devuelto')
      on conflict (clave) do update set hechas = c.hechas + excluded.hechas, actualizado_at = now();
      insert into public.fab_almacen_mov (clave, titulo, variante, n, uds, motivo, order_id, line_id, usuario)
        values (k, new.titulo, new.variante, new.cantidad, new.cantidad, 'devuelto', new.order_id, new.line_id, new.estado_por);
    end if;
  end if;
  return null;
end $$;

-- Reparte el almacén: urgentes primero y luego los más antiguos. Un pedido recibe vinilo solo si con él quedan
-- cubiertas TODAS sus prendas estándar en Cortar y no tiene nada en Pendiente / Sin stock. Sus prendas pasan a ESTAMPAR.
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
    if exists (select 1 from public.fab_lineas l where l.order_id = r.order_id and l.estado in ('pendiente', 'sin_stock')) then
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
    update public.fab_lineas l set estado = 'estampar', estado_at = now(), estado_por = 'auto'
     where l.order_id = any(movidas) and l.estado = 'cortar' and not l.sin_vinilo and coalesce(jsonb_array_length(l.personalizacion), 0) = 0;
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      select unnest(movidas), 'auto_asignado', '{"a":"estampar"}'::jsonb, 'auto';
    perform set_config('fab.autoasignando', '', true);
  end if;
end $$;
revoke all on function public.fab_autoasignar(boolean) from public, anon, authenticated;

-- «✔ Cortadas» / «−1» en el Resumen: entra (o se corrige) vinilo en el almacén
create or replace function public.fab_sumar_cortados(p_titulo text, p_variante text, p_n integer)
returns integer language plpgsql security definer set search_path to '' as $$
declare v int; antes int; k text := p_titulo || '|' || coalesce(p_variante, '');
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  if p_n is null or p_n = 0 or abs(p_n) > 1000 then raise exception 'cantidad no válida'; end if;
  select c.hechas into antes from public.fab_cortados c where c.clave = k for update;
  insert into public.fab_cortados as c (clave, titulo, variante, hechas, actualizado_por)
    values (k, p_titulo, p_variante, greatest(p_n, 0), auth.jwt()->>'email')
  on conflict (clave) do update set hechas = greatest(c.hechas + p_n, 0), actualizado_at = now(), actualizado_por = auth.jwt()->>'email'
  returning hechas into v;
  insert into public.fab_eventos (order_id, tipo, detalle, usuario)
    values (null, 'cortados', jsonb_build_object('clave', k, 'n', p_n, 'total', v), auth.jwt()->>'email');
  if v - coalesce(antes, 0) <> 0 then
    insert into public.fab_almacen_mov (clave, titulo, variante, n, uds, motivo, usuario)
      values (k, p_titulo, p_variante, v - coalesce(antes, 0), abs(v - coalesce(antes, 0)), case when p_n > 0 then 'cortado' else 'corregido' end, auth.jwt()->>'email');
  end if;
  if p_n > 0 then perform public.fab_autoasignar(true); end if;
  select c.hechas into v from public.fab_cortados c where c.clave = k;
  return v;
end $$;

-- «✖ Vinilo mal» en Estampar: la prenda vuelve a Cortar y su vinilo se descarta (no vuelve al almacén).
-- Si hay otro vinilo en el almacén, la asignación automática se lo da enseguida.
create or replace function public.fab_vinilo_mal(p_line_ids bigint[], p_persona text default null)
returns integer language plpgsql security definer set search_path to '' as $$
declare n int; per text := coalesce(nullif(trim(p_persona), ''), auth.jwt()->>'email');
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  perform set_config('fab.descartar', '1', true);
  update public.fab_lineas l set estado = 'cortar', estado_at = now(), estado_por = per
    from public.fab_pedidos p
   where p.order_id = l.order_id and l.line_id = any(p_line_ids) and l.estado = 'estampar'
     and p.estado <> 'producido' and not p.cancelado and not p.enviado_fuera;
  get diagnostics n = row_count;
  perform set_config('fab.descartar', '', true);
  if n > 0 then
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      select distinct l.order_id, 'vinilo_mal', jsonb_build_object('line_ids', p_line_ids, 'persona', p_persona), auth.jwt()->>'email'
        from public.fab_lineas l where l.line_id = any(p_line_ids);
  end if;
  return n;
end $$;
revoke all on function public.fab_vinilo_mal(bigint[], text) from public, anon;
grant execute on function public.fab_vinilo_mal(bigint[], text) to authenticated;

-- ───── color de vinilo por modelo ─────
create or replace function public.fab_color_modelo(p_titulos text[], p_color text)
returns integer language plpgsql security definer set search_path to '' as $$
declare n int; col text := nullif(trim(p_color), '');
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  insert into public.fab_modelos as m (titulo, color_vinilo, actualizado_por)
    select t, col, auth.jwt()->>'email' from unnest(p_titulos) t
  on conflict (titulo) do update set color_vinilo = excluded.color_vinilo, actualizado_at = now(), actualizado_por = excluded.actualizado_por;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.fab_color_modelo(text[], text) from public, anon;
grant execute on function public.fab_color_modelo(text[], text) to authenticated;

-- ───── recogida de prendas (lista de picking) ─────
-- Hay: la prenda está; si estaba en Sin stock vuelve (sin vinilo → Empaquetar; con vinilo → Cortar, y si hay vinilo
-- en el almacén la asignación automática la pasa a Estampar). No hay: la prenda pasa a Sin stock.
create or replace function public.fab_picking(p_line_ids bigint[], p_hay boolean, p_persona text default null)
returns integer language plpgsql security definer set search_path to '' as $$
declare n int; per text := coalesce(nullif(trim(p_persona), ''), auth.jwt()->>'email');
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  if p_hay then
    update public.fab_lineas l
       set prenda_ok_at = now(), prenda_ok_por = per,
           estado = case when l.estado = 'sin_stock' then (case when l.sin_vinilo then 'empaquetar' else 'cortar' end) else l.estado end,
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
end $$;
revoke all on function public.fab_picking(bigint[], boolean, text) from public, anon;
grant execute on function public.fab_picking(bigint[], boolean, text) to authenticated;

-- ───── hoja de pedido: hueco de la estantería y hoja impresa ─────
-- Asigna hueco (el número libre más bajo entre los pedidos activos) a los que no lo tienen y marca la hoja como impresa.
create or replace function public.fab_hojas_impresas(p_order_ids bigint[], p_copia boolean default false)
returns table(r_order_id bigint, r_hueco integer, r_version integer)
language plpgsql security definer set search_path to '' as $$
declare oid bigint; h int;
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  perform pg_advisory_xact_lock(4242001);
  foreach oid in array p_order_ids loop
    select p.hueco into h from public.fab_pedidos p
     where p.order_id = oid and p.estado <> 'producido' and not p.cancelado and not p.enviado_fuera;
    if not found then continue; end if;
    if h is null then
      select min(s) into h from generate_series(1, 5000) s
       where not exists (select 1 from public.fab_pedidos q
                          where q.hueco = s and q.estado <> 'producido' and not q.cancelado and not q.enviado_fuera);
    end if;
    update public.fab_pedidos p set hueco = h, hoja_impresa_at = now(), hoja_version = p.hoja_version + 1
     where p.order_id = oid
    returning p.order_id, p.hueco, p.hoja_version into r_order_id, r_hueco, r_version;
    return next;
  end loop;
  insert into public.fab_eventos (order_id, tipo, detalle, usuario)
    select unnest(p_order_ids), case when p_copia then 'hoja_copia' else 'hoja_impresa' end, null, auth.jwt()->>'email';
end $$;
revoke all on function public.fab_hojas_impresas(bigint[], boolean) from public, anon;
grant execute on function public.fab_hojas_impresas(bigint[], boolean) to authenticated;

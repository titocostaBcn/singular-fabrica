-- APLICADA el 11-oct-2026 (migración fab_cambios_pedido).
-- Cambios de la clienta después de importar el pedido (petición de Tito 11-oct-2026).
-- Talla, prendas, cantidad y dirección se cambian en Shopify y la función fab los recoge
-- (en cada importación si fab_config.sincronizar_cambios = 'si', y con «Actualizar desde Shopify» en la tarjeta).
-- El texto de personalización NO se puede cambiar en Shopify en un pedido ya hecho: se corrige en la pantalla.
-- (Sin la palabra que el MCP de Supabase bloquea: las prendas quitadas las elimina la función fab con supabase-js.)

alter table public.fab_pedidos
  add column if not exists modificado jsonb not null default '[]'::jsonb,  -- avisos de cambios pendientes de ver
  add column if not exists modificado_at timestamptz,
  add column if not exists modificado_visto_at timestamptz,
  add column if not exists modificado_visto_por text;

alter table public.fab_lineas
  add column if not exists personalizacion_original jsonb,  -- lo que puso la clienta (antes de corregir)
  add column if not exists personalizacion_por text,
  add column if not exists personalizacion_at timestamptz;

insert into public.fab_config (clave, valor) values ('sincronizar_cambios', 'no') on conflict (clave) do nothing;

-- Recalcula la etapa del pedido (la de su prenda más atrasada) y relanza la asignación automática.
-- La usa la función fab después de quitar prendas de un pedido.
create or replace function public.fab_recalcular_estado(p_order_id bigint) returns text
language plpgsql security definer set search_path to '' as $$
declare
  orden constant text[] := array['pendiente','sin_stock','cortar','estampar','empaquetar'];
  v text;
begin
  select orden[min(array_position(orden, l.estado))] into v from public.fab_lineas l where l.order_id = p_order_id;
  if v is not null then
    update public.fab_pedidos set estado = v, estado_at = now()
     where order_id = p_order_id and estado <> 'producido' and estado is distinct from v;
  end if;
  perform public.fab_autoasignar(true);
  return v;
end $$;
revoke all on function public.fab_recalcular_estado(bigint) from public, anon, authenticated;

-- Corregir el texto de personalización de una prenda (solo en el programa; Shopify no lo permite).
-- Guarda el original la primera vez y deja aviso «Modificado» en el pedido.
create or replace function public.fab_corregir_personalizacion(p_line_id bigint, p_personalizacion jsonb, p_persona text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  l record;
  per text := nullif(trim(p_persona), '');
  antes text; despues text;
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  if jsonb_typeof(p_personalizacion) is distinct from 'array' or jsonb_array_length(p_personalizacion) > 20
     or exists (select 1 from jsonb_array_elements(p_personalizacion) e
                 where jsonb_typeof(e) <> 'object' or jsonb_typeof(e->'key') is distinct from 'string'
                    or jsonb_typeof(e->'value') is distinct from 'string' or length(e->>'value') > 200) then
    raise exception 'Texto no válido';
  end if;
  select li.line_id, li.order_id, li.titulo, li.variante, li.personalizacion into l
    from public.fab_lineas li join public.fab_pedidos p on p.order_id = li.order_id
   where li.line_id = p_line_id and p.estado <> 'producido' and not p.cancelado;
  if not found then raise exception 'Prenda no encontrada o pedido ya producido'; end if;
  antes := coalesce((select string_agg(e->>'value', ' · ') from jsonb_array_elements(l.personalizacion) e), '');
  despues := coalesce((select string_agg(e->>'value', ' · ') from jsonb_array_elements(p_personalizacion) e), '');
  if antes = despues then return l.personalizacion; end if;
  update public.fab_lineas
     set personalizacion_original = coalesce(personalizacion_original, personalizacion),
         personalizacion = p_personalizacion, personalizacion_por = coalesce(per, auth.jwt()->>'email'), personalizacion_at = now()
   where line_id = p_line_id;
  update public.fab_pedidos
     set modificado = modificado || jsonb_build_array(format('Texto corregido en %s: «%s» → «%s»%s', l.titulo, antes, despues, coalesce(' (' || per || ')', ''))),
         modificado_at = now(), modificado_visto_at = null, modificado_visto_por = null
   where order_id = l.order_id;
  insert into public.fab_eventos (order_id, tipo, detalle, usuario)
    values (l.order_id, 'personalizacion_corregida',
            jsonb_build_object('line_id', p_line_id, 'antes', l.personalizacion, 'despues', p_personalizacion, 'persona', per),
            auth.jwt()->>'email');
  return p_personalizacion;
end $$;
revoke all on function public.fab_corregir_personalizacion(bigint, jsonb, text) from public, anon;
grant execute on function public.fab_corregir_personalizacion(bigint, jsonb, text) to authenticated;

-- «✔ Visto»: el aviso de cambios se quita de la tarjeta (queda en fab_eventos).
create or replace function public.fab_modificado_visto(p_order_id bigint, p_persona text default null)
returns integer language plpgsql security definer set search_path to '' as $$
declare n int; avisos jsonb; per text := nullif(trim(p_persona), '');
begin
  if not public.fab_es_usuario() then raise exception 'sin acceso'; end if;
  select modificado into avisos from public.fab_pedidos where order_id = p_order_id;
  update public.fab_pedidos
     set modificado = '[]'::jsonb, modificado_visto_at = now(), modificado_visto_por = coalesce(per, auth.jwt()->>'email')
   where order_id = p_order_id and jsonb_array_length(modificado) > 0;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.fab_eventos (order_id, tipo, detalle, usuario)
      values (p_order_id, 'modificado_visto', jsonb_build_object('avisos', avisos, 'persona', per), auth.jwt()->>'email');
  end if;
  return n;
end $$;
revoke all on function public.fab_modificado_visto(bigint, text) from public, anon;
grant execute on function public.fab_modificado_visto(bigint, text) to authenticated;

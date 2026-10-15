-- Reparto entre TODAS las personas de Expedición (15-oct-2026, pedido de Tito).
-- Antes la lista era fija (fab_config.reparto_expedicion = 'Dania, Irene'). Ahora entra en el reparto cualquier usuario
-- con puesto Expedición y nombre: al darlo de alta en 👥 ya recibe pedidos. Con ⏸ (la Responsable en su pantalla, o el
-- administrador en 👥) se le saca del reparto mientras no está y con ▶ vuelve: se reparte entre las que están (3, 2 o 1).
-- fab_config.reparto_expedicion queda solo para el ORDEN del turno (las que no aparecen van detrás, por nombre).
-- Sigue haciendo falta que haya al menos dos con usuario para repartir (con una sola, todo llega libre como antes).

create or replace function public.fab_lista_reparto()
returns text[] language sql stable security definer set search_path to '' as $$
  with orden as (
    select trim(x) n, o from public.fab_config c, unnest(string_to_array(c.valor, ',')) with ordinality as t(x, o)
     where c.clave = 'reparto_expedicion' and trim(x) <> '')
  select coalesce(array_agg(u.nombre order by orden.o nulls last, u.nombre), '{}')
    from public.fab_usuarios u left join orden on orden.n = u.nombre
   where u.puesto = 'expedicion' and nullif(trim(u.nombre), '') is not null;
$$;
revoke all on function public.fab_lista_reparto() from public, anon;
grant execute on function public.fab_lista_reparto() to authenticated, service_role;

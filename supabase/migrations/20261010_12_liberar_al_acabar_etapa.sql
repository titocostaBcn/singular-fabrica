-- APLICADA el 10-oct-2026. Al terminar Cortar y estampar el pedido queda LIBRE para empaquetado; al salir (producido) también.
create or replace function public.fab_registro_personas() returns trigger
language plpgsql set search_path to '' as $$
begin
  if new.estado is distinct from old.estado then
    if new.estado in ('empaquetar', 'producido') and old.estado in ('pendiente', 'sin_stock', 'cortar', 'estampar') then
      if new.estampado_at is null then
        new.estampado_at := now(); new.estampado_por := coalesce(new.estampado_por, new.asignado_a);
      end if;
      if new.estado = 'empaquetar' then new.asignado_a := null; new.asignado_at := null; end if;
    end if;
    if new.estado = 'producido' then
      new.empaquetado_at := now(); new.empaquetado_por := coalesce(new.asignado_a, new.empaquetado_por);
      new.asignado_a := null; new.asignado_at := null;
    end if;
    if old.estado = 'producido' and new.estado <> 'producido' then
      new.empaquetado_at := null; new.empaquetado_por := null;
    end if;
  end if;
  return new;
end $$;

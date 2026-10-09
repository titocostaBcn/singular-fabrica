-- APLICADA el 9-oct-2026. Datos de Shopify por prenda para productos con etiqueta "sin vinilo".
alter table public.fab_lineas
  add column if not exists product_id bigint,
  add column if not exists variant_id bigint,
  add column if not exists sin_vinilo boolean not null default false,
  add column if not exists stock int;
